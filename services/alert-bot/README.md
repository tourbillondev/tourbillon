# alert-bot

"Tourbillon Alerts", the team alert bot, **alarms only**. Team-only: it posts to the Alert Test group, never anywhere
public and never to the staff group.

It follows the risk monitor's JSON-line log (`services/risk-monitor/src/alarm.ts`: stable lower-dash names, raised /
cleared / event) and posts each change once:

    🟡 ALERT · name            (🔴 for the most serious; the market joined: mark-stale-STK1)

    What happened: …
    Who acts: …                (left out for information posts)
    <link>

    🟢 CLEARED · name

It is **send-only**: it never reads updates, edits, pins or uploads. The team bot (`services/teambot`) runs on the same
bot, is its only Telegram reader, and alone posts the launch (the hourly set, release statuses, the board, the board
poster, Shipped today, staff commands) and the release emergencies. `dust-absorbed` (buyback rounding) is never an
alert; the team bot sums it into Shipped today.

Secrets stay outside the repo, in `~/.tourbillon/alerts.env` (`ALERT_BOT_TOKEN`, `OPS_CHAT_ID`, `TEST_CHAT_ID`). The
token is never printed, logged or written; errors carry the HTTP status only. It refuses to start if the two ids are
the same. The deduplication state lives in `~/.tourbillon/alert-bot-state.json`, so a restart never repeats a post.

    bun src/main.ts --follow /var/log/tourbillon/risk-monitor.log [--dry-run] [--explorer <tx link>] [--guide <link>]
    bun src/announce.ts --test --file announcement.txt   (Alert Test group: always first)
    bun src/announce.ts --file announcement.txt          (staff group: after it reads right in Alert Test)
    bun src/post.ts --file posts/d-guide-1.txt --file posts/d-guide-2.txt --deployment <deployment file>
        (Alert Test group only: the pinned guide, two posts; {{SETTLEMENT}} is filled with the settlement token's symbol
        from the deployment file, and a post with a placeholder left is refused)

`--board`, `--launch-at` and `--summary-at` are refused: they moved to the team bot.

**Announcements, the habit:** every announcement goes to the Alert Test group with `--test` first (the same preview,
wording check and typed "post"), is read there as staff will see it, and only then goes to the staff group with the same
file and no `--test`.
