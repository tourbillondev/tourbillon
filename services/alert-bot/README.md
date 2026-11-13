# alert-bot

"Tourbillon Alerts", the team alert bot (launch core). Team-only: it posts to Telegram groups, never anywhere public.

It follows JSON-line files and posts each change once, in the Cofer look:

    🟡 ALERT · NAME            (🔴 for the most serious)

    What happened: …
    Who acts: …
    <link>

    🟢 CLEARED · NAME

- the risk-monitor's alarm lines (`services/risk-monitor/src/alarm.ts`: stable names, raised / cleared / event);
- the release pipeline's release lines: `✅ SHIPPED AND RELEASED · Update NN` (deployed and published in one run),
  `🟡 RELEASE DELAYED · Update NN` (live on the system; the public copy and GitHub release retrying; the normal SHIPPED AND
  RELEASED follows), `🟡 HELD · Update NN`, `🔴 ROLLED BACK · Update NN` (each with what happened, who acts, the next
  step and a link), and a once-a-day `Shipped today` summary with each
  released update's proof link;
- a once-a-day buyback-rounding note (DUST_ABSORBED summed for the day; never an alert of its own).

Routing (owner's, final): the Alert Test group gets every risk and ops alarm and every information post, including a
once-a-day buyback-rounding note on days with some, always; **alarms never go to the staff group**. Release alerts
(SHIPPED AND RELEASED / RELEASE DELAYED / HELD / ROLLED BACK, once the release pipeline runs) go to the staff group with a copy to the Alert Test group;
the once-a-day "Shipped today" summary (each released update with its proof link) goes to the staff group. The staff group gets only the pinned launch board (`--board`, edited in
place: "TOURBILLON LAUNCH live", "Live N / 62" with a 12-cell bar, the next update, held updates; the launch time before
launch; Update NN is scheduled at launch + (NN − 1) hours, so Update 01 goes out at the launch moment), `/schedule` replies (UTC / Moscow / New York) and owner announcements (`src/announce.ts`: preview, wording check, then the
owner types "post"). After launch the release pipeline adds the hourly tech-update posts there.

Secrets stay outside the repo, in `~/.tourbillon/alerts.env` (`ALERT_BOT_TOKEN`, `OPS_CHAT_ID`, `TEST_CHAT_ID`). The
token is never printed, logged or written; errors carry the HTTP status only. The bot refuses to start if the two ids are the same. The
deduplication state lives in `~/.tourbillon/alert-bot-state.json`, so a restart never repeats a post.

    bun src/main.ts --follow /var/log/tourbillon/risk-monitor.log --follow /var/log/tourbillon/releases.log [--board [--launch-at 2026-12-01T14:00:00Z]] [--dry-run]
    bun src/announce.ts --test --file announcement.txt   (Alert Test group: always first)
    bun src/announce.ts --file announcement.txt          (staff group: after it reads right in Alert Test)
    bun src/post.ts --file posts/d-guide.txt           (Alert Test group only)

**Announcements, the habit:** every announcement goes to the Alert Test group with `--test` first (the same preview,
wording check and typed "post"), is read there as staff will see it, and only then goes to the staff group with the same
file and no `--test`.

Release line (written by the release pipeline, one per outcome):

    {"kind":"release","status":"released|delayed|held|rolled_back","update":7,"title":"…","what":"…","who":"…","next":"…","link":"…","proof":"…","at":"2026-11-14T13:00:05Z"}
