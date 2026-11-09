"""The command line: help, abbreviations, exit codes per error class, and teardown end to end with fakes."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest
from botocore.exceptions import NoCredentialsError

from ri_sample import cli
from ri_sample.commands import Context
from ri_sample.deployment import OUTPUT_KEYS, STACK_NAME, TENANT_OUTPUT_PREFIXES
from support import ACCOUNT, NOW, FakeRuntime, client_error, fixture, no_sleep, stubbed, write_state

COMMANDS = [
    ["status"],
    ["create-instructions"],
    ["baseline"],
    ["ask"],
    ["isolation"],
    ["structured-json"],
    ["multi-kb"],
    ["support-v2"],
    ["release", "show"],
    ["release", "set"],
    ["release", "route"],
    ["cloudtrail"],
    ["verify-abac"],
    ["teardown"],
]
OUTPUTS = {"SharedKnowledgeBaseId": "ABCDE12345", "SharedDataSourceId": "KLMNO12345", "CorpusBucketName": "bucket"}
ARN = f"arn:aws:bedrock:us-east-1:{ACCOUNT}:retrieval-instruction/"


class FakeSts:
    def __init__(self, fail: Exception | None = None) -> None:
        self.fail = fail

    def get_caller_identity(self) -> dict[str, str]:
        if self.fail:
            raise self.fail
        return {"Account": ACCOUNT}


class FakeCloudFormation:
    def __init__(self, missing: bool = False) -> None:
        self.missing = missing

    def describe_stacks(self, StackName: str) -> dict[str, Any]:
        assert StackName == STACK_NAME
        if self.missing:
            raise client_error("ValidationError", f"Stack with id {STACK_NAME} does not exist", "DescribeStacks")
        outputs = [{"OutputKey": k, "OutputValue": v} for k, v in OUTPUTS.items()]
        return {"Stacks": [{"StackName": STACK_NAME, "StackStatus": "CREATE_COMPLETE", "Outputs": outputs}]}


def context(tmp_path: Path, **overrides: Any) -> Context:
    values: dict[str, Any] = {
        "agent": None,
        "runtime": FakeRuntime(),
        "sts": FakeSts(),
        "cloudformation": FakeCloudFormation(),
        "cloudtrail": None,
        "region": "us-east-1",
        "client_factory": lambda service, creds: None,
        "state_path": tmp_path / "sample-state.json",
        "sleep": no_sleep,
    }
    values.update(overrides)
    return Context(**values)


def run(argv: list[str], ctx: Context) -> int:
    return cli.main(argv, lambda: ctx)


@pytest.mark.parametrize("command", COMMANDS, ids=" ".join)
def test_every_command_has_help(command: list[str], capsys: pytest.CaptureFixture[str]) -> None:
    assert cli.main([*command, "--help"]) == 0
    assert "usage: ri-sample" in capsys.readouterr().out


def test_top_level_help_and_module_entry_point() -> None:
    assert cli.main(["--help"]) == 0
    done = subprocess.run([sys.executable, "-m", "ri_sample", "--help"], capture_output=True, text=True, check=False)
    assert done.returncode == 0 and "<command>" in done.stdout


@pytest.mark.parametrize(
    "argv",
    [
        ["ask", "--ques", "x"],
        ["ask", "--tenant", "sales-region-north", "--quest", "x"],
        ["release", "route", "--ten", "team-support"],
        ["ask", "--tenant", "team-support", "--question", "x", "--version", "1", "--request-index", "0"],
        ["status", "--quota", "many"],
        ["nonsense"],
    ],
)
def test_usage_errors_exit_2(argv: list[str]) -> None:
    assert cli.main(argv) == 2


def test_output_keys_equal_the_constants() -> None:
    constants = fixture("constants.json")
    assert constants["stackName"] == STACK_NAME
    assert OUTPUT_KEYS == constants["outputKeys"]
    assert TENANT_OUTPUT_PREFIXES == constants["tenantOutputPrefixes"]


def test_no_credentials_is_exit_3(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    ctx = context(tmp_path, sts=FakeSts(NoCredentialsError()))
    assert run(["status"], ctx) == 3
    assert "error: no valid AWS credentials" in capsys.readouterr().err


def test_a_missing_stack_is_exit_2(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert run(["baseline", "--question", "x"], context(tmp_path, cloudformation=FakeCloudFormation(True))) == 2
    assert f"stack {STACK_NAME} not found in us-east-1" in capsys.readouterr().err


def test_a_state_file_from_another_region_is_exit_2(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    ctx = context(tmp_path, region="eu-west-1")
    write_state(ctx.state_path)
    assert run(["ask", "--tenant", "sales-region-north", "--question", "x"], ctx) == 2
    assert "eu-west-1" in capsys.readouterr().err


def test_an_isolation_leak_is_exit_1(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    ctx = context(tmp_path, runtime=FakeRuntime("isolation-unfiltered.json", "isolation-unfiltered.json"))
    write_state(ctx.state_path)
    assert run(["isolation", "--tenant", "sales-region-north", "--question", "x"], ctx) == 1
    assert "Result: FAIL" in capsys.readouterr().out


def test_an_aws_error_is_exit_3_with_the_request_id(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    ctx = context(tmp_path, runtime=FakeRuntime(client_error("ThrottlingException", "slow down")))
    assert run(["baseline", "--question", "x"], ctx) == 3
    assert "error: ThrottlingException: slow down (request ID req)" in capsys.readouterr().err


def test_an_in_stream_exception_is_exit_3(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    ctx = context(tmp_path, runtime=FakeRuntime("midstream-error.json"))
    write_state(ctx.state_path)
    assert run(["ask", "--tenant", "team-support", "--question", "x"], ctx) == 3
    assert "error: AccessDeniedException:" in capsys.readouterr().err


def test_no_answer_is_exit_1(tmp_path: Path) -> None:
    ctx = context(tmp_path, runtime=FakeRuntime("empty-answer.json"))
    write_state(ctx.state_path)
    assert run(["ask", "--tenant", "sales-region-north", "--question", "x"], ctx) == 1


def test_ask_sends_the_snippet_request_and_checks_the_applied_instruction(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    runtime = FakeRuntime("ask-team.json")
    ctx = context(tmp_path, runtime=runtime)
    write_state(ctx.state_path)
    assert run(["ask", "--tenant", "team-support", "--question", "x", "--request-index", "0"], ctx) == 0
    assert runtime.calls[0]["retrievalInstructionConfiguration"] == {
        "retrievalInstructionId": "fghij67890",
        "version": "2",
    }
    assert "(routed by the release configuration, request 0)" in capsys.readouterr().out
    runtime = FakeRuntime("ask-team.json")
    assert run(["ask", "--tenant", "team-support", "--question", "x"], context(tmp_path, runtime=runtime)) == 1


def test_release_commands_need_no_aws(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    path = write_state(tmp_path / "sample-state.json")
    monkeypatch.setattr(cli, "STATE_FILE", path)
    assert cli.main(["release", "set", "--tenant", "team-support", "--live", "2"]) == 0
    assert "Release for team-support: live 2, no canary" in capsys.readouterr().out
    assert cli.main(["release", "set", "--tenant", "team-support", "--live", "3"]) == 2
    assert cli.main(["release", "route", "--tenant", "team-support", "--requests", "0"]) == 2
    assert cli.main(["release", "show"]) == 0


def test_teardown_handles_an_already_deleted_entry_without_the_stack(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    agent, stubber = stubbed("bedrock-agent")
    ctx = context(tmp_path, agent=agent, cloudformation=FakeCloudFormation(True))
    write_state(ctx.state_path)
    stubber.add_response("list_retrieval_instructions", {"retrievalInstructionSummaries": []}, {"maxResults": 50})
    stubber.add_client_error(
        "get_retrieval_instruction",
        "ResourceNotFoundException",
        "gone",
        404,
        expected_params={"retrievalInstructionId": "abcde12345"},
    )
    described = {
        "retrievalInstructionId": "fghij67890",
        "retrievalInstructionArn": ARN + "fghij67890",
        "name": "assistant-team-support",
        "status": "ACTIVE",
        "lastTransitionStatus": "CREATE_SUCCESSFUL",
        "createdAt": NOW,
        "updatedAt": NOW,
    }
    stubber.add_response("get_retrieval_instruction", described, {"retrievalInstructionId": "fghij67890"})
    stubber.add_response(
        "list_tags_for_resource",
        {"tags": {"tenant": "team-support", "app": "retrieval-instructions-sample"}},
        {"resourceArn": ARN + "fghij67890"},
    )
    stubber.add_response(
        "list_retrieval_instruction_versions",
        {
            "retrievalInstructionVersionSummaries": [
                {"version": "1", "createdAt": NOW},
                {"version": "2", "createdAt": NOW},
            ]
        },
        {"retrievalInstructionId": "fghij67890"},
    )
    for v in ("2", "1"):
        stubber.add_response(
            "delete_retrieval_instruction",
            {"retrievalInstructionId": "fghij67890", "retrievalInstructionArn": ARN + "fghij67890"},
            {"retrievalInstructionId": "fghij67890", "retrievalInstructionVersion": v},
        )
    stubber.add_response(
        "delete_retrieval_instruction",
        {"retrievalInstructionId": "fghij67890", "retrievalInstructionArn": ARN + "fghij67890"},
        {"retrievalInstructionId": "fghij67890"},
    )
    stubber.add_client_error(
        "get_retrieval_instruction",
        "ResourceNotFoundException",
        "gone",
        404,
        expected_params={"retrievalInstructionId": "fghij67890"},
    )
    with stubber:
        assert run(["teardown", "--yes"], ctx) == 0
        stubber.assert_no_pending_responses()
    captured = capsys.readouterr()
    assert captured.out == (
        "assistant-sales-region-north already deleted\n"
        "assistant-team-support deleted (versions 2, 1)\n"
        "Deleted 1 instruction. Removed sample-state.json.\n"
    )
    assert "not found in us-east-1; deleting sample instructions anyway" in captured.err
    assert not ctx.state_path.exists()


def test_teardown_without_yes_prints_the_plan_and_deletes_nothing(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    agent, stubber = stubbed("bedrock-agent")
    ctx = context(tmp_path, agent=agent)
    stubber.add_response("list_retrieval_instructions", {"retrievalInstructionSummaries": []}, {"maxResults": 50})
    with stubber:
        assert run(["teardown"], ctx) == 0
    assert capsys.readouterr().out == "No sample instructions found in this Region.\n"
