#!/usr/bin/env python3
"""Guard against unbacked marketing claims in the site's own hand-written copy.

Scans site/content, excluding the mirrored docs corpus (site/content/docs/), which is
verbatim repository text and not marketing copy. Two rules:

1. Comparative or superlative claims are refused everywhere except the benchmarks page,
   and there only inside a paragraph/list item that itself links to evidence.
2. Every status-page list item must carry at least one link to the repo file it claims.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SITE_ROOT = REPO_ROOT / "site"
CONTENT_ROOT = SITE_ROOT / "content"
DOCS_MIRROR_ROOT = CONTENT_ROOT / "docs"
BENCHMARKS_PAGE = CONTENT_ROOT / "benchmarks" / "_index.md"
STATUS_PAGE = CONTENT_ROOT / "status" / "_index.md"

BANNED_PATTERNS = [
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        r"\bfaster than\b",
        r"\bbetter than\b",
        r"\bbeats?\b",
        r"\bbest\b",
        r"\bmost\b",
        r"#1\b",
        r"\bworld'?s (?:best|first|only|leading)\b",
        r"\bleading\b",
        r"\bunmatched\b",
        r"\bsuperior to\b",
        r"\boutperforms?\b",
        r"\bmore powerful than\b",
    )
]

LINK_MARKER = re.compile(r"\]\(")


def content_files() -> list[Path]:
    return sorted(
        p
        for p in CONTENT_ROOT.rglob("*.md")
        if DOCS_MIRROR_ROOT not in p.parents
    )


def blocks_of(text: str) -> list[str]:
    """Blank-line-delimited paragraphs, further split so each '- ' list item is its own block."""
    blocks: list[str] = []
    current: list[str] = []

    def flush() -> None:
        if current:
            blocks.append("\n".join(current))
            current.clear()

    in_fence = False
    for line in text.splitlines():
        if line.strip().startswith("```"):
            in_fence = not in_fence
            current.append(line)
            continue
        if in_fence:
            current.append(line)
            continue
        if not line.strip():
            flush()
            continue
        if line.lstrip().startswith(("- ", "* ")) and current:
            flush()
        current.append(line)
    flush()
    return blocks


def check_claims(files: list[Path]) -> list[str]:
    failures: list[str] = []
    for path in files:
        text = path.read_text(encoding="utf-8")
        is_benchmarks = path == BENCHMARKS_PAGE
        for block in blocks_of(text):
            matches = [p.pattern for p in BANNED_PATTERNS if p.search(block)]
            if not matches:
                continue
            if is_benchmarks and LINK_MARKER.search(block):
                continue
            location = "benchmarks page without a linked-evidence entry" if is_benchmarks else "outside /benchmarks/"
            failures.append(
                f"{path.relative_to(REPO_ROOT)}: comparative/superlative language {matches} {location}: "
                f"{block.strip().splitlines()[0][:100]!r}"
            )
    return failures


def check_status_sources(status_page: Path) -> list[str]:
    if not status_page.exists():
        return [f"missing status page: {status_page.relative_to(REPO_ROOT)}"]
    failures: list[str] = []
    text = status_page.read_text(encoding="utf-8")
    for block in blocks_of(text):
        if not block.lstrip().startswith(("- ", "* ")):
            continue
        if not LINK_MARKER.search(block):
            failures.append(
                f"{status_page.relative_to(REPO_ROOT)}: status item has no source link: "
                f"{block.strip().splitlines()[0][:100]!r}"
            )
    return failures


def main() -> int:
    files = content_files()
    failures = check_claims(files)
    failures.extend(check_status_sources(STATUS_PAGE))

    if failures:
        for failure in failures:
            print(f"claims guard failed: {failure}", file=sys.stderr)
        return 1

    print(f"validated {len(files)} content files for unbacked claims")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
