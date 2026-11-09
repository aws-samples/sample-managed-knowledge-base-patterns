"""Name, scope, and entitlement for each document a trace or result returns.

Every document resolves to an S3 key under docs/, which is looked up by `path` in corpus/manifest.json.
A document that can't be identified prints as `unknown` and counts as outside the entitlement (fail closed).
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

from ri_sample.filters import entitled
from ri_sample.paths import MANIFEST_FILE

EXPANSION_RE = re.compile(r"^Starting full document expansion for document: (s3://[^/\s]+/(\S+))$")
UNKNOWN = "unknown"


@dataclass(frozen=True)
class Document:
    key: str
    scope: str
    region: str
    audience_team: str

    @property
    def file_name(self) -> str:
        return self.key.rsplit("/", 1)[-1]


@dataclass(frozen=True)
class Classified:
    document: str  # file name, or "unknown"
    scope: str  # manifest scope, or "unknown"
    entitled: str  # "yes", "no", or "unknown"

    @property
    def outside(self) -> bool:
        return self.entitled != "yes"


@cache
def manifest(path: Path = MANIFEST_FILE) -> dict[str, Document]:
    docs = json.loads(path.read_text(encoding="utf-8"))["docs"]
    return {d["path"]: Document(d["path"], d["scope"], d["region"], d["audience_team"]) for d in docs}


def key_from_source_uri(uri: Any) -> str | None:
    """The S3 key from a `_source_uri`: the percent-decoded path from its first `docs/` segment."""
    if not isinstance(uri, str):
        return None
    parts = unquote(urlsplit(uri).path).split("/")
    if "docs" not in parts:
        return None
    return "/".join(parts[parts.index("docs") :])


def key_from_expansion_message(message: Any) -> str | None:
    """The S3 key named by a FullDocumentExpansion IN_PROGRESS message, or None when it doesn't match."""
    match = EXPANSION_RE.match(message) if isinstance(message, str) else None
    return match.group(2) if match else None


def classify(key: str | None, tenant: str, region: str | None = None) -> Classified:
    doc = manifest().get(key) if key else None
    if doc is None:
        return Classified(UNKNOWN, UNKNOWN, UNKNOWN)
    ok = entitled(tenant, {"region": doc.region, "audience_team": doc.audience_team}, region)
    return Classified(doc.file_name, doc.scope, "yes" if ok else "no")
