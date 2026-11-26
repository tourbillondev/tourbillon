# release: the tech updates release system

Private job (playbook 07). Once armed with a launch time it ships one update per hour by itself: each update is
built, tested, deployed to testnet then mainnet, checked live and published, and only then is the team bot
(`services/teambot`) told to post it. It **never posts to Telegram itself**, apart from one send-only emergency
(`teambot-heartbeat-missing`) that the team bot cannot send.

## Where things are

| Path | What |
|---|---|
| `services/release/` | this job: `src/`, `test/`, `server/` (config example, unit files, bundle maker, quick check), `dryrun/` (the local Telegram stand-in) |
| `queue/NN/` | each update: `patch.diff` and `meta.json` (written by `src/export.ts`) |
| the kit (`tourbillon-teambot-data/`) | `updates.json` and posters; on the server the team bot's data folder, so there is one kit only |

## The schedule

At the launch minute the team bot posts the launch announcement. Update NN posts at **launch + NN hours**, to the
minute. Its work starts 30 minutes before (the window) and finishes before the hour:

1. **Gate.** `meta.json` complete and in step with the kit; the words check (no opt-out) on the title, both posts,
   the changelog line and every added line; Telegram text within 1,024 characters with its heading and link, X text
   within 280; both posters present and exact (1080x1080, 1200x675); no core contract and no private path.
2. **Build and test.** The patch onto the previous update as "Update NN: title" (author tourbillondev), its changelog
   line under "Tech updates"; install and the full tests (`tsc`, `bun test`, `forge test`, the words check).
3. **Deploy.** testnet, then mainnet: a new release folder, the database step when it adds one, `current` switched,
   the roles restarted, then the live checks (`/healthz`, `/v1/status` chainId, this update's checks and every
   earlier update's). A failure rolls every touched target back and checks the previous release healthy.
4. **Publish.** The public commit on the public repo's own history, then the GitHub release at that commit. A retry
   never commits twice or makes two releases.

At the minute: ready → `released` (the team bot posts the full set and ✅). Still failing → `held` (or `rolled_back`)
and the next update keeps its time. Live but not yet published → `delayed`, retried every 2 minutes, then
`released`. Anything that fails in the window opens a release emergency at once (the team bot repeats it every 2
minutes in Alert Test; `/ack` pauses it 15 minutes). After a pause, overdue updates go 2 minutes apart.

It writes its heartbeat every tick (`<dataDir>/heartbeat`) and watches the team bot's; it pings the outside check
every minute while healthy (`pingUrlFile`).

## Commands (on the server only, never from Telegram)

```
tourbillon-release arm "2026-12-01 14:00"     the launch time (UTC)
tourbillon-release status
tourbillon-release hold 15 "reason"           HELD; the next stays on time
tourbillon-release release 15                 back in the queue; its checks run again
tourbillon-release pause "reason" | resume
tourbillon-release disarm                     only before any update has gone out
tourbillon-release verify 23
tourbillon-release preflight [--post]
tourbillon-release test 4                     the full set of update 4 to Alert Test only
tourbillon-release deploy-main <commit>       after the last update, :05-:25 UTC only (below)
```

`tourbillon-release` is a shortcut for `bun /home/tourbillon/tourbillon-ship/services/release/src/ctl.ts`. The
systemd unit is `tourbillon-ship`; the team bot's is `tourbillon-teambot`.

**deploy-main**: after all updates are out, a merged commit of the public main goes live the same way (build, the
same tests, testnet then mainnet, the database step, every live check, the team bot's heartbeat, automatic rollback).
Refused unless it is :05-:25 UTC, nothing is pending, and the commit is the public main's tip, contains what is live
and carries no attribution line. Nothing is posted; a failure is a release emergency until a later
deploy-main goes live.

## Guards in the code

- Mainnet stays off unless the config says `mainnetAllowed: true` **and** a passing testnet proof file exists.
- The real run has exactly two targets, testnet then mainnet; `arm` is refused while either is off.
- One job per data folder (a lock file).
- Only a dry run may change the slot or the count of 62, or use a local Telegram or GitHub stand-in, and a dry run
  may never have a mainnet target.
- Every secret file (alarm token, release token, deploy key, ping address) must be mode 600; tokens are removed from
  every log line and error.
- It pushes only to `tourbillondev/tourbillon` over SSH with its own deploy key.

## On the Mac

```
cd services/release && bun test                          the job's own tests (with the team bot end to end)
bun src/export.ts <authoring copy> ../../queue-src ../../queue 1 2 …
                                                         queue/NN (patch.diff, meta.json) from the authoring copy's commits
bun src/kit.ts --kit <kit> --deployment <file>           the kit's updates.json from queue-src (the symbol from the deployment)
bun src/posters.ts --kit <kit> --proof-repo <authoring copy>
                                                         every update poster and board poster, in the approved design
bun src/launchkit.ts --kit <kit> --symbol USDG --proof-repo <authoring copy>
                                                         the 17-file launch kit (after the posters), in <kit>/launch-kit
bun src/preflight.ts --config <file> --test              every queued update in order, in a fresh copy
server/make-server-bundle.sh                             the server package (checked for secrets; copies nothing)
```

The posters use the owner's approved design (option A3, from the website's theme); its assets sit in the kit's private
`design/` folder. Every poster is checked before any is written: no overflow, the header clear of the artwork, one
left line for the text, the kit's own text, and each command against its own update's commit. While the kit has no
posters (a design not yet approved), the gate says "posters pending owner approval" and preflight still applies every
change in order.

The launch kit is checked the same way before anything is written: every text against the words list, every claim
against the code that makes it (in the authoring copy's last update), every page for overflow, each file at its size
and the PDF one A4 page. It ends with `MANIFEST.sha256`; the square announcement is also the team bot's launch poster.
The demo videos come after the website is integrated (RH15).

The pipeline, batch and publishing dry runs on testnet (playbook 07 §9) come with RH12, with a throwaway public repo
and a separate dry-run bot. Server set-up boxes: `docs/notes/LAUNCH_NOTES.md`, run only after the owner's yes.
