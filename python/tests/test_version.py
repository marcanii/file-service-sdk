"""La versión del paquete tiene una sola fuente (`_version.py`) y coincide con `pyproject.toml`."""

import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from ntropix_file_service import __version__  # noqa: E402
from ntropix_file_service.client import _USER_AGENT  # noqa: E402


class VersionTest(unittest.TestCase):
    def test_pyproject_coincide_con_el_paquete(self) -> None:
        m = re.search(r'^version = "([^"]+)"', (ROOT / "pyproject.toml").read_text(), re.M)
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), __version__)

    def test_user_agent_usa_la_version(self) -> None:
        self.assertTrue(_USER_AGENT.endswith("/" + __version__))


if __name__ == "__main__":
    unittest.main()
