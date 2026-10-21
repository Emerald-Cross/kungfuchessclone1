'use strict';

/*
 * Kung-fu chess server. Express serves the static client; Socket.IO carries
 * the game. The server is authoritative: it validates every move, applies
 * cooldowns, and stamps each input with the time it was handled. Node handles
 * one event at a time, so two "simultaneous" moves always get a definite order.
 */

const crypto = require('crypto');
const http = require('http');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');
const Rules = require('./public/rules.js');

const PORT = process.env.PORT || 3000;
const COOLDOWNS = [2000, 4000, 6000, 10000]; // allowed cooldowns (ms)
const DEFAULT_COOLDOWN = 4000;
const COUNTDOWN_MS = 3000;
const ROOM_TTL_MS = 3 * 60 * 60 * 1000; // drop empty rooms after 3 hours
const SEAT_TAKEOVER_MS = 15000; // an abandoned seat can be claimed after this
const MAX_ROOMS = 100;
const MAX_INPUT_LOG = 1000;
const MAX_MOVES_KEPT = 200;
const MOVES_IN_SNAPSHOT = 40;
const MAX_INPUTS_PER_SECOND = 20;
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

const rooms = new Map();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 10000, pingTimeout: 25000 });

app.disable('x-powered-by');
app.get('/healthz', (_req, res) => res.type('text').send('ok'));

// Full input log for a room: every move attempt, accepted or rejected, with
// the server timestamp. Handy for settling "who clicked first" arguments.
app.get('/api/room/:code/log', (req, res) => {
  const room = rooms.get(String(req.params.code).toUpperCase());
  if (!room) return res.status(404).json({ error: 'no such room' });
  res.json({
    code: room.code,
    cooldownMs: room.cooldownMs,
    status: room.status,
    gameStartedAtEpochMs: room.startsAt,
    note: 'rel = ms since the countdown ended, measured by the server when it handled the input',
    inputs: room.inputs,
  });
});

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------- rooms

function newCode() {
  for (;;) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_LETTERS[crypto.randomInt(CODE_LETTERS.length)];
    if (!rooms.has(code)) return code;
  }
}

function makeRoom(code, cooldownMs) {
  const room = {
    code,
    cooldownMs,
    seats: { w: null, b: null }, // { token, name, socketId, offlineSince }
    spectators: new Set(),
    lastActive: Date.now(),
  };
  resetGame(room);
  room.status = 'waiting';
  return room;
}

function resetGame(room) {
  room.board = Rules.newBoard();
  room.status = 'playing';
  room.winner = null;
  room.moves = [];
  room.inputs = [];
  room.inputSeq = 0;
  room.lastMove = null;
  room.rematch = { w: false, b: false };
  room.startsAt = Date.now() + COUNTDOWN_MS;
  room.t0 = process.hrtime.bigint() + BigInt(COUNTDOWN_MS) * 1000000n;
}

function maybeStart(room) {
  if (room.status === 'waiting' && room.seats.w && room.seats.b) resetGame(room);
}

function snapshot(room) {
  const seat = (c) =>
    room.seats[c] ? { name: room.seats[c].name, online: room.seats[c].socketId !== null } : null;
  return {
    code: room.code,
    cooldownMs: room.cooldownMs,
    board: room.board,
    status: room.status,
    startsAt: room.startsAt,
    winner: room.winner,
    players: { w: seat('w'), b: seat('b') },
    spectators: room.spectators.size,
    rematch: room.rematch,
    lastMove: room.lastMove,
    moves: room.moves.slice(-MOVES_IN_SNAPSHOT),
    serverNow: Date.now(),
  };
}

function broadcast(room) {
  io.to(room.code).emit('state', snapshot(room));
}

function cleanName(raw) {
  const s = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16) : '';
  return s || 'Player';
}

/** Remove a socket from whatever room it is in. */
function detach(socket, deliberate) {
  const room = rooms.get(socket.data.code);
  const color = socket.data.color;
  socket.data.code = null;
  socket.data.color = null;
  if (!room) return;
  socket.leave(room.code);
  room.spectators.delete(socket.id);
  const seat = color && room.seats[color];
  if (seat && seat.socketId === socket.id) {
    if (deliberate && room.status !== 'playing') {
      room.seats[color] = null;
      room.rematch[color] = false;
    } else {
      seat.socketId = null;
      seat.offlineSince = Date.now();
    }
  }
  room.lastActive = Date.now();
  broadcast(room);
}

// ---------------------------------------------------------------- sockets

io.on('connection', (socket) => {
  socket.data.code = null;
  socket.data.color = null;
  socket.data.stamps = [];

  // Clock sync: the client measures round trip and works out the offset.
  socket.on('sync', (_x, ack) => {
    if (typeof ack === 'function') ack(Date.now());
  });

  socket.on('join', (msg, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    msg = msg && typeof msg === 'object' ? msg : {};
    const token = typeof msg.token === 'string' ? msg.token.slice(0, 64) : '';
    if (token.length < 8) return ack({ ok: false, reason: 'badtoken' });
    const name = cleanName(msg.name);

    let room;
    if (msg.create) {
      if (rooms.size >= MAX_ROOMS) return ack({ ok: false, reason: 'busy' });
      const cooldown = COOLDOWNS.includes(msg.cooldownMs) ? msg.cooldownMs : DEFAULT_COOLDOWN;
      room = makeRoom(newCode(), cooldown);
      rooms.set(room.code, room);
    } else {
      room = rooms.get(String(msg.code || '').toUpperCase().slice(0, 4));
      if (!room) return ack({ ok: false, reason: 'noroom' });
    }

    detach(socket, false);

    // Seat: returning player (same token), free seat, abandoned seat, or spectator.
    let color = ['w', 'b'].find((c) => room.seats[c] && room.seats[c].token === token) || null;
    if (color) {
      Object.assign(room.seats[color], { name, socketId: socket.id, offlineSince: null });
    } else {
      color = ['w', 'b'].find((c) => !room.seats[c]) || null;
      if (!color) {
        const stale = Date.now() - SEAT_TAKEOVER_MS;
        color =
          ['w', 'b'].find((c) => {
            const s = room.seats[c];
            return s.socketId === null && s.offlineSince && s.offlineSince < stale;
          }) || null;
      }
      if (color) room.seats[color] = { token, name, socketId: socket.id, offlineSince: null };
    }
    if (!color) room.spectators.add(socket.id);

    socket.data.code = room.code;
    socket.data.color = color;
    socket.join(room.code);
    room.lastActive = Date.now();
    maybeStart(room);

    ack({ ok: true, code: room.code, color, state: snapshot(room) });
    broadcast(room);
  });

  socket.on('leave', () => detach(socket, true));
  socket.on('disconnect', () => detach(socket, false));

  socket.on('rematch', () => {
    const room = rooms.get(socket.data.code);
    const color = socket.data.color;
    if (!room || !color || room.status !== 'over') return;
    room.rematch[color] = true;
    if (room.seats.w && room.seats.b && room.rematch.w && room.rematch.b) resetGame(room);
    broadcast(room);
  });

  socket.on('move', (msg, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    const at = Date.now();
    const room = rooms.get(socket.data.code);
    if (!room) return ack({ ok: false, reason: 'noroom' });

    const rel = Math.round((Number(process.hrtime.bigint() - room.t0) / 1e6) * 1000) / 1000;
    const color = socket.data.color;
    const from = msg && msg.from;
    const to = msg && msg.to;
    const n = ++room.inputSeq;

    // Simple per-socket rate limit.
    const stamps = socket.data.stamps;
    while (stamps.length && at - stamps[0] > 1000) stamps.shift();
    stamps.push(at);

    let reason = null;
    if (!color) reason = 'spectator';
    else if (stamps.length > MAX_INPUTS_PER_SECOND) reason = 'slow';
    else if (room.status === 'over') reason = 'over';
    else if (room.status !== 'playing') reason = 'notplaying';
    else if (at < room.startsAt) reason = 'notstarted';
    else reason = Rules.check(room.board, from, to, color, at);

    const entry = {
      n,
      at,
      rel,
      who: color || 'spectator',
      from: Rules.isSquare(from) ? Rules.sqName(from) : null,
      to: Rules.isSquare(to) ? Rules.sqName(to) : null,
      clientTs: msg && Number.isFinite(msg.ts) ? msg.ts : null,
      result: reason || 'ok',
    };
    room.inputs.push(entry);
    if (room.inputs.length > MAX_INPUT_LOG) room.inputs.shift();
    room.lastActive = at;

    if (reason) return ack({ ok: false, reason, n, rel });

    const piece = room.board[from];
    const { captured, promoted } = Rules.apply(room.board, from, to, at + room.cooldownMs);
    room.moves.push({
      n,
      c: color,
      t: piece.t,
      from,
      to,
      cap: captured ? captured.t : null,
      promo: promoted,
      rel,
    });
    if (room.moves.length > MAX_MOVES_KEPT) room.moves.shift();
    room.lastMove = { from, to };
    if (captured && captured.t === 'k') {
      room.status = 'over';
      room.winner = color;
    }

    ack({ ok: true, n, rel });
    broadcast(room);
  });
});

// Forget rooms nobody has touched for a while.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const sockets = io.sockets.adapter.rooms.get(code);
    if ((!sockets || sockets.size === 0) && now - room.lastActive > ROOM_TTL_MS) rooms.delete(code);
  }
}, 10 * 60 * 1000).unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log('Kung-fu chess listening on port ' + PORT);
});
