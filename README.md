# ✏️ Pen Fight Arena

A real, working pen-fighting duel game: touch-flick physics, an AI opponent,
and genuine online multiplayer with rooms up to 4 players, friends, chat,
ranked stats, and a leaderboard. This README covers the whole project as it
stands today — earlier README files in this project are outdated; use this one.

## Files in this project

```
index.html           ← the entire game client (open this in a browser)
server/
  server.js           ← the multiplayer server (Node.js)
  package.json        ← server dependencies
  .env.example        ← server environment variable template
```

That's everything. No build step for the client — it's one self-contained
HTML file.

## What's real right now

**Fully offline, no server needed:**
- VS Computer with 4 AI difficulties, real 2D physics, touch controls
- 6 arenas (Classroom Desk, Wooden Table, Night Classroom, Neon Arena, Cyber
  Desk, Championship Arena) and 2 UI styles (Tech / Classic), chosen independently
- 6 pen skins, persisted locally
- Configurable match length (Best of 3/5/7)
- Sound, music, settings — all local

**Needs the server running:**
- Quick Match (2-player random pairing) and Private Rooms (share a 6-character code)
- Private rooms support 2–4 players — 3-4 players play a real bracket
  (semifinal(s), then a final) using the same engine as a normal 1v1 match
- Reconnection if you drop mid-match (25s grace window)
- Friends: a shareable tag, requests, accept/decline, live online status
- Chat with friends — from the lobby or mid-match, in a slide-in panel
- Real XP, levels, win/loss stats, and a leaderboard — **from ranked online
  matches only**; VS Computer never touches this, since the server can't
  verify anything that happens purely client-side

## 1. Run the server

Requires Node.js 18+ (Termux: `pkg install nodejs`).

```bash
cd server
npm install
npm start
```

You should see:
```
Pen Fight Arena server listening on port 3001
CORS origin: *
```

Data (accounts, friends, chat history, stats) is saved to `server/data/*.json`,
created automatically on first run. This survives a server *restart* but not
a redeploy on hosts with ephemeral disks — see the deployment note below.

## 2. Point the client at your server

Open `index.html` in a text editor, find near the top of the `<script>`:

```js
const SERVER_URL = 'http://localhost:3001';
```

Leave as-is for local testing. Change it to your deployed server's URL once
you deploy (step 4).

## 3. Test with two players locally

```bash
# from the project root, in a second terminal
python3 -m http.server 8080
```
Open `http://localhost:8080` in two different browsers (or one normal + one
incognito window — this matters, since each needs its own identity/token).
Create a room in one, join with the code in the other, ready up, and play.

## 4. Deploy the server for free

**Render** (free tier, supports the long-lived WebSocket connections this
needs) is a solid beginner-friendly choice:

1. Push `server/` to a GitHub repo.
2. On [render.com](https://render.com): New → Web Service → connect the repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Set env var `CLIENT_ORIGIN` to wherever you host the client (or leave
   as `*` while testing, then lock it down once you know the real URL).
5. Deploy — you'll get a URL like `https://your-app.onrender.com`.
6. Put that URL into `SERVER_URL` in `index.html` (step 2).

Free-tier services spin down when idle and take ~30-60s to wake on the next
request — the first connection after idle time will just look like
"Connecting…" a bit longer than usual. That's expected.

## 5. Host the client

`index.html` is a static file — GitHub Pages, Netlify, or Vercel's free
tiers all work by just dropping it in. Once hosted, set `CLIENT_ORIGIN` on
the server to that exact URL (using `*` is fine for testing but means any
website could connect to your server).

## How the physics stay in sync (worth knowing before you test)

The two players never try to run physics in lockstep — that drifts across
different hardware. Instead, whoever takes a shot simulates it locally
(identical to VS Computer), records the motion, and sends that recording to
the opponent, who replays it rather than re-simulating. Both screens always
agree on the outcome. The server owns whose turn it is and the score, but
trusts each shooter's reported result rather than re-simulating physics
itself — a deliberate simplification for a free-tier hobby server, not a
claim of tournament-grade anti-cheat.

## How a 4-player room works

The core game is fundamentally 1v1 ("knock *the* opponent's pen off"), so a
4-player room doesn't mean 4 pens flying at once — it runs a real bracket:
Semifinal 1, Semifinal 2, then a Final between the winners, played
sequentially (not in parallel) using the exact same 1v1 engine each time.
Players not in the current match see live bracket progress, not the other
match's physics.

## Known limitations, honestly

- Server data is plain JSON files, not a real database — fine for a hobby
  deployment, but a server *redeploy* (not restart) on most free hosts wipes
  it, since their disks are ephemeral.
- Physics outcomes are trusted from the shooter's client, not independently
  verified server-side.
- No rate limiting or abuse protection — fine for playing with friends, not
  meant for a public-facing link yet.
- Semifinals in a 4-player bracket run one after another, not simultaneously.
- Never tested on a real phone or between two real devices — I don't have
  network access to do that myself. Everything server-side has been
  verified with automated tests against the actual server code, but you'll
  be the first live, real-device test.

## Not built

- A PWA/installable wrapper (no manifest, no service worker)
- Trail/impact-effect cosmetics beyond pen color; player avatars
- A real database, server-side physics validation, rate limiting
