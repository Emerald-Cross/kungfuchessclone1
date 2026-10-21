'use strict';

/*
 * Tests the rules and the real server.js (join / seating / moves / cooldowns /
 * simultaneous inputs / king capture / rematch / reconnect) with no network
 * and no installed packages. Takes about 15 seconds because it waits out the
 * real 3 s countdown and real cooldowns.
 *
 *   node test/logic.js
 */

const assert = require('assert');
const path = require('path');
const Rules = require('../public/rules.js');

process.env.PORT = '0'; // server.js binds an ephemeral port; nothing connects to it
const fake = require('./fake-io').install();
require(path.join(__dirname, '..', 'server.js'));
const io = fake.state.io;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sq = (name) => (8 - Number(name[1])) * 8 + 'abcdefgh'.indexOf(name[0]);

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (err) {
    console.log('  FAIL ' + name + '\n' + (err && err.stack ? err.stack : err));
    process.exit(1);
  }
}

function player(token, name) {
  const c = io.connect();
  c.token = token;
  c.name = name;
  c.join = (opts) => c.request('join', Object.assign({ token, name }, opts));
  c.move = (from, to) => c.request('move', { from: sq(from), to: sq(to), ts: Date.now() });
  return c;
}

async function main() {
  console.log('Rules');

  await test('starting position has 32 pieces, 16 each', () => {
    const b = Rules.newBoard();
    assert.strictEqual(b.filter(Boolean).length, 32);
    assert.strictEqual(b.filter((p) => p && p.c === 'w').length, 16);
    assert.strictEqual(b[sq('e1')].t, 'k');
    assert.strictEqual(b[sq('d8')].t, 'q');
  });

  await test('pawn, knight and blocked rook moves', () => {
    const b = Rules.newBoard();
    assert.deepStrictEqual(Rules.targets(b, sq('e2')).sort((a, c) => a - c), [sq('e4'), sq('e3')].sort((a, c) => a - c));
    assert.deepStrictEqual(Rules.targets(b, sq('b1')).sort((a, c) => a - c), [sq('c3'), sq('a3')].sort((a, c) => a - c));
    assert.deepStrictEqual(Rules.targets(b, sq('a1')), []);
    assert.deepStrictEqual(Rules.targets(b, sq('d8')), []);
  });

  await test('sliders stop at blockers and capture enemies, not friends', () => {
    const b = new Array(64).fill(null);
    b[sq('d4')] = { t: 'r', c: 'w', r: 0 };
    b[sq('d6')] = { t: 'p', c: 'b', r: 0 };
    b[sq('b4')] = { t: 'p', c: 'w', r: 0 };
    const t = Rules.targets(b, sq('d4'));
    assert(t.includes(sq('d6')), 'captures enemy');
    assert(!t.includes(sq('d7')), 'cannot jump past it');
    assert(t.includes(sq('c4')) && !t.includes(sq('b4')), 'stops before friend');
  });

  await test('pawns capture diagonally only and promote to queens', () => {
    const b = new Array(64).fill(null);
    b[sq('a7')] = { t: 'p', c: 'w', r: 0 };
    b[sq('a8')] = { t: 'r', c: 'b', r: 0 };
    b[sq('b8')] = { t: 'n', c: 'b', r: 0 };
    const t = Rules.targets(b, sq('a7'));
    assert.deepStrictEqual(t, [sq('b8')]); // straight ahead is blocked; diagonal is a capture
    const res = Rules.apply(b, sq('a7'), sq('b8'), 1234);
    assert.strictEqual(res.promoted, true);
    assert.strictEqual(b[sq('b8')].t, 'q');
    assert.strictEqual(b[sq('b8')].r, 1234);
  });

  await test('check() reports the right reasons', () => {
    const b = Rules.newBoard();
    assert.strictEqual(Rules.check(b, sq('e2'), sq('e4'), 'w', 0), null);
    assert.strictEqual(Rules.check(b, sq('e3'), sq('e4'), 'w', 0), 'empty');
    assert.strictEqual(Rules.check(b, sq('e7'), sq('e5'), 'w', 0), 'notyours');
    assert.strictEqual(Rules.check(b, sq('a1'), sq('a3'), 'w', 0), 'illegal');
    b[sq('e2')].r = 5000;
    assert.strictEqual(Rules.check(b, sq('e2'), sq('e4'), 'w', 4000), 'cooldown');
    assert.strictEqual(Rules.check(b, sq('e2'), sq('e4'), 'w', 5000), null);
    assert.strictEqual(Rules.check(b, 99, 3, 'w', 0), 'bad');
    assert.strictEqual(Rules.check(b, 1.5, 3, 'w', 0), 'bad');
  });

  console.log('Server');

  const ann = player('token-ann-0001', 'Ann');
  const bob = player('token-bob-0002', 'Bob');
  const cat = player('token-cat-0003', 'Cat');
  let code;
  let startedAt;

  await test('creating a room seats the creator as white and waits', async () => {
    const res = await ann.join({ create: true, cooldownMs: 2000 });
    assert.strictEqual(res.ok, true);
    assert.match(res.code, /^[A-Z]{4}$/);
    assert.strictEqual(res.color, 'w');
    assert.strictEqual(res.state.status, 'waiting');
    assert.strictEqual(res.state.cooldownMs, 2000);
    code = res.code;
  });

  await test('joining an unknown room fails cleanly', async () => {
    const res = await cat.join({ code: 'ZZZZ' });
    assert.deepStrictEqual([res.ok, res.reason], [false, 'noroom']);
  });

  await test('second player gets black and the countdown starts for both', async () => {
    const res = await bob.join({ code });
    assert.strictEqual(res.color, 'b');
    await sleep(30);
    for (const c of [ann, bob]) {
      assert.strictEqual(c.state.status, 'playing');
      assert.strictEqual(c.state.players.w.name, 'Ann');
      assert.strictEqual(c.state.players.b.name, 'Bob');
    }
    startedAt = ann.state.startsAt;
    const wait = startedAt - Date.now();
    assert(wait > 2000 && wait <= 3000, 'countdown is ~3s, got ' + wait);
  });

  await test('a third person becomes a spectator and cannot move', async () => {
    const res = await cat.join({ code });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.color, null);
    const mv = await cat.move('e2', 'e4');
    assert.deepStrictEqual([mv.ok, mv.reason], [false, 'spectator']);
    await sleep(30);
    assert.strictEqual(ann.state.spectators, 1);
  });

  await test('moves during the countdown are rejected', async () => {
    const mv = await ann.move('e2', 'e4');
    assert.deepStrictEqual([mv.ok, mv.reason], [false, 'notstarted']);
  });

  await sleep(Math.max(0, startedAt - Date.now()) + 60);

  let firstTwo;
  await test('two moves sent in the same instant are both applied, in a definite order', async () => {
    // Ann: e2-e4, Bob: d7-d5, fired in the same tick.
    firstTwo = await Promise.all([ann.move('e2', 'e4'), bob.move('d7', 'd5')]);
    assert.strictEqual(firstTwo[0].ok, true);
    assert.strictEqual(firstTwo[1].ok, true);
    assert.notStrictEqual(firstTwo[0].n, firstTwo[1].n);
    assert(firstTwo[0].rel >= 0 && firstTwo[1].rel >= 0, 'rel is measured from game start');
    await sleep(30);
    const b = ann.state.board;
    assert.strictEqual(b[sq('e4')].t, 'p');
    assert.strictEqual(b[sq('d5')].c, 'b');
    assert.strictEqual(b[sq('e2')], null);
    assert.strictEqual(ann.state.moves.length, 2);
    assert.deepStrictEqual(ann.state, bob.state);
  });

  await test('server stamps a ready time on the moved piece', () => {
    const p = ann.state.board[sq('e4')];
    const left = p.r - ann.state.serverNow;
    assert(left > 1500 && left <= 2000, 'about one cooldown left, got ' + left);
  });

  await test('rejects: cooldown, blocked, enemy piece, empty square, junk', async () => {
    let r = await ann.move('e4', 'e5');
    assert.deepStrictEqual([r.ok, r.reason], [false, 'cooldown']);
    r = await ann.move('a1', 'a3');
    assert.deepStrictEqual([r.ok, r.reason], [false, 'illegal']);
    r = await ann.move('a7', 'a6');
    assert.deepStrictEqual([r.ok, r.reason], [false, 'notyours']);
    r = await ann.move('e3', 'e4');
    assert.deepStrictEqual([r.ok, r.reason], [false, 'empty']);
    r = await ann.request('move', { from: 'x', to: null });
    assert.deepStrictEqual([r.ok, r.reason], [false, 'bad']);
    r = await ann.request('move');
    assert.strictEqual(r.ok, false);
  });

  await sleep(2100); // let both pawns cool down

  await test('simultaneous mutual capture: exactly one wins the race', async () => {
    // Ann's e4 pawn and Bob's d5 pawn attack each other.
    const results = await Promise.all([ann.move('e4', 'd5'), bob.move('d5', 'e4')]);
    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    assert.strictEqual(winners.length, 1, 'one winner');
    assert.strictEqual(losers.length, 1, 'one loser');
    assert.strictEqual(losers[0].reason, 'notyours');
    await sleep(30);
    const pieces = ann.state.board.filter((p) => p && p.t === 'p');
    assert.strictEqual(pieces.length, 15, 'one pawn was captured');
    const last = ann.state.moves[ann.state.moves.length - 1];
    assert.strictEqual(last.cap, 'p');
  });

  await test('input log records every attempt with ordered server timestamps', async () => {
    const handler = fake.state.routes['/api/room/:code/log'];
    assert(handler, 'log route registered');
    let body;
    handler({ params: { code: code.toLowerCase() } }, { json: (x) => { body = x; }, status() { return this; } });
    assert.strictEqual(body.code, code);
    const results = body.inputs.map((i) => i.result);
    assert(results.includes('ok') && results.includes('notstarted') && results.includes('cooldown') && results.includes('spectator'));
    for (let i = 1; i < body.inputs.length; i++) {
      assert(body.inputs[i].n > body.inputs[i - 1].n, 'sequence numbers increase');
      assert(body.inputs[i].at >= body.inputs[i - 1].at, 'timestamps do not go backwards');
    }
    assert(body.inputs.every((i) => 'clientTs' in i && 'rel' in i && 'who' in i));
    let status = null;
    handler({ params: { code: 'NOPE' } }, { json() {}, status(s) { status = s; return this; } });
    assert.strictEqual(status, 404);
  });

  await test('a disconnected player keeps their seat and gets it back on return', async () => {
    bob.disconnect();
    await sleep(30);
    assert.strictEqual(ann.state.players.b.online, false);
    assert.strictEqual(ann.state.status, 'playing', 'game keeps running');
    const back = player('token-bob-0002', 'Bob');
    const res = await back.join({ code });
    assert.strictEqual(res.color, 'b');
    await sleep(30);
    assert.strictEqual(ann.state.players.b.online, true);
  });

  await test('name is cleaned and capped', async () => {
    const dodgy = player('token-dodgy-0009', '<img src=x onerror=1>Averyveryverylongname');
    const res = await dodgy.join({ create: true });
    assert.strictEqual(res.ok, true);
    const n = res.state.players.w.name;
    assert(n.length <= 16 && !/[<>]/.test(n), 'got ' + n);
    assert.strictEqual(res.state.cooldownMs, 4000, 'default cooldown');
    const bad = await dodgy.join({ create: true, cooldownMs: 1 });
    assert.strictEqual(bad.state.cooldownMs, 4000, 'unknown cooldown falls back to default');
    const none = player('x', 'Nope');
    const r = await none.join({ create: true });
    assert.deepStrictEqual([r.ok, r.reason], [false, 'badtoken']);
  });

  await test('leaving a waiting room frees the seat', async () => {
    const a = player('token-lv-a-0001', 'A');
    const { code: c2 } = await a.join({ create: true });
    a.emit('leave');
    await sleep(30);
    const b = player('token-lv-b-0002', 'B');
    const res = await b.join({ code: c2 });
    assert.strictEqual(res.color, 'w');
  });

  console.log('Full game');

  const wa = player('token-wa-0000001', 'White');
  const bl = player('token-bl-0000002', 'Black');
  let code2, start2;

  await test('white can walk a queen to the black king and win', async () => {
    const { code: c } = await wa.join({ create: true, cooldownMs: 2000 });
    code2 = c;
    await bl.join({ code: code2 });
    await sleep(30);
    start2 = wa.state.startsAt;
    await sleep(Math.max(0, start2 - Date.now()) + 60);

    for (const [f, t] of [['e2', 'e4'], ['f1', 'c4'], ['d1', 'h5']]) {
      const r = await wa.move(f, t);
      assert.strictEqual(r.ok, true, f + t + ' ' + r.reason);
    }
    await sleep(2100);
    let r = await wa.move('h5', 'f7');
    assert.strictEqual(r.ok, true, 'queen takes f7: ' + r.reason);
    await sleep(2100);
    r = await wa.move('f7', 'e8');
    assert.strictEqual(r.ok, true, 'queen takes king: ' + r.reason);
    await sleep(30);
    assert.strictEqual(wa.state.status, 'over');
    assert.strictEqual(wa.state.winner, 'w');
    assert.deepStrictEqual(bl.state, wa.state);
  });

  await test('nothing moves after the game is over', async () => {
    const r = await bl.move('a7', 'a6');
    assert.deepStrictEqual([r.ok, r.reason], [false, 'over']);
  });

  await test('rematch needs both players, then resets the board and restarts the countdown', async () => {
    wa.emit('rematch');
    await sleep(30);
    assert.strictEqual(wa.state.status, 'over');
    assert.strictEqual(wa.state.rematch.w, true);
    bl.emit('rematch');
    await sleep(30);
    assert.strictEqual(wa.state.status, 'playing');
    assert.strictEqual(wa.state.winner, null);
    assert.strictEqual(wa.state.board.filter(Boolean).length, 32);
    assert.strictEqual(wa.state.moves.length, 0);
    assert.deepStrictEqual(wa.state.rematch, { w: false, b: false });
    assert(wa.state.startsAt > Date.now() + 2000);
    const early = await wa.move('e2', 'e4');
    assert.strictEqual(early.reason, 'notstarted');
  });

  await test('flooding moves hits the rate limit', async () => {
    await sleep(Math.max(0, wa.state.startsAt - Date.now()) + 60);
    const burst = await Promise.all(Array.from({ length: 30 }, () => wa.move('e5', 'e6'))); // empty square: harmless
    const slow = burst.filter((r) => r.reason === 'slow').length;
    assert(slow >= 8, 'expected most of the burst to be limited, got ' + slow);
  });

  console.log('\n' + passed + ' checks passed');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
