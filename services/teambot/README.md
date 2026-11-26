# teambot

The Tourbillon team bot (playbook 06), on the "Tourbillon Alerts" bot. Team-only: it posts to two Telegram groups,
never anywhere public. It is **the only poster of the launch** and **the only Telegram reader** (`getUpdates`); the
alert bot (`services/alert-bot`) runs on the same bot, send-only, for risk and ops alarms.

It has **no clock of its own for updates**. It posts an update only when the release system (`services/release`)
tells it, through notice files in its `inbox/`, and it remembers every notice id, so a notice written twice is posted
once.

| Notice | What it posts | Where |
|---|---|---|
| `released` | the heading "Tech Updates: Update NN Released", the square poster with the Telegram text, a zip of only that poster, the wide poster with the X text ("For X · N characters"), a zip of only that poster, then `✅ SHIPPED AND RELEASED · Update NN · release update-NN`; after the last, `🏁 ALL 62 UPDATES ARE LIVE`; the board poster 30 minutes later | staff group |
| `delayed` / `held` / `rolled_back` | that status line only (`🟡 RELEASE DELAYED`, `🟡 HELD`, `🔴 ROLLED BACK`) | staff group |
| `launch` | `🟢 TOURBILLON IS LIVE` with the launch poster, once | staff group |
| `armed` / `disarmed` / `paused` / `resumed` / `preflight` | the control messages (each day's schedule after `armed`) | staff group |
| `test` | the full set of update N and its status line, marked TEST | Alert Test only |
| `alarm` / `cleared` | release emergencies (below) | Alert Test only |

Each post's message id is saved before the next is sent, so a crash part way resumes with the rest, once each, in
order. A notice that cannot be posted stays in the inbox and is tried again on the next tick, and nothing after it
goes first.

**Release emergencies** (`templates/alerts/release-emergency.md`): raised at once in Alert Test, repeated every 2
minutes with how long they have been open; `/ack` (a reply to the alarm, `/ack <name>`, or `/ack` alone when one is
open) pauses one for 15 minutes; one `🟢 CLEARED` line when it is fixed. Names, from the release system:
`release-gate-failed-NN`, `release-build-failed-NN`, `release-tests-failed-NN`, `release-deploy-failed-NN`,
`release-live-check-failed-NN`, `release-push-failed-NN`, `release-github-failed-NN`, `release-not-ready-NN`,
`release-main-build-failed`, `release-main-tests-failed`, `release-main-deploy-failed`,
`release-main-live-check-failed`; from this bot: `release-system-stopped` (the release system's heartbeat is older
than 2 minutes). The release system sends `teambot-heartbeat-missing` itself, send-only, because this bot cannot.

It also keeps:
- **the pinned board** "TOURBILLON LAUNCH live", posted and pinned once, then edited in place when its text changes
  and at least every 5 minutes (the bot must be a group admin with "Pin messages");
- **the board poster** 30 minutes after each release (pre-drawn in the kit as `posters/board/board-LL.png`), only the
  latest after a catch-up, as text whenever an update is held; a failed send retries in 2 minutes;
- **Shipped today** at 23:55 UTC for that UTC day, on days with releases, in UTC · Moscow · New York, each released
  update with its proof link, plus one buyback-rounding line on days with some (the risk monitor's `dust-absorbed`
  lines, summed);
- **staff commands**, staff group only: `/status /next /schedule N /poster N /changelog /roadmap /contracts /socials
  /videos /video N /health /help`; the same command twice within 5 seconds is answered once; a reply to one of its
  messages gets the command list, at most once every 30 seconds per message;
- **its heartbeat** (`<data>/heartbeat`, every 10 seconds), which the release system watches.

Times are always UTC · Moscow · New York. Texts are word for word from the playbook's templates, with the settlement
token's symbol from `config.json`.

## Data folder (private, mode 700, never committed)

    updates.json  config.json  posters/{square,wide,board}/  posters/launch.png  inbox/  state.json  heartbeat

`config.json`: `repo`, `explorer`, `settlementSymbol`, `contracts`, `socials`, `videos`, `health`, and optionally
`roadmapImage`, `productBot`, `domain`. It refuses to start on any problem in either file, on a `state.json` it
cannot read, or when the staff group and Alert Test are the same chat.

## Run

    bun src/main.ts --data /home/tourbillon/tourbillon-teambot-data \
      --release-heartbeat /var/lib/tourbillon-ship/heartbeat --dust-log /var/log/tourbillon/risk-monitor.log \
      --env-file /home/tourbillon/.tourbillon-release/alerts.env [--dry-run [--telegram-api http://127.0.0.1:<port>]]

The env file (written by the owner, mode 600): `ALERT_BOT_TOKEN`, `OPS_CHAT_ID` (staff group), `TEST_CHAT_ID`
(Alert Test). The token is never printed, logged or posted. `--dry-run` posts everything to Alert Test, marked
DRY RUN; `--telegram-api` (the local stand-in in `services/release/dryrun`) is refused outside a dry run.
On the server: `services/release/server/tourbillon-teambot.service`.
