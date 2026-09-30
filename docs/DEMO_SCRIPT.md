# Demo video script (≤ 5:00)

The brief asks the video to show: **creating scheduled emails**, the **Scheduled and Sent** views, a
**restart scenario** (stop → start → future emails still send), and **(bonus) rate limiting / delay under
load**. This script hits all four in about 4:45, plus Slack, search and Bull Board.

Everything runs in **demo mode**: 60-second "hours", 4 emails per sender per window, ≥ 2 s between sends —
so limits and rollovers happen on camera instead of after an hour.

---

## Before you record (10 min, once)

- [ ] `GOOGLE_CLIENT_ID/SECRET` in `.env` (real login is part of the video)
- [ ] Slack app configured, `cloudflared tunnel --url http://localhost:4000` running, `SLACK_*` in `.env`
- [ ] Start the app in demo mode (`npm run dev:demo`) in **Terminal A**, keep it visible (you'll Ctrl-C it)
- [ ] Log in once with Google; **Settings → Connect Slack** → pick a channel → **Send test message** ✓
- [ ] Clean slate: `npm run demo -w @ri/api -- reset --yes` in **Terminal B**
- [ ] Prepare `leads.csv` (≈ 30 rows: `Name,Email,Company`, plus one bad row and one duplicate)
- [ ] Layout: browser (≈ 70%) + Slack channel and Terminal A (≈ 30%). Browser zoom 110%. Notifications off.
- [ ] Do one full dry run, then `reset --yes` again before the real take.

---

## Shot list

| Time          | Show                        | Do                                                                                                                                                                                                                                  | Say (short)                                                                                                                                                                                                                                                                                             |
| ------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0:00–0:20** | README architecture diagram | Scroll to the diagram                                                                                                                                                                                                               | "Express + BullMQ + Redis + Postgres + Elasticsearch, React front end. No cron — every send is a BullMQ delayed job; Postgres is the source of truth."                                                                                                                                                  |
| **0:20–0:40** | Login page                  | **Login with Google** → dashboard                                                                                                                                                                                                   | "Real Google OAuth — name, email and avatar in the header." Open the avatar menu to show **Log out**.                                                                                                                                                                                                   |
| **0:40–1:30** | Compose                     | **Compose** → drop `leads.csv` → point at "30 detected · 1 invalid · 1 duplicate" → subject `{Quick                                                                                                                                 | Short} question, {{name}}`, body with `{{company}}`; type “FREE — act now!!!” to show the **Content check** turn red, then click the fixes back to green; flip preview recipients to show different variants; set **Randomise gaps ±25%** → **Now**, delay **2 s**, hourly limit **100** → **Schedule** | "CSV is parsed in the browser and validated again on the server. Merge tags come from the CSV columns. The ETA accounts for spacing and hourly limits." |
| **1:30–2:10** | Scheduled tab               | Watch rows flip **Scheduled → Sending**, sidebar counters tick, **Live** pill                                                                                                                                                       | "Live over Server-Sent Events — no refresh. At least 2 seconds between sends from the same sender."                                                                                                                                                                                                     |
| **2:10–2:50** | **Rate limit**              | After 4 sends per sender: **toast appears** and the **Slack message arrives** (show Slack) → rows turn amber **"Rate limited · Resumes …"**                                                                                         | "Each sender is limited per hour (a minute in demo mode). Nothing is dropped: the rest move to the next window in their original order, and Slack is notified the moment it happens."                                                                                                                   |
| **2:50–3:50** | **Restart scenario**        | In Terminal A press **Ctrl-C** → header pill turns red → wait ~10 s → run `npm run dev:demo` again → point at the log line **`boot reconciliation complete … requeued: 0`** → back in the browser, rows keep sending at their times | "The jobs live in Redis with AOF persistence and every email is in Postgres, so a restart loses nothing and nothing starts over. The reconciler found every job still there."                                                                                                                           |
| **3:50–4:10** | Proof                       | Terminal B: `npm run demo -w @ri/api -- verify <campaignId>` (the id is in the Campaigns page URL or the create toast)                                                                                                              | "Zero duplicates — sent rows equal distinct Message-IDs — and the minimum gap per sender is above 2 seconds."                                                                                                                                                                                           |
| **4:10–4:20** | Sent tab + drawer           | **Sent** → click a row that was deferred → timeline _Scheduled → limit reached → Sent_ → **Open in Ethereal**                                                                                                                       | "Every email has its history and a link to the Ethereal inbox."                                                                                                                                                                                                                                         |
| **4:20–4:30** | Search + Bull Board         | Type `acme` in search (highlighted results) → header pill → **Queue dashboard**                                                                                                                                                     | "Elasticsearch search, and the live BullMQ dashboard."                                                                                                                                                                                                                                                  |
| **4:30–4:45** | Ask Inbox                   | Press **Cmd+K** → `which sender is closest to its limit?` (bars) → `pause the northwind campaign` → the **Confirm card** appears (point out "nothing changes until you confirm") → **Pause campaign** → open as panel               | "An offline assistant: answers come from the database, and it only changes something after you confirm."                                                                                                                                                                                                |
| **4:45–4:55** | Theme                       | Header sun/moon → **Dark** (stars, glass cards)                                                                                                                                                                                     | "Light or dark — dark has a space backdrop."                                                                                                                                                                                                                                                            |
| **4:55–5:00** | Campaigns / Analytics       | Quick pan of progress bars and quota meters                                                                                                                                                                                         | "Everything here is measured in `docs/VERIFICATION.md`. Thanks!"                                                                                                                                                                                                                                        |

### Optional bonus cut (if time allows): 1,000 emails at once

```bash
npm run demo -w @ri/api -- load --count 1000 --watch 40
```

Shows the throttling table (1,000 → 988 deferred in seconds, exactly 4/sender/window, 0 duplicates).
Cancel the rest afterwards from the Campaigns page so Ethereal isn't flooded.

---

## If something goes wrong on camera

| Symptom                       | Fix                                                                                                               |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| No Slack message              | Settings shows "Needs reconnect"? Reconnect. Tunnel URL changed? Update the Slack app redirect + `.env`, restart. |
| Rows don't move after restart | Make sure both `[api]` and `[worker]` came back in Terminal A (worker prints "worker running").                   |
| Limit never hits              | You're not in demo mode — use `npm run dev:demo`.                                                                 |
| Too much old data             | `npm run demo -w @ri/api -- reset --yes`                                                                          |
