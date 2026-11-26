#!/bin/bash
# Packs what the server needs into one file, checks it holds no secret, and prints where it is (it copies nothing).
# Run on the Mac:   services/release/server/make-server-bundle.sh
# Packs: services/common, services/release (src, server, package.json, tsconfig, README), services/teambot (src,
# package.json, tsconfig, README), a services/package.json naming only those three, and the queue (queue/NN: patch.diff,
# meta.json). No kit: on the server the release system reads the team bot's own data folder
# (/home/tourbillon/tourbillon-teambot-data), so there is one kit only. Nothing from docs/notes, docs/spec or ~/.tourbillon.
set -eu
R="$(cd "$(dirname "$0")/../../.." && pwd)"; OUT="$R/../tourbillon-server-bundle"; STAMP=$(date -u +%Y%m%dT%H%M%SZ)
S="$OUT/stage/tourbillon-ship"
rm -rf "$OUT/stage"; mkdir -p "$S/services"
rsync -a --exclude node_modules --exclude test "$R/services/common" "$S/services/"
rsync -a --exclude node_modules --exclude test --exclude dryrun "$R/services/release" "$S/services/"
rsync -a --exclude node_modules --exclude test "$R/services/teambot" "$S/services/"
cat > "$S/services/package.json" <<'JSON'
{ "name": "tourbillon-ship", "private": true, "workspaces": ["common", "release", "teambot"] }
JSON
rsync -a "$R/queue" "$S/"
# refuse anything that looks like a secret or a local env file
if find "$OUT/stage" \( -name '.env*' -o -name '*.env' -o -name 'config.json' -o -name 'state.json' -o -name 'heartbeat' \) | grep -q .; then echo "refused: an env, config, state or heartbeat file is in the bundle"; exit 1; fi
if grep -rIlE --exclude=make-server-bundle.sh '[0-9]{8,10}:[A-Za-z0-9_-]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY|(PRIVATE_KEY|SECRET|TOKEN)=[^ ]{8,}|ghp_[A-Za-z0-9]{20,}|github_pat_' "$OUT/stage" ; then echo "refused: something like a secret is in the files above"; exit 1; fi
( cd "$S" && find . -type f ! -name MANIFEST.sha256 -print0 | sort -z | xargs -0 shasum -a 256 > MANIFEST.sha256 )
tar -C "$OUT/stage" -czf "$OUT/tourbillon-ship-$STAMP.tgz" tourbillon-ship
echo "bundle: $OUT/tourbillon-ship-$STAMP.tgz ($(du -h "$OUT/tourbillon-ship-$STAMP.tgz" | cut -f1)), $(wc -l < "$S/MANIFEST.sha256") files, no secret found"
echo "fingerprint: $(shasum -a 256 "$OUT/tourbillon-ship-$STAMP.tgz" | cut -d' ' -f1)"
echo "Nothing was copied. The copy box comes from the setup guide (LAUNCH_NOTES)."
