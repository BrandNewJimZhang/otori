#!/usr/bin/env bash
# Executable acceptance for the AGENTS.md canonical workflows (L4:
# docs that cannot rot). Runs every advertised behavior against a
# throwaway library; any deviation exits non-zero.
#
# Usage: scripts/acceptance.sh [path-to-otori-binary]
set -euo pipefail

OTORI=${1:-target/debug/otori}
[ -x "$OTORI" ] || { echo "FAIL: otori binary not found at $OTORI (cargo build -p otori-cli)"; exit 1; }

TD=$(mktemp -d)
DB="$TD/library.db"
trap 'rm -rf "$TD"' EXIT

fail() { echo "FAIL: $1"; exit 1; }
step() { echo "--- $1"; }

# jq is used to assert JSON shapes; the schema is part of the contract.
command -v jq >/dev/null || fail "jq is required to run acceptance"

# A few valid MPEG frames lofty accepts as MP3.
python3 - "$TD" <<'EOF'
import sys
frame = bytes([0xFF, 0xFB, 0x90, 0x00]) + bytes(413)
open(f"{sys.argv[1]}/song.mp3", "wb").write(frame * 4)
open(f"{sys.argv[1]}/.evicted.mp3.icloud", "wb").write(b"plist")
EOF

step "schema-version prints a number"
[ "$("$OTORI" schema-version)" = "1" ] || fail "schema-version != 1"

step "scan indexes and reports iCloud skips (exit 2 = partial)"
set +e
OUT=$("$OTORI" --db "$DB" scan "$TD" --json)
CODE=$?
set -e
[ "$CODE" = "2" ] || fail "scan exit $CODE, expected 2 (icloud skip present)"
[ "$(jq -r '.added' <<<"$OUT")" = "1" ] || fail "scan added != 1"
[ "$(jq -r '.skipped_icloud | length' <<<"$OUT")" = "1" ] || fail "icloud skip not reported"

step "list returns the indexed track"
"$OTORI" --db "$DB" list --json | jq -e 'length == 1 and .[0].format == "mp3"' >/dev/null \
  || fail "list shape wrong"

step "set is dry-run by default (applied=false, file untouched)"
OUT=$("$OTORI" --db "$DB" set "$TD/song.mp3" --title "T1" --json)
jq -e '.applied == false and (.plan.changes | length == 1)' <<<"$OUT" >/dev/null \
  || fail "dry-run shape wrong"
[ "$("$OTORI" tags "$TD/song.mp3" | jq -r '.title')" = "null" ] || fail "dry-run wrote to disk!"

step "set --apply writes and journals (human, born curated)"
OUT=$("$OTORI" --db "$DB" set "$TD/song.mp3" --title "T1" --artist "A1" --apply --json)
jq -e '.applied == true and .tx_id == 1' <<<"$OUT" >/dev/null || fail "apply shape wrong"
[ "$("$OTORI" tags "$TD/song.mp3" | jq -r '.title')" = "T1" ] || fail "apply did not reach disk"

step "agent bounces off curated (exit 2, proposal in skip report)"
set +e
OUT=$("$OTORI" --db "$DB" set "$TD/song.mp3" --title "Normalized" --agent probe --apply --json)
CODE=$?
set -e
[ "$CODE" = "2" ] || fail "curated bounce exit $CODE, expected 2"
jq -e '.applied == false and (.plan.skipped_curated | length == 1)' <<<"$OUT" >/dev/null \
  || fail "skip report shape wrong"
[ "$("$OTORI" tags "$TD/song.mp3" | jq -r '.title')" = "T1" ] || fail "curated value lost!"

step "agent fills empty field without ceremony"
OUT=$("$OTORI" --db "$DB" set "$TD/song.mp3" --album "AL1" --agent probe --apply --json)
jq -e '.applied == true' <<<"$OUT" >/dev/null || fail "fill-empty refused"

step "agent override with --override-curated is journaled"
OUT=$("$OTORI" --db "$DB" set "$TD/song.mp3" --title "Overridden" --agent probe --override-curated --apply --json)
TX=$(jq -r '.tx_id' <<<"$OUT")
[ "$TX" != "null" ] || fail "override did not apply"

step "undo restores the curated value"
"$OTORI" --db "$DB" undo "$TX" >/dev/null
[ "$("$OTORI" tags "$TD/song.mp3" | jq -r '.title')" = "T1" ] || fail "undo did not restore"

step "double undo fails fast (exit 3)"
set +e
"$OTORI" --db "$DB" undo "$TX" 2>/dev/null
CODE=$?
set -e
[ "$CODE" = "3" ] || fail "double undo exit $CODE, expected 3"

step "journal lists transactions with undone flag"
"$OTORI" --db "$DB" journal --json | jq -e 'length == 3 and (.[0].undone == true)' >/dev/null \
  || fail "journal shape wrong"

step "status reports counts, curation coverage, sources"
"$OTORI" --db "$DB" status --json | jq -e '
  .tracks == 1 and .formats.mp3 == 1 and
  .curated_values >= 2 and .sources.human >= 2 and
  .transactions == 3 and .undone_transactions == 1' >/dev/null \
  || fail "status shape wrong"

step "lyrics resolves sidecar with sync kind"
printf '[00:01.00]Line one\n' > "$TD/song.lrc"
"$OTORI" lyrics "$TD/song.mp3" --json | jq -e '.kind == "line_synced" and .source == "sidecar"' >/dev/null \
  || fail "lyrics shape wrong"

step "bad input exits 3 with structured error"
set +e
ERR=$("$OTORI" --db "$DB" scan /nonexistent 2>&1 >/dev/null)
CODE=$?
set -e
[ "$CODE" = "3" ] || fail "bad input exit $CODE, expected 3"
jq -e '.kind == "bad_input"' <<<"$ERR" >/dev/null || fail "stderr not structured JSON"

echo "OK: all acceptance steps passed"
