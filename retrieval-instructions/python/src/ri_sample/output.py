"""Text output helpers. stdout carries results only; progress lines and errors go to stderr."""

from __future__ import annotations

import json
import sys
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from typing import Any

TRACE_KEYS = ("step", "status", "message", "appliedInstruction")


def table(rows: Sequence[Sequence[str]], indent: str = "  ") -> list[str]:
    """Rows (header first) as lines: columns two spaces apart, each left-aligned to its longest cell."""
    if not rows:
        return []
    widths = [max(len(row[i]) for row in rows) for i in range(len(rows[0]))]
    return [
        (indent + "  ".join(cell.ljust(width) for cell, width in zip(row, widths, strict=True))).rstrip()
        for row in rows
    ]


def dumps_compact(attributes: Mapping[str, Any]) -> str:
    """One trace event as a single JSON line, keys in a fixed order, non-ASCII kept readable."""
    return json.dumps({key: attributes[key] for key in TRACE_KEYS if key in attributes}, ensure_ascii=False)


def utc(value: datetime) -> str:
    """UTC ISO 8601 with second precision and Z, for example 2026-10-01T12:00:00Z."""
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def versions_text(versions: Sequence[str] | None) -> str:
    """Versions as `1, 2`, `none` for an empty list, `-` when unknown."""
    if versions is None:
        return "-"
    return ", ".join(versions) if versions else "none"


def plural(count: int, word: str) -> str:
    return f"{count} {word}" if count == 1 else f"{count} {word}s"


def out(text: str) -> None:
    """Write result text to stdout (text already ends with a newline)."""
    sys.stdout.write(text)
    sys.stdout.flush()


def progress(message: str) -> None:
    """Write one progress line to stderr."""
    print(message, file=sys.stderr, flush=True)
