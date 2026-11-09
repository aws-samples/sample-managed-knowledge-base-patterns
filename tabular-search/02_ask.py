"""Step 2: ask a question with AgenticRetrieveStream and read the trace.

Pass a question ID from questions.json (run with --list to see them) or your own question
in quotes. The script prints each trace step, the files the code reads, the answer as it
streams, and the files the answer cites.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

from botocore.exceptions import ClientError

import common


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Ask a question with AgenticRetrieveStream and read the trace."
    )
    parser.add_argument(
        "question",
        nargs="?",
        default="overspend",
        help="A question ID from questions.json, or your own question in quotes "
        "(default: overspend).",
    )
    parser.add_argument(
        "--list", action="store_true", help="List the question IDs and exit."
    )
    parser.add_argument(
        "--retrieve-only",
        action="store_true",
        help="Send the question to the Retrieve API instead, to compare plain retrieval.",
    )
    parser.add_argument(
        "--only-file",
        metavar="FILE_NAME",
        help="Limit retrieval, and so the code, to one file by its name, for example "
        "anycompany-pnl-fy2026.xlsx.",
    )
    parser.add_argument(
        "--save-trace",
        type=Path,
        metavar="PATH",
        help="Write every stream event to a JSON Lines file, for example traces/overspend.jsonl.",
    )
    parser.add_argument(
        "--kb-id", help="Ask an existing knowledge base instead of the stack's."
    )
    common.add_stack_arguments(parser)
    args = parser.parse_args()

    if args.list:
        for q in common.load_questions():
            print(f"{q['id']:<16} {q['title']}")
        return

    known = common.find_question(args.question)
    if known and known.get("turns"):
        sys.exit(f"{args.question} is a conversation. Run 03_conversation.py instead.")
    text = known["question"] if known else args.question

    session = common.make_session(args.region)
    kb_id = common.knowledge_base_id(session, args.stack_name, args.kb_id)
    print(f"Question: {text}\n")
    runtime = session.client("bedrock-agent-runtime", config=common.STREAM_CONFIG)

    if args.retrieve_only:
        # A plain dict, because the filter is optional. Boto3 validates the request.
        search: dict[str, Any] = {"numberOfResults": 10}
        if args.only_file:
            search["filter"] = {
                "equals": {"key": "_document_title", "value": args.only_file}
            }
        try:
            response = runtime.retrieve(
                knowledgeBaseId=kb_id,
                retrievalQuery={"text": text},
                retrievalConfiguration={"managedSearchConfiguration": search},  # type: ignore[typeddict-item]
            )
        except ClientError as error:
            sys.exit(f"Retrieve failed: {common.explain(error)}")
        common.print_retrieve_results(response["retrievalResults"])
        print(
            "\nRetrieve returns passages only. It doesn't run code or write an answer."
        )
        return

    messages = [{"role": "user", "content": {"text": text}}]
    try:
        response_stream = runtime.agentic_retrieve_stream(
            **common.agentic_request(kb_id, messages, args.only_file)
        )
    except ClientError as error:
        sys.exit(f"AgenticRetrieveStream failed: {common.explain(error)}")
    request_id = response_stream["ResponseMetadata"]["RequestId"]
    outcome = common.print_stream(
        response_stream["stream"], args.save_trace, request_id
    )
    if not outcome.code_ran:
        print(
            "\nNo code ran for this question. Tabular search runs code when a retrieved passage "
            "comes from a CSV or Excel file and the question needs a calculation or a lookup "
            "across rows."
        )
    print(f"\nRequest ID: {request_id}")
    if args.save_trace:
        print(f"Trace saved to {args.save_trace}")
    if known and known.get("expected"):
        print(f"\nExpected for the sample files: {known['expected']}")


if __name__ == "__main__":
    main()
