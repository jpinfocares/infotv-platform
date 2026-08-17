# INFO TV APP — Digital Signage Platform

A self-hosted digital signage platform (like AbleSign), branded **INFO TV APP**.
It has two parts:

- **Dashboard** — where you log in, upload content, add websites, group screens, and assign what plays where.
- **Player** — what runs on each TV. It shows a pairing code, then plays whatever you assign.

---

## 1. Requirements
- [Node.js](https://nodejs.org) 18 or newer installed on the machine/server that will run it.

## 2. Run it
```bash
npm install      # first time only
npm start
```
You'll see: `INFO TV APP platform running on http://localhost:3000`

Open **http://localhost:3000** in a browser → create an account → you're in.

## 3. Add content
- **Content** tab → **Upload files** → pick images or videos.
- **Websites** tab → **Add website** → any URL (menu board, dashboard, live page).

## 4. Connect a TV
1. On the TV, open the player page: **http://<server-address>:3000/player.html**
   (On the same machine that's `http://localhost:3000/player.html`. On a real TV, use the server's LAN IP, e.g. `http://192.168.1.50:3000/player.html`.)
2. The TV shows a 6-character **pairing code**.
3. In the dashboard → **Screens → Pair a screen** → type that code, name the screen, optionally put it in a group → **Pair screen**.
4. The TV connects automatically.

## 5. Decide what plays
- On any **Screen** or **Group** card → **Assign content** → tick the images/videos/websites → **Save playlist**.
- The TV picks up changes within a few seconds. A screen with no playlist of its own falls back to its **group's** playlist.

---

## Using it over the internet / real deployment
For production you'll want to:
- Run it on a server (VPS, cloud VM) with a domain, e.g. `https://tv.yourcompany.com`.
- Put it behind HTTPS (a reverse proxy like Nginx or Caddy).
- Change `JWT_SECRET` — set it as an environment variable before `npm start`:
  ```bash
  JWT_SECRET="a-long-random-string" PORT=80 npm start
  ```
- Content and the database live in `./uploads` and `./data` — back these up.

## Connecting the rebranded Android APK (INFO_TV_APP.apk)
The APK you rebranded is the **AbleSign** player and still points at AbleSign's servers.
To make it play from **this** server instead, the app's server URL must be changed to your
address (e.g. `http://your-server:3000`). That requires editing the app's source or patching
the compiled URL — a separate step from this platform. Until then, use **`/player.html`**
in any browser (including the browser on an Android TV / Fire Stick) as the player — it works
with this server right now.

## API summary (for the player / integrations)
- `POST /api/player/register` `{device_id}` → `{device_id, paired, pair_code}`
- `GET  /api/player/state?device_id=...` → `{paired, name, playlist:[{type,url,duration,title}]}`

`type` is `image`, `video`, or `website`.

---
Built as a starting platform. It covers accounts, content, websites, screens, groups,
pairing, and playlist assignment. Natural next features: scheduling by time of day,
drag-to-reorder playlists, multi-user roles, and screen layout zones.
