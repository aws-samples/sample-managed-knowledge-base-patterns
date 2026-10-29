"""Make the Lambda handler modules importable by their deployed names."""

import sys
from pathlib import Path

FUNCTIONS_DIR = Path(__file__).resolve().parent.parent
for name in ("demo_user_password", "interceptor", "pre_token_generation"):
    path = str(FUNCTIONS_DIR / name)
    if path not in sys.path:
        sys.path.insert(0, path)
