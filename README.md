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
4. **The app.** Container Station › Applications › Create, name `golfbuddy`, paste `docker-compose.yml`. Optionally set `INVITE_CODE`; left as `change-me`, one is generated (container log, and Me › Admin). Container Station rejects `mem_limit` in the file; set limits under Advanced Settings if wanted.
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

## Version 2: Round Brief, wake-up calls, shot tracking, your bag

**Round Brief** on every tee time: National Weather Service forecast for the hours you'll be playing, sunrise/sunset/last light
(worked out locally) with a warning when a round runs past dark, when to leave home in expected traffic, the scorecard for the
course (par, yardage and rating by tee, hole handicaps) and notes about the course. Scorecards for the six seeded courses come from
OpenGolfAPI (© OpenStreetMap contributors, ODbL) and were spot-checked against the courses' own cards; `tools/build-course-data.py`
rebuilds `server/course-data.json`.

**Keys** are pasted in Me › Admin (admin only), stored in the NAS database and never sent back to the app except the browser key
(which only works on golf.juno.nexus). Nothing in docker-compose.
- Google server key: Routes API + Places API (New). Leave-by times, ranges & simulators within 30 miles, address lookups.
- Google browser key: Maps JavaScript API. The satellite map in shot tracking. Without it a simple drawing is shown.
- Twilio Account SID, Auth Token and phone number: wake-up phone calls. Without them the wake-up is a push notification.

**Wake-up calls**: each person turns them on in Me (needs their own mobile number and home address). On by default for tee times
before 8 a.m., switchable per tee time. The call comes 30 minutes before leave-by (re-checked with traffic about 3 hours ahead),
says when to leave, rings again 5 minutes later if unanswered, and tells the others if both go unanswered. No webhook: the
server asks Twilio how the call went, so nothing has to get through Cloudflare Access.

**Shot tracking** (Scorecard › Shots): stand by your ball, pick the club, tap Mark. Live yards to the green and since the last
shot, an auto hole switch, photos stamped with time, GPS and distances, and per-club averages and left/right misses under
Rounds › Your game. Hole layouts come from OpenStreetMap where the course is mapped, otherwise they're learned from your first
tee shot and "In the hole" tap on each hole.

**Your bag**: clubs, balls, gloves, shoes; barcode scan (Chrome's built-in reader) or name search (UPCitemdb, free tier), and
the brand's support phone and site for warranty questions.

## L.A. City prices, the rest paid at the course, Player Cards, weather alerts

- **Prices** (`server/rates.js`): Rancho, Wilson, Harding and Roosevelt green fees from golf.lacity.gov/rates (checked
  2026-11-25): weekday, weekend, weekend before 9 a.m., twilight, super twilight, City holidays (golf.lacity.gov/?p=264),
  plus cart seats and push-cart rental. Twilight follows the City's posted seasonal schedule; a Player Card starts it an
  hour earlier. A tee time saved with an empty total gets its total from these rates and keeps it up to date (walk / push
  cart / riding cart). Typing a total switches that off for the tee time. Re-check the rates when the City changes them.
- **Deposit and the rest**: the booker's deposit counts toward the total. "At the course: … Not yet / CK paid / Mike paid"
  on a tee time (or "The rest, paid at the course by" when entering one) adds one ledger line for the total minus the
  deposit, split evenly, and keeps it in step with the total.
- **Player Card**: Me › L.A. City Player Card. Number and renewal date are only shown to their owner; a push two weeks
  before renewal.
- **Weather alerts**: every 30 minutes for tee times in the next 5 days. One alert when the forecast turns bad (40%+ rain
  or 20+ mph wind), one when it clears (under 25% and 15 mph). The cancellation-deadline and night-before reminders
  include the forecast.
- **Call me now**: Me › Getting there, once Twilio is set up and your number is saved.

## Bookings by email (Cloudflare Email Routing → Worker → GolfHomie)

Forward a confirmation to `bookings@juno.nexus` and it becomes a tee time (a cancellation email cancels it).
One-time setup:
1. Cloudflare › juno.nexus › **Email › Email Routing** › Enable (it adds the MX/TXT records; juno.nexus had no mail before).
2. **Workers & Pages** › Create Worker `golfhomie-mail`, paste `deploy/email-worker.js`, Deploy. Settings › Variables:
   `GOLFHOMIE_URL` = `https://golf.juno.nexus`; Secret `INBOUND_KEY` = GolfHomie › Me › Admin › Bookings by email › Copy worker key.
3. Email Routing › Routing rules › Create address `bookings` › action **Send to a Worker** › `golfhomie-mail`.
4. Zero Trust › Access › Applications › Add self-hosted app `GolfHomie inbound`: domain `golf.juno.nexus`, path `api/inbound`,
   policy **Bypass / Everyone**. (The key is what protects this path.)
5. Gmail › Settings › Forwarding › Add `bookings@juno.nexus`. Gmail's code shows up in GolfHomie (push + Admin). Then a filter:
   `from:(alerts@teetimeinfo.com OR golfnow.com OR foreup)` › Forward to `bookings@juno.nexus`.
6. Each person puts the Gmail they forward from in Me, so their tee times are filed under them.

## Homies

Each person has a QR code (Me › Homies › My code) that links whoever scans it, with a phone camera or the in-app scanner.
Someone new can sign up from it; like any sign-up, it waits for an admin to approve it. You only see your Homies, the tee times and rounds you're on, and
money you're part of; who-owes-who is counted pair by pair. Everyone who used the app before Homies were linked once at upgrade.
`public/vendor/qrcode.js` is qrcode-generator 2.0.4 (MIT, Kazuhiko Arase).

## Camera reading

Paper scorecards, receipts, clubs and balls, and the Player Card can be read from a photo. The photo is shrunk on the
phone, sent to Anthropic's Claude (`claude-sonnet-5-5`, change with `ANTHROPIC_MODEL`) and what comes back is checked
and shown to you to confirm. Nothing is saved until you tap to fill it in. It's off until an Anthropic API key is pasted in
Me › Admin (console.anthropic.com › API keys; add a few dollars of credit and a monthly spend limit). Each person can read 40
photos a day. The Player Card scan tries the card's barcode on the phone first, which is free and needs no key.

## Sign-ups and approval

Anyone who reaches the site can create an account with a username and password, but it stays *waiting* until an admin
approves it: admins get a push notification with Approve / Decline buttons (or use the list at the top of Me). A waiting
account can't log in. Declining deletes it. At most 10 can wait at once. The invite code (Me › Admin) skips the wait for
someone you've already said yes to. The very first account on a fresh install is the admin.
