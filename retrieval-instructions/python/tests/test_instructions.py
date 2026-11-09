"""Create, recover, update, and delete against a stubbed bedrock-agent client (the 1.43.118 model)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from botocore.stub import ANY, Stubber

from ri_sample import state as state_file
from ri_sample.errors import AwsError, CheckFailed, UsageError
from ri_sample.instructions import (
    Candidate,
    CreateOutcome,
    candidates,
    create_and_pin,
    create_instructions,
    delete,
    inspect,
    quota_check,
    update_answer_format,
)
from ri_sample.poll import Review, wait_for_review
from ri_sample.release import ReleaseConfig
from ri_sample.specs import Spec, spec_for
from ri_sample.state import InstructionEntry, State
from support import ACCOUNT, NOW, Clock, fixture, no_sleep, write_state

ID = "abcde12345"
ARN = f"arn:aws:bedrock:us-east-1:{ACCOUNT}:retrieval-instruction/{ID}"
NAME = "assistant-sales-region-north"
REASONS = [{"fieldName": "persona", "code": "CONTENT_FLAGGED", "message": "content flagged"}]
CONTENT = {"persona": "You are a demo assistant.", "answerFormat": "Two sentences."}
APP_TAGS = {"tags": {"tenant": "sales-region-north", "app": "retrieval-instructions-sample"}}


def north() -> Spec:
    spec = spec_for("sales-region-north")
    assert spec is not None
    return spec


def wait(agent: Any, instruction_id: str, first: dict[str, Any] | None = None) -> Review:
    return wait_for_review(agent, instruction_id, first=first, sleep=no_sleep, clock=Clock())


def described(status: str, transition: str, **extra: Any) -> dict[str, Any]:
    return {
        "retrievalInstructionId": ID,
        "retrievalInstructionArn": ARN,
        "name": NAME,
        "status": status,
        "lastTransitionStatus": transition,
        "createdAt": NOW,
        "updatedAt": NOW,
        **extra,
    }


def get(stubber: Stubber, status: str, transition: str, **extra: Any) -> None:
    stubber.add_response(
        "get_retrieval_instruction", described(status, transition, **extra), {"retrievalInstructionId": ID}
    )


def not_found(stubber: Stubber, method: str, params: dict[str, Any]) -> None:
    stubber.add_client_error(method, "ResourceNotFoundException", "gone", 404, expected_params=params)


def version(stubber: Stubber, v: str) -> None:
    stubber.add_response(
        "create_retrieval_instruction_version",
        {"retrievalInstructionId": ID, "retrievalInstructionArn": ARN, "version": v, "createdAt": NOW},
        {"retrievalInstructionId": ID},
    )


def tags(stubber: Stubber, values: dict[str, str] | None = None) -> None:
    stubber.add_response("list_tags_for_resource", {"tags": values or APP_TAGS["tags"]}, {"resourceArn": ARN})


def listed(stubber: Stubber, names: list[str], token: str | None = None, after: str | None = None) -> None:
    page: dict[str, Any] = {
        "retrievalInstructionSummaries": [
            {
                "retrievalInstructionId": f"id{i:08d}",
                "retrievalInstructionArn": f"{ARN[:-10]}id{i:08d}",
                "name": n,
                "status": "ACTIVE",
                "lastTransitionStatus": "CREATE_SUCCESSFUL",
                "createdAt": NOW,
                "updatedAt": NOW,
            }
            for i, n in enumerate(names)
        ]
    }
    if token:
        page["nextToken"] = token
    params: dict[str, Any] = {"maxResults": 50}
    if after:
        params["nextToken"] = after
    stubber.add_response("list_retrieval_instructions", page, params)


def recorded(versions: list[str] | None = None) -> State:
    s = State(ACCOUNT, "us-east-1")
    state_file.put_instruction(s, "sales-region-north", InstructionEntry(NAME, ID, ARN, versions or []))
    if versions:
        state_file.set_release(s, "sales-region-north", ReleaseConfig(live=versions[-1]))
    return s


def run_create(client: Any, s: State, specs: list[Spec] | None = None) -> list[CreateOutcome]:
    outcomes: list[CreateOutcome] = []
    saves: list[str] = []
    create_instructions(
        client, s, specs or [north()], outcomes, lambda st: saves.append(state_file.dumps(st)), wait=wait
    )
    return outcomes


def test_create_and_pin_records_waits_and_versions(agent: tuple[Any, Stubber]) -> None:
    client, stubber = agent
    params = {
        "name": NAME,
        "instruction": CONTENT,
        "description": "d",
        "tags": APP_TAGS["tags"],
    }
    stubber.add_response("create_retrieval_instruction", described("INACTIVE", "CREATING"), params)
    get(stubber, "INACTIVE", "CREATING")
    get(stubber, "ACTIVE", "CREATE_SUCCESSFUL")
    version(stubber, "1")
    records: list[tuple[str, str]] = []
    assert create_and_pin(client, "sales-region-north", CONTENT, "d", lambda i, a: records.append((i, a)), wait) == "1"
    assert records == [(ID, ARN)]


def test_a_failed_review_keeps_the_record_and_surfaces_reasons(agent: tuple[Any, Stubber]) -> None:
    client, stubber = agent
    stubber.add_response("create_retrieval_instruction", described("INACTIVE", "CREATING"), None)
    get(stubber, "INACTIVE", "CREATE_FAILED", lastTransitionStatusReasons=REASONS)
    s = State(ACCOUNT, "us-east-1")
    with pytest.raises(CheckFailed) as err:
        run_create(client, s)
    assert "persona: CONTENT_FLAGGED: content flagged" in err.value.message
    assert s.instructions["sales-region-north"].versions == []  # recorded for teardown and recovery
    assert "sales-region-north" not in s.release


def test_create_stops_at_the_first_failed_review(agent: tuple[Any, Stubber]) -> None:
    client, stubber = agent
    stubber.add_response("create_retrieval_instruction", described("INACTIVE", "CREATING"), None)
    get(stubber, "INACTIVE", "CREATE_FAILED")
    central = spec_for("sales-region-central")
    assert central is not None
    with pytest.raises(CheckFailed):
        run_create(client, State(ACCOUNT, "us-east-1"), [north(), central])  # no create for central is queued


def test_a_finished_key_is_skipped(agent: tuple[Any, Stubber]) -> None:
    client, stubber = agent
    get(stubber, "ACTIVE", "CREATE_SUCCESSFUL")
    tags(stubber)
    assert [o.result for o in run_create(client, recorded(["1"]))] == ["already created"]


def test_a_running_review_is_waited_out(agent: tuple[Any, Stubber]) -> None:
    client, stubber = agent
    get(stubber, "INACTIVE", "CREATING")
    tags(stubber)
    get(stubber, "ACTIVE", "CREATE_SUCCESSFUL")
    assert [o.result for o in run_create(client, recorded(["1"]))] == ["already created"]


def test_an_active_key_without_versions_records_them(agent: tuple[Any, Stubber]) -> None:
    client, stubber = agent
    get(stubber, "ACTIVE", "CREATE_SUCCESSFUL")
    tags(stubber)
    stubber.add_response(
        "list_retrieval_instruction_versions",
        {
            "retrievalInstructionVersionSummaries": [
                {"version": "2", "createdAt": NOW},
                {"version": "1", "createdAt": NOW},
            ]
        },
        {"retrievalInstructionId": ID},
    )
    s = recorded()
    [outcome] = run_create(client, s)
    assert (outcome.result, outcome.versions, outcome.live) == ("versions recorded", ["1", "2"], "2")


def test_an_active_key_with_no_versions_at_all_gets_version_1(agent: tuple[Any, Stubber]) -> None:
    client, stubber = agent
    get(stubber, "ACTIVE", "CREATE_SUCCESSFUL")
    tags(stubber)
    stubber.add_response(
        "list_retrieval_instruction_versions",
        {"retrievalInstructionVersionSummaries": []},
        {"retrievalInstructionId": ID},
    )
    version(stubber, "1")
    [outcome] = run_create(client, recorded())
    assert (outcome.result, outcome.live) == ("version created", "1")


def test_a_rejected_key_is_updated_in_place_with_the_current_spec(agent: tuple[Any, Stubber]) -> None:
    client, stubber = agent
    get(stubber, "INACTIVE", "CREATE_FAILED")
    tags(stubber)
    stubber.add_response(
        "update_retrieval_instruction",
        described("INACTIVE", "UPDATING"),
        {"retrievalInstructionId": ID, "instruction": north().instruction, "description": north().description},
    )
    get(stubber, "INACTIVE", "UPDATING")
    get(stubber, "ACTIVE", "UPDATE_SUCCESSFUL")
    version(stubber, "1")
    [outcome] = run_create(client, recorded())
    assert (outcome.result, outcome.versions, outcome.live) == ("recovered", ["1"], "1")


def test_a_second_failed_review_is_exit_1_and_keeps_the_key(agent: tuple[Any, Stubber]) -> None:
    client, stubber = agent
    get(stubber, "INACTIVE", "CREATE_FAILED")
    tags(stubber)
    stubber.add_response("update_retrieval_instruction", described("INACTIVE", "UPDATING"), None)
    get(stubber, "INACTIVE", "UPDATE_FAILED", lastTransitionStatusReasons=REASONS)
    s = recorded()
    with pytest.raises(CheckFailed) as err:
        run_create(client, s)
    assert err.value.exit_code == 1
    assert "sales-region-north" in s.instructions


def test_a_recorded_instruction_that_is_gone_is_created_again(agent: tuple[Any, Stubber]) -> None:
    client, stubber = agent
    not_found(stubber, "get_retrieval_instruction", {"retrievalInstructionId": ID})
    stubber.add_response("create_retrieval_instruction", described("ACTIVE", "CREATE_SUCCESSFUL"), None)
    get(stubber, "ACTIVE", "CREATE_SUCCESSFUL")
    version(stubber, "1")
    assert [o.result for o in run_create(client, recorded(["1"]))] == ["created"]


def test_a_wrong_tag_on_a_recorded_instruction_is_exit_2(agent: tuple[Any, Stubber]) -> None:
    client, stubber = agent
    get(stubber, "ACTIVE", "CREATE_SUCCESSFUL")
    tags(stubber, {"tenant": "sales-region-north"})
    with pytest.raises(UsageError, match="not tagged app=retrieval-instructions-sample"):
        run_create(client, recorded(["1"]))


def test_quota_errors_from_create_name_the_teardown(agent: tuple[Any, Stubber]) -> None:
    client, stubber = agent
    stubber.add_client_error("create_retrieval_instruction", "ServiceQuotaExceededException", "quota", 402)
    with pytest.raises(AwsError, match="teardown --yes"):
        run_create(client, State(ACCOUNT, "us-east-1"))


def test_a_listed_name_missing_from_the_state_file_is_exit_2_before_any_create() -> None:
    summaries = [{"retrievalInstructionId": "zzzzz00000", "name": NAME}]
    with pytest.raises(UsageError, match="already exists in this Region"):
        quota_check(summaries, State(ACCOUNT, "us-east-1"), [north()], 50)


@pytest.mark.parametrize(("count", "quota", "ok"), [(49, 50, True), (50, 50, False), (50, 60, True)])
def test_the_quota_guard_paginates_and_honors_the_quota(
    agent: tuple[Any, Stubber], count: int, quota: int, ok: bool
) -> None:
    from ri_sample.instructions import list_instructions

    client, stubber = agent
    names = [f"other-{i}" for i in range(count)]
    listed(stubber, names[:30], token="t")
    listed(stubber, names[30:], after="t")
    summaries = list_instructions(client)
    assert len(summaries) == count
    if ok:
        assert quota_check(summaries, State(ACCOUNT, "us-east-1"), [north()], quota) == 1
    else:
        with pytest.raises(UsageError, match="pass --quota"):
            quota_check(summaries, State(ACCOUNT, "us-east-1"), [north()], quota)


def test_update_resends_every_field_and_the_description(agent: tuple[Any, Stubber]) -> None:
    client, stubber = agent
    get(stubber, "ACTIVE", "CREATE_SUCCESSFUL", instruction=CONTENT, description="keep me")
    stubber.add_response(
        "update_retrieval_instruction",
        described("ACTIVE", "UPDATING"),
        {"retrievalInstructionId": ID, "instruction": {**CONTENT, "answerFormat": "New."}, "description": "keep me"},
    )
    get(stubber, "ACTIVE", "UPDATING")
    get(stubber, "ACTIVE", "UPDATE_SUCCESSFUL")
    version(stubber, "2")
    assert update_answer_format(client, ID, "New.", wait) == "2"


def test_update_without_a_description_is_refused(agent: tuple[Any, Stubber]) -> None:
    client, stubber = agent
    get(stubber, "ACTIVE", "CREATE_SUCCESSFUL", instruction=CONTENT)
    with pytest.raises(UsageError, match="no description"):
        update_answer_format(client, ID, "New.", wait)


def test_teardown_deletes_versions_newest_first_then_the_instruction(agent: tuple[Any, Stubber]) -> None:
    client, stubber = agent
    listed(stubber, [])
    get(stubber, "ACTIVE", "UPDATING")
    tags(stubber)
    stubber.add_response(
        "list_retrieval_instruction_versions",
        {
            "retrievalInstructionVersionSummaries": [
                {"version": "1", "createdAt": NOW},
                {"version": "2", "createdAt": NOW},
            ]
        },
        {"retrievalInstructionId": ID},
    )
    get(stubber, "ACTIVE", "UPDATE_SUCCESSFUL")  # the review is waited out first
    for v in ("2", "1"):
        stubber.add_response(
            "delete_retrieval_instruction",
            {"retrievalInstructionId": ID, "retrievalInstructionArn": ARN, "version": v},
            {"retrievalInstructionId": ID, "retrievalInstructionVersion": v},
        )
    stubber.add_response(
        "delete_retrieval_instruction",
        {"retrievalInstructionId": ID, "retrievalInstructionArn": ARN},
        {"retrievalInstructionId": ID},
    )
    not_found(stubber, "get_retrieval_instruction", {"retrievalInstructionId": ID})
    [cand] = [inspect(client, c) for c in candidates(client, recorded(["1", "2"]))]
    assert (cand.action, cand.versions) == ("delete", ["2", "1"])
    assert delete(client, cand, wait=wait, sleep=no_sleep, clock=Clock()) == "deleted"


def test_teardown_skips_a_listed_instruction_without_the_sample_tag(agent: tuple[Any, Stubber]) -> None:
    client, stubber = agent
    listed(stubber, ["assistant-team-support", "assistant-somebody-else"])
    stubber.add_response(
        "get_retrieval_instruction",
        {**described("ACTIVE", "CREATE_SUCCESSFUL"), "retrievalInstructionId": "id00000000"},
        {"retrievalInstructionId": "id00000000"},
    )
    stubber.add_response("list_tags_for_resource", {"tags": {"tenant": "team-support"}}, {"resourceArn": ANY})
    cands = [inspect(client, c) for c in candidates(client, None)]
    assert [(c.name, c.action, c.reason) for c in cands] == [
        ("assistant-team-support", "skip", "not tagged app=retrieval-instructions-sample")
    ]


def test_teardown_marks_a_recorded_instruction_that_is_gone(agent: tuple[Any, Stubber]) -> None:
    client, stubber = agent
    not_found(stubber, "get_retrieval_instruction", {"retrievalInstructionId": ID})
    cand = inspect(client, Candidate("sales-region-north", NAME, ID, ARN))
    assert cand.action == "already deleted"


def test_a_deletion_that_is_not_confirmed_in_60_s(agent: tuple[Any, Stubber]) -> None:
    client, stubber = agent
    stubber.add_response(
        "delete_retrieval_instruction",
        {"retrievalInstructionId": ID, "retrievalInstructionArn": ARN},
        {"retrievalInstructionId": ID},
    )
    for _ in range(2):
        get(stubber, "ACTIVE", "CREATE_SUCCESSFUL")
    cand = Candidate("sales-region-north", NAME, ID, ARN, [], "delete")
    assert delete(client, cand, wait=wait, sleep=no_sleep, clock=Clock(25.0)) == "unconfirmed"


def test_the_fixture_state_is_usable_for_teardown(tmp_path: Path) -> None:
    loaded = state_file.load(write_state(tmp_path / "sample-state.json"))
    assert loaded is not None
    assert [e.name for e in loaded.instructions.values()] == [NAME, "assistant-team-support"]
    assert fixture("state.json")["release"]["team-support"]["canary"]["every"] == 5
