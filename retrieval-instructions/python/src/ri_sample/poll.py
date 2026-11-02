"""Wait for a retrieval instruction's content review. Boto3 has no waiter for this resource."""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from ri_sample.output import progress

IN_PROGRESS = frozenset({"CREATING", "UPDATING"})
INTERVAL_S = 2.0
TIMEOUT_S = 600.0


@dataclass(frozen=True)
class Review:
    final: dict[str, Any]  # the last GetRetrievalInstruction response
    elapsed_s: float
    timed_out: bool

    @property
    def status(self) -> str | None:
        return self.final.get("status")

    @property
    def transition(self) -> str | None:
        return self.final.get("lastTransitionStatus")


def wait_for_review(
    agent: Any,
    instruction_id: str,
    *,
    first: dict[str, Any] | None = None,
    timeout_s: float = TIMEOUT_S,
    interval_s: float = INTERVAL_S,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> Review:
    """Poll every `interval_s` until lastTransitionStatus is no longer CREATING or UPDATING, or time runs out."""
    start = clock()
    current = first or agent.get_retrieval_instruction(retrievalInstructionId=instruction_id)
    while True:
        elapsed = clock() - start
        if current.get("lastTransitionStatus") not in IN_PROGRESS:
            return Review(current, elapsed, False)
        if elapsed >= timeout_s:
            return Review(current, elapsed, True)
        progress(f"waiting for review: {current.get('lastTransitionStatus')}, {int(elapsed)} s")
        sleep(interval_s)
        current = agent.get_retrieval_instruction(retrievalInstructionId=instruction_id)


def reasons(final: dict[str, Any]) -> list[str]:
    """Each review reason as `fieldName: code: message`."""
    return [
        ": ".join(str(r[k]) for k in ("fieldName", "code", "message") if r.get(k))
        for r in final.get("lastTransitionStatusReasons") or []
    ]
