#!/usr/bin/env python3
"""Fail if the product name is hard-coded in site content or layouts.

The product name lives in exactly one place: params.productName in site/hugo.yaml.
Templates must read {{ .Site.Params.productName }} and content must use the
{{< product >}} shortcode, so a rename is a one-line change. The mirrored docs
corpus (site/content/docs/) is exempt: it is verbatim repository text, sourced
from files outside this script's control, and a rename there happens by editing
the repository docs, then re-running sync_docs.py.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SITE_ROOT = REPO_ROOT / "site"
CONTENT_ROOT = SITE_ROOT / "content"
LAYOUTS_ROOT = SITE_ROOT / "layouts"
DOCS_MIRROR_ROOT = CONTENT_ROOT / "docs"

PRODUCT_NAME_RE = re.compile(r"\bArdur\s+Bot\b")


def scan(root: Path, exempt: Path | None = None) -> list[str]:
    failures: list[str] = []
    if not root.exists():
        return failures
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        if exempt is not None and (path == exempt or exempt in path.parents):
            continue
        text = path.read_text(encoding="utf-8")
        for lineno, line in enumerate(text.splitlines(), start=1):
            if PRODUCT_NAME_RE.search(line):
                failures.append(f"{path.relative_to(REPO_ROOT)}:{lineno}: hard-coded product name: {line.strip()[:120]!r}")
    return failures


def main() -> int:
    failures = scan(CONTENT_ROOT, exempt=DOCS_MIRROR_ROOT)
    failures.extend(scan(LAYOUTS_ROOT))

    if failures:
        for failure in failures:
            print(f"hard-coded-name check failed: {failure}", file=sys.stderr)
        print('Use the {{< product >}} shortcode in content, or {{ .Site.Params.productName }} in layouts.', file=sys.stderr)
        return 1

    print("validated no hard-coded product name in site/content or site/layouts")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
