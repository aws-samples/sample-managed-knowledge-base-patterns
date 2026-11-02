from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest
from botocore.stub import Stubber

from support import stubbed


@pytest.fixture
def agent() -> Iterator[tuple[Any, Stubber]]:
    """A bedrock-agent client whose calls are checked against the botocore 1.43.118 model."""
    client, stubber = stubbed("bedrock-agent")
    with stubber:
        yield client, stubber
        stubber.assert_no_pending_responses()
