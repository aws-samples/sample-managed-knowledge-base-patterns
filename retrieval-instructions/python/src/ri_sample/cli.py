"""ri-sample: per-tenant retrieval instructions on a shared managed knowledge base.

Run from the pattern directory with `uv run ri-sample <command> [options]`.
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Callable, Sequence
from typing import Any

from botocore.exceptions import BotoCoreError, ClientError, ReadTimeoutError

from ri_sample import commands
from ri_sample.errors import SampleError, aws_error
from ri_sample.paths import STATE_FILE

STREAM_TIMEOUT = "no data from the service for 120 s; run the command again"


class Parser(argparse.ArgumentParser):
    """argparse with abbreviations off, so `--ques` is a usage error, as in the TypeScript version."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        kwargs.setdefault("allow_abbrev", False)
        super().__init__(*args, **kwargs)


def build_parser() -> argparse.ArgumentParser:
    parser = Parser(prog="ri-sample", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True, metavar="<command>", parser_class=Parser)

    p = sub.add_parser("status", help="stack, ingestion, quota headroom, and the sample instructions")
    p.add_argument("--wait", action="store_true", help="poll ingestion every 10 s for up to 30 minutes")
    p.add_argument("--quota", type=int, default=50, help="retrieval instruction quota (default 50)")

    p = sub.add_parser("create-instructions", help="create, review, and version the sample instructions")
    p.add_argument("--combined", action="store_true", help="also create the four combined-cell instructions")
    p.add_argument("--quota", type=int, default=50, help="retrieval instruction quota (default 50)")

    p = sub.add_parser("baseline", help="ask with no retrieval instruction")
    p.add_argument("--question", required=True)
    p.add_argument("--tenant", help="add the tenant line and filter, still with no instruction")
    p.add_argument("--region", help="a sales region key, with a team tenant only")

    p = sub.add_parser("ask", help="ask as a tenant: its instruction, tenant line, and filter")
    p.add_argument("--tenant", required=True)
    p.add_argument("--question", required=True)
    p.add_argument("--region", help="a sales region key, with a team tenant only")
    version = p.add_mutually_exclusive_group()
    version.add_argument("--version", help="DRAFT or a version number (default: the live pin)")
    version.add_argument("--request-index", type=int, help="let the release configuration route request N")
    p.add_argument("--trace", action="store_true", help="also print the first Planning trace event")

    p = sub.add_parser("isolation", help="list retrieved documents without and with the tenant filter")
    p.add_argument("--tenant", required=True)
    p.add_argument("--question", required=True)
    p.add_argument("--region", help="a sales region key, with a team tenant only")

    p = sub.add_parser("structured-json", help="ask for the five-key JSON reply and validate it")
    p.add_argument("--question", required=True)

    p = sub.add_parser("multi-kb", help="one instruction across the shared and the South knowledge base")
    p.add_argument("--question", required=True)
    p.add_argument("--version", help="DRAFT or a version number (default: the live pin)")
    p.add_argument("--no-filters", action="store_true", help="send the same request with no retriever filters")

    sub.add_parser("support-v2", help="update the support instruction and create version 2")

    release = sub.add_parser("release", help="the per-tenant release configuration in sample-state.json")
    rsub = release.add_subparsers(dest="release_command", required=True, metavar="<command>", parser_class=Parser)
    rsub.add_parser("show", help="print the release configuration and the recorded versions")
    p = rsub.add_parser("set", help="set the live version and an optional canary")
    p.add_argument("--tenant", required=True)
    p.add_argument("--live", required=True)
    p.add_argument("--canary", help="version that gets one request in --every")
    p.add_argument("--every", type=int)
    p = rsub.add_parser("route", help="print the version each request index gets")
    p.add_argument("--tenant", required=True)
    p.add_argument("--requests", type=int, default=10)

    p = sub.add_parser("cloudtrail", help="GetRetrievalInstruction calls Amazon Bedrock made, from event history")
    p.add_argument("--since", type=int, default=60, help="minutes to look back (default 60)")
    p.add_argument("--wait", action="store_true", help="poll every 60 s for up to 15 minutes")

    p = sub.add_parser("verify-abac", help="check the tenant role tag conditions")
    p.add_argument("--tenant", help="default: the first tenant with roles")
    p.add_argument("--other", help="another sales region tenant (default sales-region-central)")

    p = sub.add_parser("teardown", help="delete the sample instructions (prints the plan without --yes)")
    p.add_argument("--yes", action="store_true", help="delete versions, then instructions")
    return parser


def dispatch(args: argparse.Namespace, context: Callable[[], commands.Context]) -> int:
    if args.command == "release":
        path = STATE_FILE
        if args.release_command == "show":
            return commands.cmd_release_show(path)
        if args.release_command == "set":
            return commands.cmd_release_set(path, args.tenant, args.live, args.canary, args.every)
        return commands.cmd_release_route(path, args.tenant, args.requests)
    ctx = context()
    if args.command == "status":
        return commands.cmd_status(ctx, args.wait, args.quota)
    if args.command == "create-instructions":
        return commands.cmd_create_instructions(ctx, args.combined, args.quota)
    if args.command == "baseline":
        return commands.cmd_baseline(ctx, args.question, args.tenant, args.region)
    if args.command == "ask":
        return commands.cmd_ask(
            ctx, args.tenant, args.question, args.region, args.version, args.request_index, args.trace
        )
    if args.command == "isolation":
        return commands.cmd_isolation(ctx, args.tenant, args.question, args.region)
    if args.command == "structured-json":
        return commands.cmd_structured_json(ctx, args.question)
    if args.command == "multi-kb":
        return commands.cmd_multi_kb(ctx, args.question, args.version, args.no_filters)
    if args.command == "support-v2":
        return commands.cmd_support_v2(ctx)
    if args.command == "cloudtrail":
        return commands.cmd_cloudtrail(ctx, args.since, args.wait)
    if args.command == "verify-abac":
        return commands.cmd_verify_abac(ctx, args.tenant, args.other)
    return commands.cmd_teardown(ctx, args.yes)


def main(argv: Sequence[str] | None = None, context: Callable[[], commands.Context] | None = None) -> int:
    """Exit codes: 0 success, 1 a check failed, 2 usage or a guard refused, 3 an AWS error."""
    try:
        args = build_parser().parse_args(argv)
    except SystemExit as exit_:
        return int(exit_.code or 0)
    try:
        return dispatch(args, context or commands.default_context)
    except SampleError as err:
        print(f"error: {err.message}", file=sys.stderr)
        return err.exit_code
    except ClientError as err:
        print(f"error: {aws_error(err).message}", file=sys.stderr)
        return 3
    except ReadTimeoutError:
        print(f"error: {STREAM_TIMEOUT}", file=sys.stderr)
        return 3
    except BotoCoreError as err:
        print(f"error: {type(err).__name__}: {err}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    sys.exit(main())
