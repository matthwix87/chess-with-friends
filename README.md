# Rookery

A small, static chess site for playing with friends: online over a peer-to-peer
connection, pass-and-play on one device, or against a built-in computer opponent.
It is plain HTML/CSS/JavaScript (ES modules) with no build step, so it runs on
GitHub Pages.

**Play:** https://matthwix87.github.io/chess-with-friends/

> Rookery is an independent hobby project. It is not affiliated with, endorsed by,
> or connected to chess.com or any other chess website.

## Playing with a friend

1. Open the site, pick **Play a friend**, choose a time control and your color.
2. Click **Play a friend** and send the invite link (it looks like `...?room=abc123xyz9`).
3. When your friend opens the link and clicks **Join game**, the game starts.

Moves travel directly between the two browsers over WebRTC. The free PeerJS
broker (`0.peerjs.com`) is used only to introduce the two browsers to each other.
If either player reloads or drops for a moment, the guest reconnects automatically
and the host sends the full game state again. The host's browser keeps the
official clocks.

## Features

- Full rules from [chess.js](https://github.com/jhlywa/chess.js): castling, en passant,
  promotion (with a picker), check, checkmate, stalemate, threefold repetition,
  the 50-move rule and insufficient material. A flag against a lone king (or king plus one minor piece) is scored as a draw.
- Click-to-move and drag-and-drop (mouse and touch), legal-move dots, last-move and
  check highlights, flip board, coordinates, a layout that works on phones.
- Move list (SAN) with review (click a move or use the arrow keys), captured pieces and
  material balance, clocks: 1+0, 3+0, 5+0, 10+0, 10+5, unlimited.
- Resign, draw offers (online), rematch with colors swapped.
- Computer opponent (Easy / Medium / Hard / Expert): alpha-beta search in a Web Worker.
- Sounds synthesized with WebAudio (no audio files), light/dark theme, four board
  palettes. Settings are saved in localStorage.

## Running locally

Any static file server works, for example `python -m http.server` or `npx serve`.
On Windows without either, this works too:

```powershell
powershell -ExecutionPolicy Bypass -File tests\serve.ps1   # http://localhost:8765/
```

Opening `index.html` straight from disk (`file://`) will not work, because browsers
block ES modules and Web Workers there.

## Tests

With the server above running, open these pages in a browser (or run
`bash tests/run-headless.sh <page> <suite>`, which uses headless Firefox):

- `tests/rules.html`: rules, clocks, snapshots and engine (`rules`)
- `tests/ui.html`: drives the real UI with pointer events, desktop and phone width (`ui`)
- `tests/online.html`: host and guest in two iframes over the real PeerJS broker (`online`)

## Known limitations

- Online play depends on the free public PeerJS broker. If it is down or slow, rooms
  cannot be created or joined (games already connected keep working).
- Only public STUN is configured, no TURN relay. Players behind strict/symmetric NATs
  (some mobile carriers, corporate networks) may be unable to connect.
- The guest's clock includes network latency, because the host measures time.
- There are no accounts, ratings, chat or spectators, and finished games are not saved.
- The engine is a simple searcher (roughly club-beginner strength on Expert). It is not Stockfish.

## Credits and licenses

- Rookery code: MIT (see `LICENSE`).
- [chess.js](https://github.com/jhlywa/chess.js) 1.4.0, BSD-2-Clause, vendored in
  `vendor/chess.js` (license in `vendor/LICENSE-chess.js.txt`).
- [PeerJS](https://github.com/peers/peerjs) 1.5.4, MIT, vendored in `vendor/peerjs.min.js`
  (license in `vendor/LICENSE-peerjs.txt`).
- Chess pieces: the "cburnett" set by Colin M.L. Burnett (Wikimedia Commons,
  GFDL/BSD/GPL), taken from the lichess.org repository (GPLv2+). See `pieces/README.txt`.
- The engine's piece-square tables follow the widely published "Simplified Evaluation
  Function" layout.
