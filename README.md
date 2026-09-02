# Neon Slither — deploying online for real multiplayer

This is a real online multiplayer game: one Node.js server holds the whole
arena, and every phone that opens the link connects to it over the internet.
No LAN, no local network needed — this is meant to run on a real hosting
service so anyone, anywhere, can join with just the link.

## Deploy on Render.com (free tier works for testing)

1. Go to https://render.com and sign up (GitHub login is easiest).
2. Put this project in a GitHub repository (Render deploys from GitHub).
   - If you don't already use GitHub: create a new repo, upload these three
     items (`server.js`, `package.json`, the `public/` folder) to it.
3. In Render, click **New +** → **Web Service**, and connect that repo.
4. Settings:
   - **Environment**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Instance Type**: Free is fine to start
5. Click **Create Web Service**. Render will build and start it — after a
   minute or two you'll get a URL like:
   ```
   https://neon-slither.onrender.com
   ```
6. That URL **is the whole game** — open it on any phone's browser and you're
   in. Share the same link with friends; everyone who opens it lands in the
   same arena.

## Giving this URL to Aippy

Since Aippy builds its own games and can't run your custom server, use it
the way you planned: tell Aippy's builder to make a one-page app that, as
soon as it opens, immediately redirects the visitor to:
```
https://neon-slither.onrender.com
```
That's the whole integration — Aippy just becomes a launcher, and the real
game runs on your Render server.

## One thing worth knowing about Render's free tier

Free web services on Render "spin down" after a period of no traffic, and
the *first* visitor after that has to wait ~30-50 seconds while it wakes
back up. Every visitor after that is instant until it goes idle again. If
that's annoying, Render's cheapest paid tier removes it — but free is fine
for testing and casual play.

## Files in this project

- `server.js` — the authoritative game server (all snake movement, food,
  collisions, and scoring happen here; clients just send input and receive
  the current state).
- `public/index.html` — the mobile game page (name entry, touch joystick,
  boost button, canvas rendering, leaderboard).
- `package.json` — lists the one dependency (`ws`, for WebSockets).

## Testing locally first (optional but recommended)

If you get access to any machine with Node.js (even briefly, or via
Termux on Android like we discussed before), you can test before deploying:
```
npm install
node server.js
```
Then open `http://localhost:3000` in a browser. Opening it in two browser
tabs at once lets you see two snakes in the same arena to confirm collisions
and food work before you deploy it for real.
