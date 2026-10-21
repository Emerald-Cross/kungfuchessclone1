# Kung-Fu Chess

Real-time chess for a few friends: no turns. Move any piece whenever you like, but a piece that has just moved has to cool down before it can move again. Capture the enemy king to win.

- Works in any modern browser. The page has a full desktop layout and a compact phone layout (picked automatically by screen width; the button in the header switches between them).
- One server, one game room per 4-letter code. Anyone beyond the first two players in a room spectates.
- The server is the referee: it checks every move, applies the cooldowns, and stamps each move with the time it arrived.

Rules: pieces move as in chess and arrive instantly. No check or checkmate, no castling, no en passant. Pawns promote to queens. Cooldown (2 / 4 / 6 / 10 s) is chosen when the room is created.

## Run it on your own computer

Needs Node 18 or newer.

    npm install
    npm start

Open http://localhost:3000 in two browser tabs. Each tab is its own player, so you can try it alone.

## Put it online with Render (nothing to install on your work PC)

1. Make a GitHub repository and upload the files in this folder (drag them in on github.com, via "Add file", "Upload files"). Leave out `node_modules` if you have one.
2. On render.com choose New, then Web Service, and connect the repository.
   - Runtime: Node
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: Free

   (Or choose New, then Blueprint, and Render reads `render.yaml` for you.)
3. When the deploy finishes, Render shows a URL like `https://something.onrender.com`. Open it, create a room, and send friends the invite link.

Things to know about Render's free plan:

- After 15 minutes without traffic the service sleeps. The next visit takes up to about a minute to wake it, and the page says so while it waits.
- Games live in the server's memory. If the service restarts or you redeploy, open rooms disappear (the page tells players when that happens).
- If a connection drops, the page reconnects by itself and takes the player's seat back.
- A tab keeps its seat only while that tab stays open. If someone closes their tab mid-game, another visitor can take the empty seat after about 15 seconds.

## On a work network

Players only need to reach the site over normal HTTPS. The game uses WebSockets and falls back to plain HTTP long-polling if a proxy blocks them, so it should work either way. If the page does not load at all, the network may be blocking the onrender.com address; try a phone hotspot to confirm.

## Timestamps and simultaneous moves

Node handles one message at a time, so two moves that arrive "together" still get a definite order: the first one is applied, and the second is checked against the board as the first left it (this is how a simultaneous capture ends up with exactly one winner).

Every move attempt, accepted or rejected, is logged with the server's arrival time. While a room exists you can read the log at `/api/room/CODE/log` (for example `https://your-app.onrender.com/api/room/ABCD/log`). The `rel` field is milliseconds since the countdown ended. The server cannot know the instant someone actually clicked, only when their message arrived, so anyone on a slower connection is at a small disadvantage. Each message also carries the client's own clock reading (`clientTs`) for reference, but nothing relies on it.

## Files

    server.js          game server (Express + Socket.IO)
    public/rules.js    movement rules, shared by server and browser
    public/index.html  page
    public/style.css   styles, including the two layouts
    public/app.js      browser client
    render.yaml        optional Render blueprint
    test/logic.js      tests for the rules and the server (no network needed)
    test/fake-io.js    in-memory stand-ins used by the tests

`npm test` runs the tests. It takes about 15 seconds because it waits out the real countdown and cooldowns.

To change the cooldown choices, the 3-second countdown, or the room limits, edit the constants at the top of `server.js`.
