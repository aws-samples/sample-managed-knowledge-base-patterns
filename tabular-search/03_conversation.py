"""Step 3: continue a conversation over two turns.

Each request sends the earlier turns in messages: the first question, its answer (role
assistant), and the new question. Tabular search runs in whichever turn needs the table.
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
        description="Ask a two-turn conversation with AgenticRetrieveStream."
    )
    parser.add_argument(
        "--save-traces",
        type=Path,
        metavar="DIR",
        help="Write each turn's stream events to DIR/turn-<n>.jsonl.",
    )
    parser.add_argument(
        "--kb-id", help="Ask an existing knowledge base instead of the stack's."
    )
    common.add_stack_arguments(parser)
    args = parser.parse_args()

    session = common.make_session(args.region)
    kb_id = common.knowledge_base_id(session, args.stack_name, args.kb_id)
    runtime = session.client("bedrock-agent-runtime", config=common.STREAM_CONFIG)

    conversation = common.find_question("conversation")
    if not conversation:
        sys.exit("questions.json has no conversation.")
    messages: list[dict[str, Any]] = []
    for number, turn in enumerate(conversation["turns"], 1):
        print(f"\n=== Turn {number}: {turn['question']}\n")
        messages.append({"role": "user", "content": {"text": turn["question"]}})
        try:
            response = runtime.agentic_retrieve_stream(
                **common.agentic_request(kb_id, messages)
            )
        except ClientError as error:
            sys.exit(f"AgenticRetrieveStream failed: {common.explain(error)}")
        request_id = response["ResponseMetadata"]["RequestId"]
        trace = args.save_traces / f"turn-{number}.jsonl" if args.save_traces else None
        outcome = common.print_stream(response["stream"], trace, request_id)
        if not outcome.answer:
            sys.exit(
                f"Turn {number} returned no answer, so there's nothing to send as history."
            )
        messages.append({"role": "assistant", "content": {"text": outcome.answer}})
        print(f"\nRequest ID: {request_id}")
        print(f"Expected for the sample files: {turn['expected']}")


if __name__ == "__main__":
    main()
