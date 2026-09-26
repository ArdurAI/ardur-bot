#!/usr/bin/env python3
"""Generate the /docs/ section of the Hugo site from the repository's own Markdown.

Mirrors docs/**/*.md plus the four root docs (README, CONTRIBUTING, SECURITY, VISION)
into site/content/docs/. Run with --check in CI to fail when the mirror is stale.
"""

from __future__ import annotations

import argparse
import hashlib
import re
import sys
from pathlib import Path, PurePosixPath

REPO_ROOT = Path(__file__).resolve().parents[2]
SITE_ROOT = REPO_ROOT / "site"
CONTENT_DOCS_ROOT = SITE_ROOT / "content" / "docs"
STATIC_IMAGES_ROOT = SITE_ROOT / "static" / "docs-images"
REPO_URL = "https://github.com/ArdurAI/ardur-bot"
SOURCE_REF_PLACEHOLDER = "__ARDUR_BOT_SOURCE_REF__"

ROOT_DOCS = ["README.md", "CONTRIBUTING.md", "SECURITY.md", "VISION.md"]
ROOT_DOC_PATHS = {Path(name) for name in ROOT_DOCS}


def is_root_doc(source: Path) -> bool:
    return source in ROOT_DOC_PATHS

EXCLUDED_DIR_NAMES = {".git", "node_modules", "__pycache__", "private", "internal"}
EXCLUDED_NAME_SUBSTRINGS = ("generated", ".generated.")

LINK_RE = re.compile(r"(?<!!)\[([^\]]+)\]\(([^)\s]+)\)")
IMAGE_RE = re.compile(r"!\[([^\]]*)\]\(([^)\s]+)\)")
INLINE_CODE_RE = re.compile(r"`[^`]*`")
BARE_PLACEHOLDER_RE = re.compile(r"<([a-zA-Z][a-zA-Z0-9_./-]*)>")


def escape_bare_angle_placeholders(line: str) -> str:
    """Escape prose like '<reason>' so Goldmark does not treat it as an HTML tag
    and silently drop it. Leaves inline code spans (`` `<command>` ``) untouched,
    since those are never interpreted as HTML by a Markdown renderer."""
    spans: list[str] = []

    def stash(match: re.Match[str]) -> str:
        spans.append(match.group(0))
        return f"\x00{len(spans) - 1}\x00"

    protected = INLINE_CODE_RE.sub(stash, line)
    escaped = BARE_PLACEHOLDER_RE.sub(lambda m: f"&lt;{m.group(1)}&gt;", protected)
    return re.sub(r"\x00(\d+)\x00", lambda m: spans[int(m.group(1))], escaped)


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def is_private_or_generated(rel: Path) -> bool:
    for part in rel.parts:
        if part in EXCLUDED_DIR_NAMES or part.startswith("."):
            return True
    lowered = rel.name.lower()
    return any(marker in lowered for marker in EXCLUDED_NAME_SUBSTRINGS)


def discover_docs() -> list[Path]:
    paths: set[Path] = set()
    for name in ROOT_DOCS:
        candidate = REPO_ROOT / name
        if candidate.is_file():
            paths.add(Path(name))
    docs_dir = REPO_ROOT / "docs"
    if docs_dir.is_dir():
        for path in docs_dir.rglob("*.md"):
            rel = path.relative_to(REPO_ROOT)
            if not is_private_or_generated(rel):
                paths.add(rel)
    return sorted(paths, key=lambda p: p.as_posix())


def slug_for(source: Path) -> str:
    """The doc's route under /docs/, without the docs/ prefix or file extension."""
    if is_root_doc(source):
        return source.stem.lower()
    relative = source.relative_to("docs")
    return relative.with_suffix("").as_posix().lower()


def compute_routes(sources: list[Path]) -> tuple[dict[Path, str], dict[Path, str]]:
    """Return (markdown routes, directory routes), both relative to /docs/."""
    directories: set[Path] = set()
    for source in sources:
        if is_root_doc(source):
            continue
        relative = source.relative_to("docs")
        for parent in relative.parents:
            if parent != Path("."):
                directories.add(parent)
    directory_slugs = {d: d.as_posix().lower() for d in directories}
    directory_slug_set = set(directory_slugs.values())

    markdown_slugs: dict[Path, str] = {}
    for source in sources:
        slug = slug_for(source)
        if slug in directory_slug_set:
            slug = f"{slug}-guide"
        markdown_slugs[source] = slug
    return markdown_slugs, directory_slugs


def extract_title(text: str, source: Path) -> str:
    for line in text.splitlines():
        if line.startswith("# "):
            return line[2:].strip().strip("`")
    stem = source.parent.name if source.name.lower() == "readme.md" else source.stem
    return stem.replace("-", " ").replace("_", " ").title()


def strip_first_h1(text: str) -> str:
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if line.startswith("# "):
            return "\n".join(lines[:i] + lines[i + 1:]).lstrip()
    return text


def extract_description(text: str) -> str:
    in_fence = False
    for raw in strip_first_h1(text).splitlines():
        line = raw.strip()
        if line.startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence or not line:
            continue
        if line.startswith(("#", "-", "|", ">", "```")):
            continue
        return truncate_at_word(re.sub(r"\s+", " ", line), 180)
    return "Documentation mirrored from the repository."


def truncate_at_word(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    truncated = text[:limit].rsplit(" ", 1)[0]
    return f"{truncated}…"


def yaml_front_matter(fields: dict[str, str]) -> str:
    lines = ["---"]
    for key, value in fields.items():
        escaped = value.replace("\\", "\\\\").replace('"', '\\"')
        lines.append(f'{key}: "{escaped}"')
    lines.append("---")
    return "\n".join(lines)


def resolve_relative(source: Path, target: str) -> tuple[Path | None, str]:
    if "#" in target:
        target_path, fragment = target.split("#", 1)
        fragment = f"#{fragment}"
    else:
        target_path, fragment = target, ""
    if not target_path:
        return None, fragment
    base = Path(".") if target.startswith("/") else source.parent
    raw = target_path.lstrip("/") if target.startswith("/") else target_path
    normalized = PurePosixPath(base.as_posix()) / PurePosixPath(raw)
    parts: list[str] = []
    for part in normalized.parts:
        if part in ("", "."):
            continue
        if part == "..":
            if parts:
                parts.pop()
            continue
        parts.append(part)
    return Path(*parts) if parts else Path("."), fragment


def internal_href(repo_target: Path, fragment: str, markdown_slugs: dict[Path, str], directory_slugs: dict[Path, str]) -> str | None:
    candidates = [repo_target] if repo_target.suffix.lower() == ".md" else [repo_target / "README.md", repo_target.with_suffix(".md")]
    for candidate in candidates:
        if candidate in markdown_slugs:
            return f"/docs/{markdown_slugs[candidate]}/{fragment}"
    try:
        relative_to_docs = repo_target.relative_to("docs")
    except ValueError:
        relative_to_docs = None
    if relative_to_docs is not None and relative_to_docs in directory_slugs:
        return f"/docs/{directory_slugs[relative_to_docs]}/{fragment}"
    return None


def github_href(repo_target: Path, fragment: str) -> str:
    is_dir = (REPO_ROOT / repo_target).is_dir()
    mode = "tree" if is_dir else "blob"
    return f"{REPO_URL}/{mode}/{SOURCE_REF_PLACEHOLDER}/{repo_target.as_posix()}{fragment}"


def rewrite_body(text: str, source: Path, markdown_slugs: dict[Path, str], directory_slugs: dict[Path, str], copied_images: list[str]) -> str:
    lines: list[str] = []
    in_fence = False
    for raw in text.splitlines():
        if raw.strip().startswith("```"):
            in_fence = not in_fence
            lines.append(raw)
            continue
        if in_fence:
            lines.append(raw)
            continue

        raw = escape_bare_angle_placeholders(raw)

        def rewrite_image(match: re.Match[str]) -> str:
            alt, target = match.group(1), match.group(2)
            if target.startswith(("http://", "https://", "data:")):
                return match.group(0)
            repo_target, _ = resolve_relative(source, target)
            if repo_target is None or not (REPO_ROOT / repo_target).is_file():
                return match.group(0)
            dest = STATIC_IMAGES_ROOT / repo_target
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes((REPO_ROOT / repo_target).read_bytes())
            copied_images.append(repo_target.as_posix())
            return f"![{alt}](/docs-images/{repo_target.as_posix()})"

        def rewrite_link(match: re.Match[str]) -> str:
            label, target = match.group(1), match.group(2)
            if target.startswith(("http://", "https://", "mailto:", "#")):
                return match.group(0)
            repo_target, fragment = resolve_relative(source, target)
            if repo_target is None:
                return match.group(0)
            href = internal_href(repo_target, fragment, markdown_slugs, directory_slugs)
            if href is None:
                href = github_href(repo_target, fragment)
            return f"[{label}]({href})"

        raw = IMAGE_RE.sub(rewrite_image, raw)
        raw = LINK_RE.sub(rewrite_link, raw)
        lines.append(raw)
    return "\n".join(lines)


def render_doc_page(source: Path, markdown_slugs: dict[Path, str], directory_slugs: dict[Path, str], copied_images: list[str]) -> str:
    original = (REPO_ROOT / source).read_text(encoding="utf-8")
    title = extract_title(original, source)
    description = extract_description(original)
    fields = {
        "title": title,
        "description": description,
        "source_path": source.as_posix(),
    }
    source_note = (
        f"> [Source: {source.as_posix()}]({github_href(source, '')}). "
        "Edit the source file, then run `python3 site/scripts/sync_docs.py` to refresh this page."
    )
    body = rewrite_body(strip_first_h1(original), source, markdown_slugs, directory_slugs, copied_images)
    return f"{yaml_front_matter(fields)}\n\n{source_note}\n\n{body.rstrip()}\n"


def render_docs_index(sources: list[Path]) -> str:
    fields = {
        "title": "Docs",
        "description": "Documentation mirrored from the repository: README, CONTRIBUTING, SECURITY, VISION and everything under docs/.",
    }
    body = (
        f"This section mirrors {len(sources)} Markdown files from the repository. "
        "Each page links back to its exact source file. Edit the source, then run "
        "`python3 site/scripts/sync_docs.py` to refresh these pages."
    )
    return f"{yaml_front_matter(fields)}\n\n{body}\n"


def render_directory_index(directory: Path) -> str:
    title = directory.name.replace("-", " ").title()
    fields = {
        "title": title,
        "description": f"Documentation mirrored from docs/{directory.as_posix()}/.",
    }
    body = f"Pages mirrored from [`docs/{directory.as_posix()}/`]({github_href(Path('docs') / directory, '')})."
    return f"{yaml_front_matter(fields)}\n\n{body}\n"


def write_or_check(path: Path, expected: str, check: bool, failures: list[str]) -> None:
    if check:
        try:
            current = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            failures.append(f"missing generated file: {path.relative_to(REPO_ROOT)}")
            return
        if current != expected:
            failures.append(f"stale generated file: {path.relative_to(REPO_ROOT)}")
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(expected, encoding="utf-8")


def sync(check: bool) -> int:
    sources = discover_docs()
    markdown_slugs, directory_slugs = compute_routes(sources)
    failures: list[str] = []
    copied_images: list[str] = []

    expected_pages: set[Path] = {CONTENT_DOCS_ROOT / "_index.md"}
    for directory, slug in directory_slugs.items():
        expected_pages.add((CONTENT_DOCS_ROOT / slug / "_index.md"))
    for source, slug in markdown_slugs.items():
        expected_pages.add(CONTENT_DOCS_ROOT / slug / "index.md")

    write_or_check(CONTENT_DOCS_ROOT / "_index.md", render_docs_index(sources), check, failures)

    for directory, slug in sorted(directory_slugs.items(), key=lambda kv: kv[1]):
        output = CONTENT_DOCS_ROOT / slug / "_index.md"
        write_or_check(output, render_directory_index(directory), check, failures)

    for source, slug in sorted(markdown_slugs.items(), key=lambda kv: kv[1]):
        output = CONTENT_DOCS_ROOT / slug / "index.md"
        write_or_check(output, render_doc_page(source, markdown_slugs, directory_slugs, copied_images), check, failures)

    if CONTENT_DOCS_ROOT.exists():
        existing = {p for p in CONTENT_DOCS_ROOT.rglob("*.md") if p.is_file()}
        stale = sorted(existing - expected_pages)
        if check and stale:
            failures.extend(f"stale generated file should be removed: {p.relative_to(REPO_ROOT)}" for p in stale)
        elif not check:
            for path in stale:
                path.unlink()
            for directory in sorted(CONTENT_DOCS_ROOT.rglob("*"), reverse=True):
                if directory.is_dir() and not any(directory.iterdir()):
                    directory.rmdir()

    if STATIC_IMAGES_ROOT.exists():
        existing_images = {p for p in STATIC_IMAGES_ROOT.rglob("*") if p.is_file()}
        expected_images = {STATIC_IMAGES_ROOT / Path(name) for name in copied_images}
        stale_images = sorted(existing_images - expected_images)
        if check and stale_images:
            failures.extend(f"stale mirrored image should be removed: {p.relative_to(REPO_ROOT)}" for p in stale_images)
        elif not check:
            for path in stale_images:
                path.unlink()

    if failures:
        for failure in failures:
            print(f"doc sync failed: {failure}", file=sys.stderr)
        print("Run: python3 site/scripts/sync_docs.py", file=sys.stderr)
        return 1

    verb = "verified" if check else "generated"
    print(f"{verb} {len(sources)} mirrored doc pages")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="fail if the generated mirror is stale")
    args = parser.parse_args()
    return sync(check=args.check)


if __name__ == "__main__":
    raise SystemExit(main())
