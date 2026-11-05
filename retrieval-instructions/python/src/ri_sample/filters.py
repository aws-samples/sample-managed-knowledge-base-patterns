"""Tenant entitlements and the metadata filters that express them.

Each document's metadata has `region` (global or sales-region-*), `audience_team` (all or team-*), and
`sensitivity`. Filters use only `equals` inside `andAll` and `orAll`. Only tenancy.py builds request
filters from these functions; see SECURITY.md.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

REGIONS = ("sales-region-north", "sales-region-central", "sales-region-south")
TEAMS = ("team-support", "team-field-sales", "team-legal-compliance")


def parse_cell(tenant: str) -> tuple[str | None, str | None]:
    """Split a tenant key into (region, team). A combined key is `<region>.<team>`."""
    first, _, second = tenant.partition(".")
    region = first if first in REGIONS else None
    team_part = second or first
    team = team_part if team_part in TEAMS else None
    return region, team


def entitled(tenant: str, doc: Mapping[str, Any], region: str | None = None) -> bool:
    """Whether a tenant may see a document.

    region tenant  = region in {global, own}  and audience = all
    team tenant    = any region               and audience in {all, own team}
    team + region  = region in {global, own}  and audience in {all, own team}
    other keys     = any region               and audience = all (the structured JSON instruction)
    """
    cell_region, team = parse_cell(tenant)
    region = region or cell_region
    region_ok = doc.get("region") in ("global", region) if region else True
    audience_ok = doc.get("audience_team") in ("all", team) if team else doc.get("audience_team") == "all"
    return region_ok and audience_ok


# Build on the server from the authenticated tenant, never from user input.


def eq(key: str, value: str) -> dict[str, Any]:
    return {"equals": {"key": key, "value": value}}


def filter_for(region: str | None = None, team: str | None = None) -> dict[str, Any]:
    # Region tenant: global plus own region, audience "all".
    # Team tenant: any region, audience "all" plus own team.
    region_f = {"orAll": [eq("region", "global"), eq("region", region)]} if region else None
    audience_f = (
        {"orAll": [eq("audience_team", "all"), eq("audience_team", team)]} if team else eq("audience_team", "all")
    )
    return {"andAll": [audience_f, region_f]} if region_f else audience_f


def matches(f: Mapping[str, Any], doc: Mapping[str, Any]) -> bool:
    """Evaluate the equals, andAll, and orAll subset of a retrieval filter against document metadata."""
    if "equals" in f:
        return bool(doc.get(f["equals"]["key"]) == f["equals"]["value"])
    if "andAll" in f:
        return all(matches(g, doc) for g in f["andAll"])
    if "orAll" in f:
        return any(matches(g, doc) for g in f["orAll"])
    raise ValueError(f"unsupported filter operator: {sorted(f)}")


def describe_filter(f: Mapping[str, Any] | None) -> str:
    """`key = value`, `key in (v1, v2)` for an orAll on one key, and andAll parts joined with `; `."""
    if f is None:
        return "none"
    if "equals" in f:
        return f"{f['equals']['key']} = {f['equals']['value']}"
    if "orAll" in f:
        keys = {g.get("equals", {}).get("key") for g in f["orAll"]}
        if len(keys) != 1 or not all("equals" in g for g in f["orAll"]):
            raise ValueError("describe_filter supports orAll of equals on one key")
        values = ", ".join(str(g["equals"]["value"]) for g in f["orAll"])
        return f"{keys.pop()} in ({values})"
    if "andAll" in f:
        return "; ".join(describe_filter(g) for g in f["andAll"])
    raise ValueError(f"unsupported filter operator: {sorted(f)}")
