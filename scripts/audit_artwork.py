#!/usr/bin/env python3
"""Layer-1 mechanical artwork audit (AGENTS.md: artwork audit workflow).

Local-only, no network. Finds cover/album-tag binding breaks WITHOUT
assuming which side is wrong (the album tag itself may be incorrect —
founding-user 2026-07-07; the identity anchor is title+artist, which
the owner hand-verified per track):

  A  same image bytes under >=2 distinct album tags   (cover copy-paste
     across albums, or album tags that should be unified)
  B  same album tag carrying >=2 distinct images      (one of the covers
     — or the album tag — is wrong)
  C  non-square image (>5% aspect deviation)          (screenshot/PV
     frame, not a jacket)
  D  below the 400px floor                            (known-low list)

Output: human summary on stdout + machine report as JSON lines.
Layer 2 (agent visual review against external DBs) consumes the report.

Usage: scripts/audit_artwork.py [--db PATH] [--otori BIN] [--out REPORT]
"""
import argparse
import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unicodedata
from collections import defaultdict

FLOOR_PX = 400  # SilentBlue authorization is the effective library floor


def nfc(s):
    return unicodedata.normalize("NFC", s) if s else s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.path.expanduser(
        "~/Library/Application Support/otori/library.db"))
    ap.add_argument("--otori", default="target/debug/otori")
    ap.add_argument("--out", default="/tmp/artwork_audit.jsonl")
    args = ap.parse_args()

    conn = sqlite3.connect(args.db)
    rows = conn.execute("""
        SELECT t.path,
               MAX(CASE WHEN v.field='title'  THEN v.value END),
               MAX(CASE WHEN v.field='artist' THEN v.value END),
               MAX(CASE WHEN v.field='album'  THEN v.value END)
        FROM tracks t LEFT JOIN tag_values v ON v.track_id = t.id
        GROUP BY t.id ORDER BY t.path
    """).fetchall()

    records = []
    with tempfile.TemporaryDirectory() as td:
        img = os.path.join(td, "img")
        for path, title, artist, album in rows:
            proc = subprocess.run(
                [args.otori, "artwork", path, "--out", img,
                 "--min-size", str(FLOOR_PX), "--json"],
                capture_output=True, text=True)
            line = proc.stdout.strip()
            if not line or line == "null":
                records.append(dict(path=path, title=title, artist=artist,
                                    album=nfc(album), status="none"))
                continue
            meta = json.loads(line)
            digest = hashlib.sha256(open(img, "rb").read()).hexdigest()[:16]
            records.append(dict(
                path=path, title=title, artist=artist, album=nfc(album),
                status="ok", sha=digest, w=meta.get("width"),
                h=meta.get("height"), source=meta.get("source"),
                below_floor=meta.get("below_min_size", False)))

    by_sha = defaultdict(set)     # sha -> set of album tags
    by_album = defaultdict(set)   # album tag -> set of shas
    for r in records:
        if r["status"] != "ok":
            continue
        by_sha[r["sha"]].add(r["album"])
        if r["album"]:
            by_album[r["album"]].add(r["sha"])

    findings = []
    for r in records:
        if r["status"] == "none":
            findings.append({**r, "flags": ["no-artwork"]})
            continue
        flags = []
        if len(by_sha[r["sha"]]) >= 2:
            flags.append("A:same-image-multiple-albums")
        if r["album"] and len(by_album[r["album"]]) >= 2:
            flags.append("B:album-has-multiple-images")
        if r["w"] and r["h"]:
            ratio = max(r["w"], r["h"]) / min(r["w"], r["h"])
            if ratio > 1.05:
                flags.append("C:non-square")
        if r["below_floor"]:
            flags.append("D:below-floor")
        if flags:
            findings.append({**r, "flags": flags})

    with open(args.out, "w") as f:
        for fi in findings:
            f.write(json.dumps(fi, ensure_ascii=False) + "\n")

    total_ok = sum(1 for r in records if r["status"] == "ok")
    counts = defaultdict(int)
    for fi in findings:
        for fl in fi.get("flags", []):
            counts[fl.split(":")[0]] += 1
    print(f"audited {total_ok}/{len(records)} tracks with artwork")
    print(f"A same-image-across-albums : {counts['A']}")
    print(f"B album-with-multiple-imgs : {counts['B']}")
    print(f"C non-square               : {counts['C']}")
    print(f"D below-floor              : {counts['D']}")
    print(f"no-artwork                 : {counts['no-artwork'] if 'no-artwork' in counts else 0}")
    print(f"report: {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
