"""Paths inside the pattern directory, resolved from this file so commands work from any directory."""

from pathlib import Path

# python/src/ri_sample/paths.py -> the pattern root
PATTERN_ROOT = Path(__file__).resolve().parents[3]
INSTRUCTIONS_DIR = PATTERN_ROOT / "instructions"
MANIFEST_FILE = PATTERN_ROOT / "corpus" / "manifest.json"
STATE_FILE = PATTERN_ROOT / "sample-state.json"
