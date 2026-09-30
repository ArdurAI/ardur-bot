"""The Python and TypeScript validators must agree on every shared fixture.

`compat_fixtures.json` holds complete table documents: the valid ones must
be accepted and the invalid ones refused, identically, by both validators.
The TypeScript side runs the same fixtures in
`src/runtimes/hermes-compat.test.ts`.
"""

from __future__ import annotations

import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from hermes_launcher import validate_compat

FIXTURES = json.loads(
    (Path(__file__).resolve().parent / "compat_fixtures.json").read_text(encoding="utf-8")
)


class CompatFixtureTests(unittest.TestCase):
    def test_valid_tables_are_accepted(self):
        for index, table in enumerate(FIXTURES["valid"]):
            with self.subTest(valid=index):
                self.assertIs(validate_compat(table), table)

    def test_invalid_tables_are_refused(self):
        for case in FIXTURES["invalid"]:
            with self.subTest(invalid=case["name"]):
                with self.assertRaisesRegex(RuntimeError, "Compatibility table is invalid"):
                    validate_compat(case["table"])


if __name__ == "__main__":
    unittest.main()
