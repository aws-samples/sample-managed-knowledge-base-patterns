"""Region labels and the tenant line, current labels only."""

from __future__ import annotations

import pytest

from ri_sample.labels import region_label, tenant_line


def test_region_labels() -> None:
    assert region_label("sales-region-north") == "Sales Region North"
    assert region_label("sales-region-central") == "Sales Region Central"
    assert region_label("sales-region-south") == "Sales Region South"


def test_tenant_line() -> None:
    assert tenant_line("sales-region-central") == "Customer sales region: Sales Region Central."


def test_unknown_region_has_no_label() -> None:
    with pytest.raises(KeyError):
        region_label("sales-region-1")
