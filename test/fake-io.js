'use strict';

/*
 * In-memory stand-ins for `express` and `socket.io`, so the real server.js can
 * be driven without a network or installed packages. Messages are JSON-cloned
 * and delivered asynchronously (setImmediate), like a real connection would.
 *
 *   const fake = require('./fake-io').install();
 *   require('../server.js');            // server.js gets the stand-ins
 *   const client = fake.state.io.connect();
 *   const ack = await client.request('join', { ... });
 */

const Module = require('module');

const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
let nextId = 1;

class ServerSocket {
  constructor(io, client) {
    this.io = io;
    this.client = client;
    this.id = 'sock' + nextId++;
    this.data = {};
    this.handlers = {};
    io._sockets.set(this.id, this);
  }
  on(ev, fn) { this.handlers[ev] = fn; return this; }
  join(room) {
    const rooms = this.io.sockets.adapter.rooms;
    if (!rooms.has(room)) rooms.set(room, new Set());
    rooms.get(room).add(this.id);
  }
  leave(room) {
    const rooms = this.io.sockets.adapter.rooms;
    const set = rooms.get(room);
    if (!set) return;
    set.delete(this.id);
    if (!set.size) rooms.delete(room);
  }
  emit(ev, payload) {
    const p = clone(payload);
    setImmediate(() => this.client._receive(ev, p));
  }
}

class TestClient {
  constructor() {
    this.listeners = {};
    this.state = null; // latest 'state' event
    this.connected = true;
    this.any = null; // optional hook: (event, payload) for every server message
  }
  on(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  _receive(ev, p) {
    if (!this.connected) return;
    if (ev === 'state') this.state = p;
    if (this.any) this.any(ev, p);
    (this.listeners[ev] || []).forEach((fn) => fn(p));
  }
  emit(ev, payload, ack) {
    setImmediate(() => {
      if (!this.connected) return;
      const handler = this._sock.handlers[ev];
      if (!handler) return;
      const cb = ack ? (res) => { const r = clone(res); setImmediate(() => ack(r)); } : undefined;
      handler(clone(payload), cb);
    });
  }
  request(ev, payload) {
    return new Promise((resolve) => this.emit(ev, payload, resolve));
  }
  disconnect() {
    if (!this.connected) return;
    const handler = this._sock.handlers.disconnect;
    if (handler) handler();
    this.connected = false;
    for (const set of this._sock.io.sockets.adapter.rooms.values()) set.delete(this._sock.id);
  }
}

class FakeServer {
  constructor() {
    this.sockets = { adapter: { rooms: new Map() } };
    this._sockets = new Map();
    this._onConnection = null;
  }
  on(ev, fn) { if (ev === 'connection') this._onConnection = fn; return this; }
  to(room) {
    return {
      emit: (ev, payload) => {
        const ids = this.sockets.adapter.rooms.get(room);
        if (!ids) return;
        for (const id of ids) this._sockets.get(id).emit(ev, payload);
      },
    };
  }
  connect() {
    const client = new TestClient();
    client._sock = new ServerSocket(this, client);
    this._onConnection(client._sock);
    return client;
  }
}

function install() {
  const state = { io: null, routes: {} };
  const originalLoad = Module._load;

  function express() {
    const app = function () {};
    app.disable = function () {};
    app.get = function (route, handler) { state.routes[route] = handler; };
    app.use = function () {};
    return app;
  }
  express.static = function () { return function () {}; };

  class Server extends FakeServer {
    constructor() { super(); state.io = this; }
  }

  Module._load = function (request) {
    if (request === 'express') return express;
    if (request === 'socket.io') return { Server };
    return originalLoad.apply(this, arguments);
  };
  return { state, restore() { Module._load = originalLoad; } };
}

module.exports = { install };
