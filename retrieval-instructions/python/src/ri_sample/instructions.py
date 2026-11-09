"""Create, version, update, and delete the sample's retrieval instructions.

Every update, tag, or delete of an existing instruction first passes the sample instruction guard: the name
is one of the 11 names derived from the spec files, and the instruction carries
app=retrieval-instructions-sample.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from botocore.exceptions import ClientError

from ri_sample.errors import CheckFailed, UsageError, aws_error, error_code
from ri_sample.output import progress
from ri_sample.poll import IN_PROGRESS, Review, reasons, wait_for_review
from ri_sample.release import ReleaseConfig
from ri_sample.specs import SAMPLE_APP, SAMPLE_TAG_KEY, Spec, instruction_name, known_names
from ri_sample.state import InstructionEntry, State, add_version, put_instruction, remove_instruction, set_release

NOT_FOUND = "ResourceNotFoundException"
DELETE_CONFIRM_TIMEOUT_S = 60.0
NAME_EXISTS = (
    "an instruction named {name} already exists in this Region. If an earlier run of this sample created it, "
    "run teardown --yes and then create-instructions again; otherwise delete or rename it"
)
QUOTA_HINT = "run teardown --yes to remove what this run created, or raise the retrieval instruction quota"

Save = Callable[[State], None]


def list_instructions(agent: Any) -> list[dict[str, Any]]:
    """Every retrieval instruction summary in the account and Region (ListRetrievalInstructions, paginated)."""
    summaries: list[dict[str, Any]] = []
    kwargs: dict[str, Any] = {"maxResults": 50}
    while True:
        page = agent.list_retrieval_instructions(**kwargs)
        summaries.extend(page.get("retrievalInstructionSummaries", []))
        if not page.get("nextToken"):
            return summaries
        kwargs["nextToken"] = page["nextToken"]


def list_versions(agent: Any, instruction_id: str) -> list[str]:
    """Numbered versions, ascending."""
    versions: list[str] = []
    kwargs: dict[str, Any] = {"retrievalInstructionId": instruction_id}
    while True:
        page = agent.list_retrieval_instruction_versions(**kwargs)
        versions.extend(str(v["version"]) for v in page.get("retrievalInstructionVersionSummaries", []))
        if not page.get("nextToken"):
            return sorted({v for v in versions if v.isdigit()}, key=int)
        kwargs["nextToken"] = page["nextToken"]


def guard_reason(agent: Any, name: str, arn: str) -> str | None:
    """None when the instruction is a sample instruction, else why it isn't."""
    if name not in known_names():
        return f"{name} isn't one of this sample's instruction names"
    tags = agent.list_tags_for_resource(resourceArn=arn).get("tags", {})
    if tags.get(SAMPLE_TAG_KEY) != SAMPLE_APP:
        return f"not tagged {SAMPLE_TAG_KEY}={SAMPLE_APP}"
    return None


def require_sample(agent: Any, name: str, arn: str) -> None:
    reason = guard_reason(agent, name, arn)
    if reason:
        raise UsageError(f"refusing to change {name}: {reason}")


def check_review(review: Review, name: str, success: str) -> None:
    """Exit 1 with each reason unless the review ended ACTIVE with `success`."""
    if review.timed_out:
        raise CheckFailed(f"{name}: review still running after 600 s; run the command again later")
    if review.status != "ACTIVE" or review.transition != success:
        lines = [f"{name}: review ended {review.status} ({review.transition})", *reasons(review.final)]
        raise CheckFailed("\n  ".join(lines))


def create_and_pin(
    agent: Any,
    tenant: str,
    instruction: dict[str, str],
    description: str,
    record: Callable[[str, str], None],
    wait: Callable[[Any, str], Review] = wait_for_review,
) -> str:
    """Create the instruction, wait for the review, and create the version to pin. Returns the version."""
    created = agent.create_retrieval_instruction(
        name=instruction_name(tenant),
        instruction=instruction,  # persona, answerFormat, retrievalGuidance, answerPolicy
        description=description,
        tags={"tenant": tenant, "app": "retrieval-instructions-sample"},  # IAM conditions use both tags
    )
    instruction_id = created["retrievalInstructionId"]
    record(instruction_id, created["retrievalInstructionArn"])  # recorded at once: it counts toward the quota
    check_review(wait(agent, instruction_id), instruction_name(tenant), "CREATE_SUCCESSFUL")
    version = agent.create_retrieval_instruction_version(retrievalInstructionId=instruction_id)["version"]
    return str(version)


def update_answer_format(
    agent: Any, instruction_id: str, answer_format: str, wait: Callable[[Any, str], Review] = wait_for_review
) -> str:
    """Replace answerFormat, resending every other field and the description, then create a version."""
    current = agent.get_retrieval_instruction(retrievalInstructionId=instruction_id)
    if not current.get("description"):
        raise UsageError(f"{current.get('name')} has no description; an update must resend it")
    agent.update_retrieval_instruction(
        retrievalInstructionId=instruction_id,
        instruction={**current["instruction"], "answerFormat": answer_format},
        description=current["description"],
    )
    check_review(wait(agent, instruction_id), str(current.get("name")), "UPDATE_SUCCESSFUL")
    version = agent.create_retrieval_instruction_version(retrievalInstructionId=instruction_id)["version"]
    return str(version)


@dataclass
class CreateOutcome:
    key: str
    name: str
    id: str
    result: str  # created, already created, recovered, versions recorded, or version created
    versions: list[str]
    live: str | None


def _pin_live(state: State, key: str) -> None:
    entry = state.instructions[key]
    if key not in state.release and entry.latest:
        set_release(state, key, ReleaseConfig(live=entry.latest))


def _outcome(state: State, key: str, result: str) -> CreateOutcome:
    entry = state.instructions[key]
    cfg = state.release.get(key)
    return CreateOutcome(key, entry.name, entry.id, result, list(entry.versions), cfg.live if cfg else None)


def quota_check(listed: list[dict[str, Any]], state: State, specs: list[Spec], quota: int) -> int:
    """The name check and the quota guard, both before anything is created. Returns the number to create."""
    recorded = {key: entry.id for key, entry in state.instructions.items()}
    ids = {s["retrievalInstructionId"] for s in listed}
    names = {s["name"] for s in listed}
    for spec in specs:
        if spec.name in names and spec.key not in recorded:
            raise UsageError(NAME_EXISTS.format(name=spec.name))
    needed = sum(1 for spec in specs if recorded.get(spec.key) not in ids)
    if len(listed) + needed > quota:
        raise UsageError(
            f"{len(listed)} of {quota} retrieval instructions are in use in this Region and this run needs "
            f"{needed} more; free {len(listed) + needed - quota} or pass --quota if your quota is higher"
        )
    return needed


def _existing(
    agent: Any, state: State, spec: Spec, save: Save, wait: Callable[..., Review], created_by: str
) -> CreateOutcome | None:
    """Steps for a key already in the state file. None when the instruction is gone and must be created."""
    entry = state.instructions[spec.key]
    try:
        got = agent.get_retrieval_instruction(retrievalInstructionId=entry.id)
    except ClientError as err:
        if error_code(err) != NOT_FOUND:
            raise aws_error(err) from err
        remove_instruction(state, spec.key)
        save(state)
        return None
    require_sample(agent, str(got["name"]), entry.arn)
    if got.get("lastTransitionStatus") in IN_PROGRESS:
        review = wait(agent, entry.id, first=got)
        if review.timed_out:
            raise CheckFailed(f"{spec.name}: review still running after 600 s; run the command again later")
        got = review.final
    status, transition = got.get("status"), got.get("lastTransitionStatus")
    if status == "ACTIVE" and entry.versions:
        progress(f"{spec.name} already created")
        return _outcome(state, spec.key, "already created")
    if status == "ACTIVE":
        found = list_versions(agent, entry.id)
        result = "versions recorded"
        if not found:
            found = [str(agent.create_retrieval_instruction_version(retrievalInstructionId=entry.id)["version"])]
            result = "version created"
        for version in found:
            add_version(state, spec.key, version)
        _pin_live(state, spec.key)
        save(state)
        return _outcome(state, spec.key, result)
    if status == "INACTIVE" and transition in ("CREATE_FAILED", "UPDATE_FAILED"):
        progress(f"{spec.name}: review had failed; updating it with the current spec")
        agent.update_retrieval_instruction(
            retrievalInstructionId=entry.id, instruction=spec.instruction, description=spec.description
        )
        check_review(wait(agent, entry.id), spec.name, "UPDATE_SUCCESSFUL")
        version = agent.create_retrieval_instruction_version(retrievalInstructionId=entry.id)["version"]
        add_version(state, spec.key, str(version))
        _pin_live(state, spec.key)
        save(state)
        return _outcome(state, spec.key, "recovered")
    raise CheckFailed(f"{spec.name} is {status} ({transition}); check it with status")


def create_instructions(
    agent: Any,
    state: State,
    specs: list[Spec],
    outcomes: list[CreateOutcome],
    save: Save,
    created_by: str = "python",
    wait: Callable[..., Review] = wait_for_review,
) -> None:
    """The per-key algorithm, after `quota_check`. Appends to `outcomes` as it goes; stops at the first failure."""
    for spec in specs:
        if spec.key in state.instructions:
            outcome = _existing(agent, state, spec, save, wait, created_by)
            if outcome is not None:
                outcomes.append(outcome)
                continue

        def record(instruction_id: str, arn: str, key: str = spec.key, name: str = spec.name) -> None:
            put_instruction(state, key, InstructionEntry(name, instruction_id, arn, [], created_by))
            save(state)

        progress(f"creating {spec.name}")
        try:
            version = create_and_pin(agent, spec.key, spec.instruction, spec.description, record, wait)
        except ClientError as err:
            code = error_code(err)
            if code == "ConflictException":
                raise aws_error(err, NAME_EXISTS.format(name=spec.name)) from err
            if code == "ServiceQuotaExceededException":
                raise aws_error(err, QUOTA_HINT) from err
            raise aws_error(err) from err
        add_version(state, spec.key, version)
        _pin_live(state, spec.key)
        save(state)
        outcomes.append(_outcome(state, spec.key, "created"))


def support_v2(
    agent: Any, state: State, key: str, answer_format: str, save: Save, wait: Callable[..., Review] = wait_for_review
) -> str:
    """Update one tenant's answerFormat, record the new version, and leave every release pin as it is."""
    entry = state.instructions.get(key)
    if entry is None or not entry.versions:
        raise UsageError(f"no instruction for {key} in sample-state.json; run create-instructions first")
    try:
        got = agent.get_retrieval_instruction(retrievalInstructionId=entry.id)
        require_sample(agent, str(got["name"]), entry.arn)
        version = update_answer_format(agent, entry.id, answer_format, wait)
    except ClientError as err:
        raise aws_error(err) from err
    add_version(state, key, version)
    save(state)
    return version


@dataclass
class Candidate:
    key: str | None  # state-file key, or None for an instruction found only by name
    name: str
    id: str
    arn: str
    versions: list[str] | None = None  # newest first; None when unknown
    action: str = "delete"  # delete, already deleted, or skip
    reason: str | None = None  # why it is skipped
    review: dict[str, Any] | None = None  # the GetRetrievalInstruction response


def candidates(agent: Any, state: State | None) -> list[Candidate]:
    """State-file entries, then listed instructions with a sample name that the state file doesn't hold."""
    found = [Candidate(key, e.name, e.id, e.arn) for key, e in (state.instructions.items() if state else [])]
    recorded = {c.id for c in found}
    names = known_names()
    for summary in list_instructions(agent):
        if summary["name"] in names and summary["retrievalInstructionId"] not in recorded:
            found.append(
                Candidate(None, summary["name"], summary["retrievalInstructionId"], summary["retrievalInstructionArn"])
            )
    return found


def inspect(agent: Any, cand: Candidate) -> Candidate:
    """Fill in versions and the action. A missing recorded instruction is `already deleted`."""
    try:
        cand.review = agent.get_retrieval_instruction(retrievalInstructionId=cand.id)
        reason = guard_reason(agent, cand.name, cand.arn)
        if reason:
            cand.action, cand.reason = "skip", reason
            return cand
        cand.versions = list(reversed(list_versions(agent, cand.id)))
    except ClientError as err:
        if error_code(err) == NOT_FOUND:
            cand.action = "already deleted"
            return cand
        raise aws_error(err) from err
    cand.action = "delete"
    return cand


def delete(
    agent: Any,
    cand: Candidate,
    wait: Callable[..., Review] = wait_for_review,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> str:
    """Delete versions newest first, then the instruction, and confirm it is gone.

    Returns `deleted`, `already deleted`, or `unconfirmed`.
    """
    try:
        if cand.review and cand.review.get("lastTransitionStatus") in IN_PROGRESS:
            wait(agent, cand.id, first=cand.review)
        for version in cand.versions or []:
            agent.delete_retrieval_instruction(retrievalInstructionId=cand.id, retrievalInstructionVersion=version)
        agent.delete_retrieval_instruction(retrievalInstructionId=cand.id)
    except ClientError as err:
        if error_code(err) == NOT_FOUND:
            return "already deleted"
        raise aws_error(err) from err
    start = clock()
    while clock() - start < DELETE_CONFIRM_TIMEOUT_S:
        try:
            agent.get_retrieval_instruction(retrievalInstructionId=cand.id)
        except ClientError as err:
            if error_code(err) == NOT_FOUND:
                return "deleted"
            raise aws_error(err) from err
        sleep(2.0)
    return "unconfirmed"
