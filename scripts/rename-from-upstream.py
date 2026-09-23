#!/usr/bin/env python3
"""Rename Rakazo identifiers to Ardur Bot across the tracked tree.

Ardur Bot is a fork of Rakazo (https://github.com/elie222/rakazo, Apache-2.0).
Upstream moves fast, so we keep our merges simple: `git merge upstream/main`,
run this script, review the diff, commit. The script is idempotent; the rules
are ordered specific-before-generic. Files listed in SKIP_FILES and paths under
SKIP_PREFIXES keep the upstream name on purpose (attribution, decisions).
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip())
SKIP_FILES = {
    "NOTICE", "README.md", "CONTRIBUTING.md", "CHANGELOG.md", "SECURITY.md",
    "scripts/rename-from-upstream.py",
}
SKIP_PREFIXES = ("docs/decisions/",)
BINARY_EXT = {
    ".png", ".jpg", ".jpeg", ".gif", ".ico", ".icns", ".webp", ".woff", ".woff2",
    ".ttf", ".otf", ".mp4", ".mov", ".pdf", ".zip", ".gz", ".jar", ".keystore", ".p12", ".dmg",
}

CONTENT_RULES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"([A-Za-z0-9._-]+)@rakazo\.com\b"), r"\1@ardur.ai"),
    (re.compile(r"https://(?:www\.)?rakazo\.com"), "https://bot.ardur.ai"),
    (re.compile(r"\brakazo\.com\b"), "bot.ardur.ai"),
    (re.compile(r"ghcr\.io/elie222/rakazo"), "ghcr.io/ardurai/ardur-bot"),
    (re.compile(r"elie222/rakazo"), "ardurai/ardur-bot"),
    (re.compile(r"dev\.rakazo\.desktop"), "ai.ardur.bot.desktop"),
    (re.compile(r"com\.rakazo\.app"), "ai.ardur.bot"),
    (re.compile(r"com\.rakazo\.notifications"), "ai.ardur.bot.notifications"),
    (re.compile(r"com/rakazo/notifications"), "ai/ardur/bot/notifications"),
    (re.compile(r"Rakazo\.icon"), "ArdurBot.icon"),
    (re.compile(r"Rakazo(?=[A-Za-z0-9_])"), "ArdurBot"),
    (re.compile(r"Rakazo"), "Ardur Bot"),
    (re.compile(r"RAKAZO"), "ARDURBOT"),
    (re.compile(r"rakazo"), "ardurbot"),
]
PATH_RULES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"com/rakazo/notifications"), "ai/ardur/bot/notifications"),
    (re.compile(r"Rakazo"), "ArdurBot"),
    (re.compile(r"RAKAZO"), "ARDURBOT"),
    (re.compile(r"rakazo"), "ardurbot"),
]


def apply(rules: list[tuple[re.Pattern[str], str]], text: str) -> str:
    for pattern, replacement in rules:
        text = pattern.sub(replacement, text)
    return text


def tracked_files() -> list[str]:
    out = subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT)
    return [p for p in out.decode().split("\0") if p]


def skip(rel: str) -> bool:
    return rel in SKIP_FILES or rel.startswith(SKIP_PREFIXES)


def rewrite_contents(paths: list[str]) -> int:
    changed = 0
    for rel in paths:
        if skip(rel) or Path(rel).suffix.lower() in BINARY_EXT:
            continue
        path = ROOT / rel
        if not path.is_file():
            continue
        raw = path.read_bytes()
        if b"\0" in raw[:8192]:
            continue
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            print(f"skip (not utf-8): {rel}", file=sys.stderr)
            continue
        new = apply(CONTENT_RULES, text)
        if new != text:
            path.write_bytes(new.encode("utf-8"))
            changed += 1
    return changed


def move_paths(paths: list[str]) -> int:
    moved = 0
    for rel in paths:
        if skip(rel):
            continue
        new = apply(PATH_RULES, rel)
        if new == rel:
            continue
        (ROOT / new).parent.mkdir(parents=True, exist_ok=True)
        subprocess.check_call(["git", "mv", "-k", rel, new], cwd=ROOT)
        moved += 1
    return moved


def main() -> None:
    paths = tracked_files()
    changed = rewrite_contents(paths)
    moved = move_paths(paths)
    print(f"rewrote {changed} files, moved {moved} paths")
    residual = subprocess.run(
        ["git", "grep", "-il", "rakazo", "--", ".", *[f":!{p}" for p in SKIP_FILES], *[f":!{p}*" for p in SKIP_PREFIXES]],
        cwd=ROOT, capture_output=True, text=True,
    )
    left = [p for p in residual.stdout.split("\n") if p]
    if left:
        print("still mention rakazo:\n  " + "\n  ".join(left))


if __name__ == "__main__":
    main()
