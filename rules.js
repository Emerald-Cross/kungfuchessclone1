/*
 * Kung-fu chess rules. One file, used by both the server (authoritative) and
 * the browser (only to highlight legal squares).
 *
 * Board: array of 64. Index = row * 8 + col, row 0 is rank 8 (black's back
 * rank), col 0 is file a. A square is null or { t, c, r }:
 *   t = 'k' | 'q' | 'r' | 'b' | 'n' | 'p'
 *   c = 'w' | 'b'
 *   r = server time (ms since epoch) when the piece may move again; 0 = ready
 *
 * Simplifications versus normal chess: no turns, no check or checkmate (you
 * win by capturing the king), no castling, no en passant, pawns promote to
 * queens.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Rules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var BACK = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];
  var KNIGHT = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];
  var KING = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  var ORTHO = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  var DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

  function newBoard() {
    var b = new Array(64).fill(null);
    for (var c = 0; c < 8; c++) {
      b[c] = { t: BACK[c], c: 'b', r: 0 };
      b[8 + c] = { t: 'p', c: 'b', r: 0 };
      b[48 + c] = { t: 'p', c: 'w', r: 0 };
      b[56 + c] = { t: BACK[c], c: 'w', r: 0 };
    }
    return b;
  }

  function isSquare(i) {
    return Number.isInteger(i) && i >= 0 && i < 64;
  }

  function sqName(i) {
    return 'abcdefgh'[i & 7] + (8 - (i >> 3));
  }

  /** Every square the piece on `from` could move to right now (ignores cooldown). */
  function targets(board, from) {
    var p = board[from];
    if (!p) return [];
    var row = from >> 3;
    var col = from & 7;
    var out = [];

    function inBounds(r, c) {
      return r >= 0 && r < 8 && c >= 0 && c < 8;
    }
    // Adds the square if it is empty or holds an enemy. Returns true when a
    // sliding piece may keep going past it (the square was empty).
    function add(r, c) {
      if (!inBounds(r, c)) return false;
      var q = board[r * 8 + c];
      if (q && q.c === p.c) return false;
      out.push(r * 8 + c);
      return !q;
    }

    if (p.t === 'p') {
      var dir = p.c === 'w' ? -1 : 1;
      var startRow = p.c === 'w' ? 6 : 1;
      var r1 = row + dir;
      if (r1 >= 0 && r1 < 8) {
        if (!board[r1 * 8 + col]) {
          out.push(r1 * 8 + col);
          var r2 = row + 2 * dir;
          if (row === startRow && !board[r2 * 8 + col]) out.push(r2 * 8 + col);
        }
        [-1, 1].forEach(function (dc) {
          var c2 = col + dc;
          if (c2 < 0 || c2 > 7) return;
          var q = board[r1 * 8 + c2];
          if (q && q.c !== p.c) out.push(r1 * 8 + c2);
        });
      }
      return out;
    }

    if (p.t === 'n' || p.t === 'k') {
      (p.t === 'n' ? KNIGHT : KING).forEach(function (d) {
        add(row + d[0], col + d[1]);
      });
      return out;
    }

    var dirs = p.t === 'r' ? ORTHO : p.t === 'b' ? DIAG : ORTHO.concat(DIAG);
    dirs.forEach(function (d) {
      for (var k = 1; k < 8; k++) {
        if (!add(row + d[0] * k, col + d[1] * k)) break;
      }
    });
    return out;
  }

  /**
   * Returns null if the move is allowed, otherwise a reason string:
   * 'bad' | 'empty' | 'notyours' | 'cooldown' | 'illegal'
   */
  function check(board, from, to, color, now) {
    if (!isSquare(from) || !isSquare(to)) return 'bad';
    var p = board[from];
    if (!p) return 'empty';
    if (p.c !== color) return 'notyours';
    if (p.r > now) return 'cooldown';
    if (targets(board, from).indexOf(to) === -1) return 'illegal';
    return null;
  }

  /** Performs a move that has already passed check(). Mutates the board. */
  function apply(board, from, to, readyAt) {
    var p = board[from];
    var captured = board[to];
    var lastRow = p.c === 'w' ? 0 : 7;
    var promoted = p.t === 'p' && (to >> 3) === lastRow;
    board[to] = { t: promoted ? 'q' : p.t, c: p.c, r: readyAt };
    board[from] = null;
    return { captured: captured, promoted: promoted };
  }

  return {
    newBoard: newBoard,
    isSquare: isSquare,
    sqName: sqName,
    targets: targets,
    check: check,
    apply: apply,
  };
});
