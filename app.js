(function () {
  'use strict';

  var $ = function (sel) { return document.querySelector(sel); };
  var GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
  var TEXT_PRESENTATION = '︎'; // stop phones from drawing the pawn as an emoji
  var COLOR_NAME = { w: 'White', b: 'Black' };

  var REASONS = {
    cooldown: 'That piece is still cooling down',
    illegal: "That piece can't go there",
    empty: 'That piece already moved',
    notyours: 'Too slow — that piece was just captured',
    notstarted: 'Wait for the countdown',
    notplaying: "The game isn't running",
    over: 'The game is over',
    slow: 'Slow down!',
    spectator: "Spectators can't move",
    noroom: 'Room not found',
    bad: 'Invalid move'
  };

  /* ------------------------------------------------------------ storage */

  var mem = {};
  function getItem(store, k) {
    try { return window[store].getItem(k); } catch (e) { return mem[store + k] || null; }
  }
  function setItem(store, k, v) {
    try { window[store].setItem(k, v); } catch (e) { mem[store + k] = v; }
  }

  // The player token lives in sessionStorage so each browser tab is its own
  // player (two tabs on one computer = two players, handy for testing).
  var token = getItem('sessionStorage', 'kfc.token');
  if (!token) {
    var bytes = new Uint8Array(12);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    token = Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    setItem('sessionStorage', 'kfc.token', token);
  }

  /* -------------------------------------------------------------- state */

  var S = {
    code: null,      // room we are in (null = lobby)
    color: null,     // 'w' | 'b' | null (spectator)
    game: null,      // latest snapshot from the server
    selected: null,  // selected square index
    offset: 0,       // serverTime - localTime, ms
    rtt: null,
    samples: [],
    connectedOnce: false,
    wakeTimer: null
  };

  var socket = io();

  function serverNow() { return Date.now() + S.offset; }

  /* ----------------------------------------------------------- toast/ui */

  var toastTimer = null;
  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 1800);
  }

  function setConn(text, cls) {
    var el = $('#conn');
    el.textContent = text;
    el.className = 'pill ' + (cls || '');
  }

  function lobbyMsg(text) { $('#lobbyMsg').textContent = text || ''; }

  /* ---------------------------------------------------------- view mode */

  var mq = window.matchMedia ? window.matchMedia('(max-width: 760px)') : { matches: false };
  function applyView() {
    var override = getItem('localStorage', 'kfc.view');
    var v = override === 'compact' || override === 'full' ? override : (mq.matches ? 'compact' : 'full');
    document.body.dataset.view = v;
    $('#viewToggle').textContent = v === 'compact' ? 'Full view' : 'Compact view';
  }
  if (mq.addEventListener) mq.addEventListener('change', applyView);
  else if (mq.addListener) mq.addListener(applyView);
  $('#viewToggle').addEventListener('click', function () {
    var next = document.body.dataset.view === 'compact' ? 'full' : 'compact';
    setItem('localStorage', 'kfc.view', next);
    applyView();
  });
  $('#logToggle').addEventListener('click', function () {
    var open = document.body.classList.toggle('log-open');
    $('#logToggle').setAttribute('aria-expanded', String(open));
  });
  applyView();

  /* -------------------------------------------------------------- board */

  var cells = new Array(64);
  var builtFlipped = null;

  function buildBoard(flip) {
    var el = $('#board');
    el.textContent = '';
    for (var d = 0; d < 64; d++) {
      var i = flip ? 63 - d : d;
      var row = i >> 3, col = i & 7;
      var b = document.createElement('button');
      b.type = 'button';
      var base = 'sq ' + (((row + col) & 1) ? 'dark' : 'light');
      b.className = base;
      b.dataset.i = String(i);
      if (col === (flip ? 7 : 0)) b.dataset.rank = String(8 - row);
      if (row === (flip ? 0 : 7)) b.dataset.file = 'abcdefgh'[col];
      var pc = document.createElement('span'); pc.className = 'pc';
      var cd = document.createElement('span'); cd.className = 'cd';
      var mk = document.createElement('span'); mk.className = 'mk';
      b.appendChild(pc); b.appendChild(cd); b.appendChild(mk);
      el.appendChild(b);
      cells[i] = { el: b, pc: pc, cd: cd, base: base, cls: base, key: null, cdv: '0' };
    }
    builtFlipped = flip;
  }

  $('#board').addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('.sq') : null;
    if (b) onSquare(Number(b.dataset.i));
  });

  function onSquare(i) {
    var g = S.game;
    if (!g) return;
    if (!S.color) { toast("You're spectating"); return; }
    var now = serverNow();
    var p = g.board[i];

    if (S.selected === null) {
      if (p && p.c === S.color) {
        if (p.r > now) toast(REASONS.cooldown);
        else { S.selected = i; render(); }
      }
      return;
    }
    if (i === S.selected) { S.selected = null; render(); return; }
    if (p && p.c === S.color) {
      if (p.r > now) toast(REASONS.cooldown);
      else { S.selected = i; render(); }
      return;
    }
    if (Rules.targets(g.board, S.selected).indexOf(i) === -1) {
      toast(REASONS.illegal);
      return;
    }
    var from = S.selected;
    S.selected = null;
    socket.emit('move', { from: from, to: i, ts: Date.now() }, function (res) {
      if (res && !res.ok) toast(REASONS[res.reason] || 'Move rejected');
    });
    render();
  }

  function squareLabel(i, p) {
    var name = Rules.sqName(i);
    if (!p) return name;
    var kind = { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' }[p.t];
    return name + ', ' + COLOR_NAME[p.c].toLowerCase() + ' ' + kind;
  }

  function render() {
    var g = S.game;
    if (!g) return;
    var flip = S.color === 'b';
    if (builtFlipped !== flip) buildBoard(flip);

    var now = serverNow();
    if (S.selected !== null) {
      var sp = g.board[S.selected];
      if (!sp || sp.c !== S.color || sp.r > now || g.status !== 'playing') S.selected = null;
    }
    var legal = S.selected !== null ? Rules.targets(g.board, S.selected) : null;

    for (var i = 0; i < 64; i++) {
      var c = cells[i];
      var p = g.board[i];
      var cl = c.base;
      if (S.selected === i) cl += ' sel';
      if (g.lastMove && (g.lastMove.from === i || g.lastMove.to === i)) cl += ' last';
      if (legal && legal.indexOf(i) !== -1) cl += p ? ' cap' : ' tgt';
      if (c.cls !== cl) { c.el.className = cl; c.cls = cl; }
      var key = p ? p.c + p.t : '';
      if (c.key !== key) {
        c.pc.textContent = p ? GLYPH[p.t] + TEXT_PRESENTATION : '';
        c.pc.className = 'pc' + (p ? ' ' + p.c : '');
        c.el.setAttribute('aria-label', squareLabel(i, p));
        c.key = key;
      }
    }

    renderPlayers();
    renderStatus();
    renderLog();
    renderRoom();
    paint();
  }

  /* ------------------------------------------------------ side elements */

  function fillPlayer(el, color) {
    var g = S.game;
    var info = g.players[color];
    el.textContent = '';
    el.className = 'player' + (info ? '' : ' empty');
    var chip = document.createElement('span'); chip.className = 'chip ' + color;
    var nm = document.createElement('span'); nm.className = 'nm';
    nm.textContent = info ? info.name : 'Waiting for a player…';
    el.appendChild(chip);
    el.appendChild(nm);
    if (info && S.color === color) {
      var you = document.createElement('span'); you.className = 'you'; you.textContent = '(you)';
      el.appendChild(you);
    }
    if (info) {
      var dot = document.createElement('span');
      dot.className = 'dot' + (info.online ? '' : ' off');
      dot.title = info.online ? 'online' : 'disconnected';
      el.appendChild(dot);
    }
  }

  function renderPlayers() {
    var bottom = S.color || 'w';
    var top = bottom === 'w' ? 'b' : 'w';
    fillPlayer($('#playerTop'), top);
    fillPlayer($('#playerBottom'), bottom);
  }

  function renderStatus() {
    var g = S.game, text;
    if (g.status === 'waiting') text = 'Waiting for an opponent — share the room code';
    else if (g.status === 'over') text = 'Game over';
    else if (serverNow() < g.startsAt) text = 'Get ready…';
    else if (!S.color) text = 'Spectating' + (g.spectators > 1 ? ' (' + g.spectators + ' watching)' : '');
    else text = 'Fight!';
    var el = $('#statusText');
    if (el.textContent !== text) el.textContent = text;
  }

  var lastLogKey = '';
  function renderLog() {
    var g = S.game;
    var key = g.code + ':' + g.moves.length + ':' + (g.moves.length ? g.moves[g.moves.length - 1].n : 0);
    if (key === lastLogKey) return;
    lastLogKey = key;
    var ol = $('#log');
    ol.textContent = '';
    $('#logEmpty').hidden = g.moves.length > 0;
    for (var k = g.moves.length - 1; k >= 0; k--) {
      var m = g.moves[k];
      var li = document.createElement('li');
      li.className = m.c;
      var t = document.createElement('span'); t.className = 't';
      t.textContent = (m.rel / 1000).toFixed(3) + 's';
      var mv = document.createElement('span'); mv.className = 'm';
      var glyph = document.createElement('span'); glyph.className = 'g';
      glyph.textContent = GLYPH[m.t] + TEXT_PRESENTATION;
      mv.appendChild(glyph);
      var txt = ' ' + Rules.sqName(m.from) + (m.cap ? ' x ' : ' → ') + Rules.sqName(m.to);
      mv.appendChild(document.createTextNode(txt));
      if (m.cap) {
        var cg = document.createElement('span'); cg.className = 'g';
        cg.textContent = ' ' + GLYPH[m.cap] + TEXT_PRESENTATION;
        mv.appendChild(cg);
      }
      if (m.promo) mv.appendChild(document.createTextNode(' =Q'));
      li.appendChild(t); li.appendChild(mv);
      ol.appendChild(li);
    }
  }

  function inviteUrl() {
    return location.origin + location.pathname + '?room=' + S.code;
  }

  function renderRoom() {
    var g = S.game;
    $('#roomCode').textContent = g.code;
    $('#cooldownInfo').textContent = 'Cooldown ' + (g.cooldownMs / 1000) + ' s';
    var inv = $('#inviteLink');
    var url = inviteUrl();
    if (inv.value !== url) inv.value = url;
  }

  function renderNet() {
    var el = $('#netInfo');
    if (S.rtt === null) { el.textContent = ''; return; }
    var off = Math.round(S.offset);
    el.textContent = '';
    var lines = [
      'Ping: ' + Math.round(S.rtt) + ' ms',
      'Clock offset vs server: ' + (off >= 0 ? '+' : '') + off + ' ms',
      'Every move is timestamped by the server when it arrives, so ties are settled by arrival order, not by anyone’s clock.'
    ];
    lines.forEach(function (ln) {
      var d = document.createElement('div'); d.textContent = ln; el.appendChild(d);
    });
    if (S.code) setConn('connected · ' + Math.round(S.rtt) + ' ms', 'ok');
  }

  /* ----------------------------------------------- animation (per frame) */

  var bannerKey = '';
  function setBanner(text, sub, showRematch) {
    var mine = !!(showRematch && S.game.rematch && S.game.rematch[S.color]);
    var key = text + '|' + sub + '|' + showRematch + '|' + mine;
    if (key === bannerKey) return;
    bannerKey = key;
    var b = $('#banner');
    if (!text) { b.hidden = true; return; }
    b.hidden = false;
    $('#bannerText').textContent = text;
    $('#bannerSub').textContent = sub || '';
    var rb = $('#rematchBtn');
    rb.hidden = !showRematch;
    if (showRematch) {
      rb.textContent = mine ? 'Waiting for opponent…' : 'Rematch';
      rb.disabled = mine;
    }
  }

  // Runs every frame: drains the cooldown veils and updates the countdown/banner.
  function paint() {
    var g = S.game;
    if (g && S.code) {
      var now = serverNow();
      for (var i = 0; i < 64; i++) {
        var c = cells[i];
        if (!c) continue;
        var p = g.board[i];
        var v = p && p.r > now ? Math.min(1, (p.r - now) / g.cooldownMs) : 0;
        var s = v > 0 ? v.toFixed(3) : '0';
        if (c.cdv !== s) { c.cd.style.transform = 'scaleY(' + s + ')'; c.cdv = s; }
      }
      if (g.status === 'over') {
        var text = !S.color ? COLOR_NAME[g.winner] + ' wins'
          : g.winner === S.color ? 'You win!' : 'You lose';
        setBanner(text, COLOR_NAME[g.winner] + ' captured the king', !!S.color);
      } else if (g.status === 'playing' && now < g.startsAt) {
        setBanner(String(Math.ceil((g.startsAt - now) / 1000)), 'Get ready', false);
      } else if (g.status === 'playing' && now < g.startsAt + 800) {
        setBanner('GO!', '', false);
      } else {
        setBanner('', '', false);
      }
      renderStatus();
    }
  }

  function loop() {
    paint();
    requestAnimationFrame(loop);
  }

  /* ------------------------------------------------------- clock sync */

  function doSync() {
    var t0 = performance.now();
    socket.emit('sync', 0, function (serverMs) {
      var rtt = performance.now() - t0;
      S.rtt = rtt;
      S.samples.push({ rtt: rtt, off: serverMs + rtt / 2 - Date.now() });
      if (S.samples.length > 8) S.samples.shift();
      // The sample with the shortest round trip is the most trustworthy.
      var best = S.samples.reduce(function (a, b) { return b.rtt < a.rtt ? b : a; });
      S.offset = best.off;
      renderNet();
    });
  }
  setInterval(function () { if (socket.connected) doSync(); }, 8000);

  /* ------------------------------------------------------------- joining */

  function playerName() {
    var n = ($('#name').value || '').trim().slice(0, 16) || 'Player';
    setItem('localStorage', 'kfc.name', n);
    return n;
  }

  function showLobby(message) {
    S.code = null; S.color = null; S.game = null; S.selected = null;
    lastLogKey = '';
    $('#game').hidden = true;
    $('#lobby').hidden = false;
    lobbyMsg(message || '');
    try { history.replaceState(null, '', location.pathname); } catch (e) { /* ignore */ }
    setConn(socket.connected ? 'connected' : 'connecting…', socket.connected ? 'ok' : '');
  }

  function showGame() {
    $('#lobby').hidden = true;
    $('#game').hidden = false;
    try { history.replaceState(null, '', '?room=' + S.code); } catch (e) { /* ignore */ }
  }

  function join(opts) {
    var payload = {
      token: token,
      name: playerName(),
      create: !!opts.create,
      code: opts.code || '',
      cooldownMs: Number($('#cooldown').value)
    };
    lobbyMsg(socket.connected ? 'Joining…' : 'Waking up the server (free hosting can take up to a minute)…');
    socket.emit('join', payload, function (res) {
      if (!res || !res.ok) {
        var why = {
          noroom: 'No room with that code. (Rooms disappear if the server restarts.)',
          busy: 'The server is full right now. Try again in a bit.',
          badtoken: 'Something went wrong. Reload the page and try again.'
        }[res && res.reason] || 'Could not join.';
        showLobby(why);
        return;
      }
      S.code = res.code;
      S.color = res.color;
      S.game = res.state;
      S.selected = null;
      showGame();
      if (res.state && res.state.serverNow && S.rtt === null) S.offset = res.state.serverNow - Date.now();
      render();
      if (!S.color) toast('Room is full — you are spectating');
    });
  }

  $('#createBtn').addEventListener('click', function () { join({ create: true }); });
  $('#joinBtn').addEventListener('click', function () {
    var code = ($('#code').value || '').trim().toUpperCase();
    if (code.length !== 4) { lobbyMsg('Enter the 4-letter room code.'); return; }
    join({ code: code });
  });
  $('#code').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('#joinBtn').click(); });
  $('#code').addEventListener('input', function (e) {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '');
  });

  $('#leaveBtn').addEventListener('click', function () {
    socket.emit('leave');
    showLobby('');
  });
  $('#rematchBtn').addEventListener('click', function () { socket.emit('rematch'); });
  $('#copyLink').addEventListener('click', function () {
    var inv = $('#inviteLink');
    function fallback() { inv.select(); toast('Press Ctrl+C to copy'); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(inv.value).then(function () { toast('Link copied'); }, fallback);
    } else fallback();
  });
  $('#inviteLink').addEventListener('focus', function (e) { e.target.select(); });

  /* ------------------------------------------------------------- socket */

  socket.on('state', function (st) {
    if (!S.code || st.code !== S.code) return;
    S.game = st;
    render();
  });

  socket.on('connect', function () {
    clearTimeout(S.wakeTimer);
    S.samples = [];
    S.connectedOnce = true;
    setConn('connected', 'ok');
    for (var k = 0; k < 4; k++) setTimeout(doSync, k * 180);
    if (S.code) {
      // Reconnected mid-game: take our seat back.
      socket.emit('join', { token: token, name: playerName(), code: S.code }, function (res) {
        if (!res || !res.ok) { showLobby('That room no longer exists (the server may have restarted).'); return; }
        S.color = res.color;
        S.game = res.state;
        render();
      });
    }
  });
  socket.on('disconnect', function () { setConn('reconnecting…', 'warn'); });
  socket.on('connect_error', function () { setConn('can’t reach server', 'bad'); });
  S.wakeTimer = setTimeout(function () {
    if (!socket.connected) setConn('waking server… (up to a minute)', 'warn');
  }, 4000);

  /* -------------------------------------------------------------- start */

  var savedName = getItem('localStorage', 'kfc.name');
  if (savedName) $('#name').value = savedName;
  var wanted = (new URLSearchParams(location.search).get('room') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  if (wanted) {
    $('#code').value = wanted;
    lobbyMsg('Enter your name and press Join to enter room ' + wanted + '.');
  }
  loop(); // animation loop; does nothing until a game is on screen
})();
