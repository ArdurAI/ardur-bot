#!/usr/bin/env python3
"""Fail when a rendered page links to GitHub for a file the /docs/ mirror already hosts."""

from __future__ import annotations

import argparse
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlparse

REPO_HOST = "github.com"
REPO_PATH = "/ArdurAI/ardur-bot"
ROOT_DOCS = {"README.md", "CONTRIBUTING.md", "SECURITY.md", "VISION.md"}


class Anchor:
    def __init__(self, href: str, text: str, path: Path) -> None:
        self.href = href
        self.text = " ".join(text.split())
        self.path = path


class AnchorParser(HTMLParser):
    def __init__(self, path: Path) -> None:
        super().__init__(convert_charrefs=True)
        self.path = path
        self.anchors: list[Anchor] = []
        self._href_stack: list[str | None] = []
        self._text_stack: list[list[str]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag != "a":
            return
        href = next((value for name, value in attrs if name == "href"), None)
        self._href_stack.append(href)
        self._text_stack.append([])

    def handle_data(self, data: str) -> None:
        if self._text_stack:
            self._text_stack[-1].append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag != "a" or not self._href_stack:
            return
        href = self._href_stack.pop()
        text = "".join(self._text_stack.pop())
        if href:
            self.anchors.append(Anchor(href, text, self.path))


def repo_markdown_target(href: str) -> str | None:
    parsed = urlparse(href)
    if parsed.netloc != REPO_HOST:
        return None
    path = unquote(parsed.path)
    prefix = f"{REPO_PATH}/blob/"
    if not path.startswith(prefix):
        return None
    remainder = path[len(prefix):]
    parts = remainder.split("/", 1)
    if len(parts) != 2:
        return None
    target = parts[1]
    return target if target.lower().endswith(".md") else None


def is_mirrored_doc(target: str) -> bool:
    # sync_docs.py leaves decision records on GitHub, so links to them are expected there.
    if target.startswith("docs/decisions/"):
        return False
    return target in ROOT_DOCS or target.startswith("docs/")


def is_allowed_provenance_link(anchor: Anchor) -> bool:
    return anchor.text.startswith("Source:")


def validate(rendered_root: Path) -> list[str]:
    """Only the /docs/ mirror itself must stay internally linked: a doc page that cites
    another mirrored doc should point at its site page, not bounce the reader to GitHub.
    Hand-written pages elsewhere (status, benchmarks, about, ...) intentionally cite GitHub
    at a pinned commit, since they are evidence pages, not part of the mirror."""
    failures: list[str] = []
    docs_root = rendered_root / "docs"
    if not docs_root.exists():
        return failures
    for html_path in sorted(docs_root.rglob("*.html")):
        parser = AnchorParser(html_path)
        parser.feed(html_path.read_text(encoding="utf-8"))
        for anchor in parser.anchors:
            target = repo_markdown_target(anchor.href)
            if not target or not is_mirrored_doc(target):
                continue
            if is_allowed_provenance_link(anchor):
                continue
            failures.append(
                f"{html_path}: links to GitHub for {target!r} (text {anchor.text!r}), "
                "but this file is already mirrored under /docs/"
            )
    return failures


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("rendered_root", nargs="?", default="site/public")
    args = parser.parse_args()
    rendered_root = Path(args.rendered_root).resolve()
    if not rendered_root.exists():
        print(f"rendered docs link validation failed: missing {rendered_root}", file=sys.stderr)
        return 1

    failures = validate(rendered_root)
    if failures:
        for failure in failures:
            print(f"rendered docs link validation failed: {failure}", file=sys.stderr)
        return 1
    print("validated rendered documentation links")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
