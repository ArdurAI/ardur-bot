"""Managed and checkout installs both have to match a reviewed table entry."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import hermes_launcher
from hermes_launcher import PIN, TREE


def table_with(sources: dict[str, str], pin: str = PIN, tree: str = TREE) -> dict:
    base = json.loads((Path(__file__).resolve().parents[1] / "hermes_compat.json").read_text())
    for key, entry in base["entries"].items():
        entry["sources"] = dict(sources)
        entry["commit"] = pin
        entry["tree"] = tree
        base["entries"] = {tree: entry}
        return base
    raise AssertionError("table has no entries")


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        base = Path(self.temporary.name)
        self.root = base / "install"
        self.home = base / "home"
        self.root.mkdir()
        self.home.mkdir()
        bindir = self.root / ".venv" / "bin"
        bindir.mkdir(parents=True)
        (bindir / "python").symlink_to(Path(sys.executable).resolve())
        (self.root / "hello.txt").write_bytes(b"hello")
        self.digest = hashlib.sha256(b"hello").hexdigest()

    def marker(self, pin: str = PIN, tree: str = TREE) -> None:
        (self.root / ".ardur-install.json").write_text(
            json.dumps({
                "pin": pin,
                "tree": tree,
                "uv": "0.12.19",
                "python": "3.13.2",
                "installedAt": "2026-01-01T00:00:00.000Z",
            }),
            encoding="utf-8",
        )

    def check(self, sources: dict[str, str] | None = None, pin: str = PIN, tree: str = TREE) -> None:
        mapped = {"hello.txt": self.digest} if sources is None else sources
        with patch.object(hermes_launcher, "COMPAT", table_with(mapped, pin, tree)):
            hermes_launcher.check_install(self.root, self.home)

    def test_marker_accepted_without_git(self):
        self.marker()
        self.check()

    def test_git_checkout_accepted(self):
        (self.root / ".git").mkdir()
        seen = {}

        def fake_run(args, **kwargs):
            seen["args"] = args
            return SimpleNamespace(stdout=PIN + "\n", returncode=0)

        with patch.object(hermes_launcher.subprocess, "run", side_effect=fake_run):
            self.check()
        self.assertEqual(seen["args"], ["git", "-C", str(self.root), "rev-parse", "HEAD"])

    def test_wrong_pin_refused(self):
        self.marker(pin="0" * 40)
        with self.assertRaises(RuntimeError):
            self.check()

    def test_wrong_tree_refused(self):
        self.marker(tree="0" * 40)
        with self.assertRaises(RuntimeError):
            self.check()

    def test_unknown_tree_refused_with_the_same_message(self):
        self.marker(tree="0" * 40)
        with patch.object(hermes_launcher, "COMPAT", table_with({"hello.txt": self.digest})):
            with self.assertRaises(RuntimeError) as caught:
                hermes_launcher.check_install(self.root, self.home)
        self.assertEqual(str(caught.exception), "Install marker mismatch")

    def test_git_unknown_commit_refused_with_the_same_message(self):
        (self.root / ".git").mkdir()
        self.marker()

        def fake_run(args, **kwargs):
            return SimpleNamespace(stdout="f" * 40 + "\n", returncode=0)

        with patch.object(hermes_launcher.subprocess, "run", side_effect=fake_run):
            with patch.object(hermes_launcher, "COMPAT", table_with({"hello.txt": self.digest})):
                with self.assertRaises(RuntimeError) as caught:
                    hermes_launcher.check_install(self.root, self.home)
        self.assertEqual(str(caught.exception), "Install revision changed")

    def test_git_wrong_head_refused_even_with_a_matching_marker(self):
        (self.root / ".git").write_text("gitdir: /unused\n", encoding="utf-8")
        self.marker()

        def fake_run(args, **kwargs):
            return SimpleNamespace(stdout="f" * 40 + "\n", returncode=0)

        with patch.object(hermes_launcher.subprocess, "run", side_effect=fake_run):
            with self.assertRaises(RuntimeError):
                self.check()

    def test_source_hash_mismatch_refused_with_a_matching_marker(self):
        self.marker()
        with self.assertRaises(RuntimeError):
            self.check({"hello.txt": "0" * 64})


if __name__ == "__main__":
    unittest.main()
