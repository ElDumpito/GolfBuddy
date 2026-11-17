# GolfBuddy

Shared tee times, who-owes-who and scorecards for a couple of golf buddies. One small container with no packages at all (Node's own http, crypto and sqlite), and a web app you install from Chrome.

- **Tee times.** Paste or share a confirmation email and the form fills itself in. It reads L.A. City Golf (teetimeinfo/EZLinks), GolfNow-powered courses (e.g. Los Verdes) and foreUP courses (e.g. Soule Park), and makes a best guess at anything else. Each tee time has Directions (Google Maps), Add to Google Calendar, Call course, and an I'm in / Can't make it answer.
- **Push notifications** (real Web Push, no extra app): a new or changed tee time, someone dropping out, "⏰ Last call to cancel, still in?" `REMIND_HOURS` (default 12) before free cancellation ends, "Tomorrow: …" at 6 pm the evening before, and new expenses and settle-ups. The "still in?" notification has ✅/❌ buttons that answer without opening the app.
- **Money.** The booker's deposit becomes a ledger line split among the people on the tee time, and it follows the booking if you edit it. Add green fees paid at the course, food, pro shop, range, anything, split evenly, all for one person, or by amount. "Pay with Venmo" opens Venmo with the amount and note filled in (Venmo's official payment links); then tap *Mark paid*, since the app cannot see Venmo.
- **Scorecards.** Hole by hole with big −/+ buttons, front/back 9 or 18, pars remembered per course, a full card with Out/In/Total, and head-to-head records. GHIN does not let personal apps post scores, so there is a *Copy my scores* button and a link to GHIN.

## Install on the NAS (Container Station only, same pattern as StashHouse Poker)

The app joins the `boker-tunnel_default` network, so `boker-tunnel` must be running. Every push to `main` runs the tests and publishes `ghcr.io/eldumpito/golfbuddy`.

1. **Let the NAS pull the image.** GitHub › your profile › Packages › `golfbuddy` › Package settings › Change visibility › Public (the code stays private; the image holds no secrets). Or add a `read:packages` token under Container Station › Registries.
2. **Cloudflare tunnel.** GolfBuddy rides on the poker app's tunnel (`boker`, whose connector runs as the `boker-tunnel` application), so there is no new token or connector. Zero Trust › Networks › Tunnels › `boker` › Public hostnames › Add: `golf.juno.nexus` → HTTP → `golfbuddy:8790`.
3. **Login wall.** Zero Trust › Access › Applications › Add › Self-hosted, name "GolfBuddy", domain `golf.juno.nexus`, a policy allowing your email and your buddy's. Set the session duration to 1 month so the installed app and notification taps do not keep bouncing to the login page.
4. **The app.** Container Station › Applications › Create, name `golfbuddy`, paste `docker-compose.yml`. Optionally set `INVITE_CODE`; left as `change-me`, one is generated (container log, and Me › Admin).
5. Open `https://golf.juno.nexus`, **Create account** first (that account is the admin), then send your buddy the invite code.

On each phone: open the site in Chrome › ⋮ › **Add to Home screen / Install app**, then **Turn on** notifications. Installing also puts GolfBuddy in Android's Share menu: in Gmail, long-press the email text › Select all › Share › GolfBuddy.

**Updating:** after a push, open the `golfbuddy` application in Container Station and recreate it (it pulls `latest`). Data lives in `/Container/golfbuddy-data/golfbuddy.db`; add that folder to the Backblaze job.

## Notes

- Times are Los Angeles time throughout. Money is stored in cents.
- The push signing keys are made on first start and kept in the database. If the database is replaced, each phone just taps *Re-connect this device* under Me.
- Cancellation windows default from the course (L.A. City 24h, Los Verdes 48h); edit them per course under Me › Courses or per tee time.
- Not in this version: automatic Google Calendar sync (a shared calendar via a Google service account), posting to GHIN, pulling bookings from the course sites (L.A. City forbids automated access to its reservation system).

## Tests

```
npm test   # confirmation reader on real (anonymised) emails, Web Push encryption + VAPID, and a full server run
```
