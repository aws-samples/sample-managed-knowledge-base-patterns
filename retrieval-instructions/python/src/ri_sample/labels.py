"""Sales region labels and the tenant line placed before each question."""

from __future__ import annotations

REGION_LABELS = {
    "sales-region-north": "Sales Region North",
    "sales-region-central": "Sales Region Central",
    "sales-region-south": "Sales Region South",
}


def region_label(region: str) -> str:
    """The label the corpus uses for a region key, for example `Sales Region Central`."""
    return REGION_LABELS[region]


def tenant_line(region: str) -> str:
    """The tenant context on its own line before the user's question."""
    return f"Customer sales region: {region_label(region)}."
