"""The retrieval call. One function builds the AgenticRetrieveStream request from the
verified Principal; another consumes the stream. The rest read the same memory resource
directly so the UI can list conversations and render history without a second store.

Every AWS client is created from the caller's own session (see aws_sessions.py), so IAM
sees which end user each call is for.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Iterator

import boto3
from botocore.config import Config

from identity import Principal

_RUNTIME_CONFIG = Config(read_timeout=180, retries={"max_attempts": 2, "mode": "standard"})


class Assistant:
    def __init__(self, cfg: dict, session_for: Callable[[Principal], boto3.Session]):
        self.cfg = cfg
        self.session_for = session_for
        self.memory_id = cfg["memory"]["id"]
        self.namespace_root = cfg["memory"]["namespaceRoot"]
        self.knowledge_base = cfg["knowledgeBase"]
        self._clients: dict[str, tuple] = {}

    def _clients_for(self, principal: Principal):
        # Clients are cached per user and rebuilt whenever that user's session is renewed.
        session = self.session_for(principal)
        hit = self._clients.get(principal.sub)
        if hit is None or hit[0] is not session:
            hit = (session, session.client("bedrock-agent-runtime", config=_RUNTIME_CONFIG),
                   session.client("bedrock-agentcore"))
            self._clients[principal.sub] = hit
        return hit[1], hit[2]

    # ---------------------------------------------------------------- request

    def build_request(self, principal: Principal, question: str, session_id: str,
                      persist: bool = True, use_long_term_memory: bool = True) -> dict:
        """Everything user-scoped is derived from `principal`, never from the client.

        `session_id` may be echoed back by the client: because short-term memory is keyed
        by (memoryId, actorId, sessionId) and actorId comes from the token, a foreign
        sessionId can only ever name a session inside this user's own space.
        """
        memory_configuration = {
            "memoryId": self.memory_id,
            # Short-term memory: restore this conversation and, when persist is true,
            # write the question and the generated answer back to it.
            "sessionBinding": {"actorId": principal.actor_id, "sessionId": session_id},
            "persistenceMode": "DEFAULT" if persist else "NONE",
        }
        if use_long_term_memory:
            # Long-term memory: the planner may search this user's extracted records.
            memory_configuration["retrievalConfigs"] = [
                {"namespacePath": principal.namespace_path(self.namespace_root)}
            ]
        return {
            # With sessionBinding, messages carries ONLY the current question. Sending
            # earlier turns as well is rejected with a ValidationException.
            "messages": [{"role": "user", "content": {"text": question}}],
            "retrievers": [{
                "configuration": {"knowledgeBase": {"knowledgeBaseId": self.knowledge_base["id"]}},
                "description": self.knowledge_base["description"],
            }],
            # Document-level access control: the knowledge base returns only documents
            # whose ACL allows this email. Without userContext, an ACL-enabled data source
            # returns nothing at all.
            "userContext": {"userId": principal.acl_user_id},
            "agenticRetrieveConfiguration": {
                "foundationModelType": "MANAGED",
                "rerankingModelType": "MANAGED",
                "maxAgentIteration": 3,
            },
            "generateResponse": True,
            "memoryConfiguration": memory_configuration,
        }

    # ----------------------------------------------------------------- stream

    def ask(self, principal: Principal, request: dict) -> Iterator[dict]:
        """Yield normalized events: {"type": "trace"|"text"|"result"|"error", ...}.

        The raw event is preserved in `raw` on each yielded event so a caller can log it
        verbatim; the normalized fields are what the UI needs.
        """
        runtime, _ = self._clients_for(principal)
        response = runtime.agentic_retrieve_stream(**request)
        for event in response["stream"]:
            if "traceEvent" in event:
                attrs = event["traceEvent"].get("attributes", {})
                yield {"type": "trace", "step": attrs.get("step"), "status": attrs.get("status"),
                       "message": attrs.get("message"), "actions": attrs.get("actions"),
                       "retrievalMetadata": attrs.get("retrievalMetadata"),
                       "retrievalResponse": attrs.get("retrievalResponse"),
                       "failures": attrs.get("failures"), "raw": event}
            elif "responseEvent" in event:
                yield {"type": "text", "text": event["responseEvent"].get("text", ""), "raw": event}
            elif "result" in event:
                res = event["result"]
                gen = res.get("generatedResponse") or {}
                yield {"type": "result", "answer": gen.get("answer"), "citations": gen.get("citations"),
                       "results": res.get("results", []), "raw": event}
            else:
                # Exceptions arrive as their own event members (validationException, ...).
                yield {"type": "error", "raw": event}

    # ------------------------------------------------- read memory for the UI

    def list_conversations(self, principal: Principal) -> list[dict]:
        """The memory resource is the application's conversation store too."""
        _, memory = self._clients_for(principal)
        try:
            resp = memory.list_sessions(memoryId=self.memory_id, actorId=principal.actor_id, maxResults=50)
        except memory.exceptions.ResourceNotFoundException:
            # A user who has never asked a question is not an actor yet.
            return []
        return [{"sessionId": s["sessionId"], "createdAt": s["createdAt"].isoformat()}
                for s in resp.get("sessionSummaries", [])]

    def conversation_history(self, principal: Principal, session_id: str) -> list[dict]:
        """Render a conversation from the events the retrieval wrote (question + answer per turn)."""
        _, memory = self._clients_for(principal)
        try:
            resp = memory.list_events(memoryId=self.memory_id, actorId=principal.actor_id,
                                      sessionId=session_id, includePayloads=True, maxResults=100)
        except memory.exceptions.ResourceNotFoundException:
            # No such session (or no such actor yet) in this user's memory space.
            return []
        turns = []
        for ev in sorted(resp.get("events", []), key=lambda e: e["eventTimestamp"]):
            for p in ev.get("payload", []):
                conv = p.get("conversational")
                if conv:
                    turns.append({"role": conv["role"].lower(), "text": conv["content"]["text"],
                                  "at": ev["eventTimestamp"].isoformat()})
        return turns

    def long_term_records(self, principal: Principal) -> list[dict]:
        """Demo view: what long-term memory currently knows about this user."""
        _, memory = self._clients_for(principal)
        try:
            resp = memory.list_memory_records(
                memoryId=self.memory_id, namespacePath=principal.namespace_path(self.namespace_root), maxResults=50)
        except memory.exceptions.ResourceNotFoundException:
            return []
        out = []
        for r in resp.get("memoryRecordSummaries", []):
            out.append({"namespaces": r.get("namespaces"), "text": r.get("content", {}).get("text"),
                        "createdAt": r["createdAt"].isoformat() if r.get("createdAt") else None})
        return out


def new_session_id() -> str:
    # AgentCore sessionId: 1-100 chars, [a-zA-Z0-9][a-zA-Z0-9-_]*
    return "conv-" + uuid.uuid4().hex
