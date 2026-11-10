"""AnyCompany internal assistant — local backend.

Stands in for API Gateway (JWT authorizer) + Lambda. Every endpoint requires a Cognito ID
token as a bearer token; the handler derives the user's identity from the verified claims
and never from the request body.

Run:  uvicorn app:app --app-dir backend --port 8765    (or scripts/serve.sh)
"""

from __future__ import annotations

import json
import logging
import pathlib
import time
import uuid
from typing import Annotated

import jwt
from botocore.exceptions import BotoCoreError, ClientError
from fastapi import Depends, FastAPI, HTTPException, Path, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from assistant import Assistant, new_session_id
from aws_sessions import UserSessions
from identity import CognitoVerifier, Principal, rejection_detail

ROOT = pathlib.Path(__file__).resolve().parent.parent
CFG = json.loads((ROOT / "config.json").read_text())

# Error details (token validation messages, AWS errors that name roles and accounts) go to
# this log with a correlation ID. Clients get only a generic message and the ID.
log = logging.getLogger("uvicorn.error")

# AgentCore sessionId format, for the request body and the path parameter alike.
SESSION_ID_PATTERN = r"^[a-zA-Z0-9][a-zA-Z0-9\-_]{0,99}$"

# The page loads only same-origin script and CSS, and calls only this API and the Cognito
# user pool endpoint (sign-in).
CSP = (f"default-src 'self'; connect-src 'self' https://cognito-idp.{CFG['region']}.amazonaws.com; "
       "base-uri 'none'; object-src 'none'; frame-ancestors 'none'")


app = FastAPI(title="AnyCompany internal assistant")
verifier = CognitoVerifier(CFG["cognito"]["issuer"], CFG["cognito"]["clientId"])
# The backend's own credentials (AWS_PROFILE or the default chain) are used only to assume
# the application role once per end user. See aws_sessions.py.
sessions = UserSessions(CFG["appRoleArn"], CFG["region"])
assistant = Assistant(CFG, session_for=sessions.for_user)


# ------------------------------------------------------------------ auth dep

def current_user(request: Request) -> Principal:
    auth = request.headers.get("authorization", "")
    if not auth.lower().startswith("bearer "):
        raise HTTPException(401, "missing bearer token")
    token = auth.split(" ", 1)[1]
    try:
        return verifier.verify(token)
    except jwt.PyJWTError as e:
        cid = str(uuid.uuid4())
        log.warning("rejected token correlationId=%s %s", cid, rejection_detail(token, e))
        raise HTTPException(401, {"message": "invalid token", "correlationId": cid}) from e


# ------------------------------------------------------------------- models

class ChatRequest(BaseModel):
    # The client sends only these. Identity comes from the token, never from here.
    question: str = Field(min_length=1, max_length=10_000)
    sessionId: str | None = Field(default=None, pattern=SESSION_ID_PATTERN)
    # Both default to true and the UI never sends them; scripts/e2e.py turns them off so its
    # access-control probes leave no trace in memory. Neither can name another user's data.
    useLongTermMemory: bool = True
    persist: bool = True


# ---------------------------------------------------------------- endpoints

@app.get("/api/me")
def me(user: Principal = Depends(current_user)):
    kb = CFG["knowledgeBase"]
    readable = [f for f, emails in kb.get("folderAccess", {}).items() if user.email in emails]
    return {"username": user.username, "sub": user.sub, "email": user.email,
            "knowledgeBase": {"name": kb["name"], "description": kb["description"]},
            # For display only: the knowledge base enforces this, not the application.
            "readableFolders": readable}


@app.post("/api/chat")
def chat(body: ChatRequest, user: Principal = Depends(current_user)):
    session_id = body.sessionId or new_session_id()
    request = assistant.build_request(user, body.question, session_id,
                                      persist=body.persist, use_long_term_memory=body.useLongTermMemory)
    correlation_id = str(uuid.uuid4())

    def sse():
        started = time.monotonic()
        # First frame tells the client which session to echo back on the next turn.
        yield _frame("session", {"sessionId": session_id, "correlationId": correlation_id})
        try:
            for ev in assistant.ask(user, request):
                if ev["type"] == "trace":
                    # Log the full trace server-side with the correlation id; send a compact
                    # view to the client for the "how did it get this answer" panel.
                    _log_trace(correlation_id, user, session_id, ev["raw"])
                    yield _frame("trace", {
                        "t": round((time.monotonic() - started) * 1000),
                        "step": ev["step"], "status": ev["status"], "message": ev["message"],
                        "sources": sorted({m.get("retrievalType") for m in (ev.get("retrievalMetadata") or [])}),
                        "items": len(ev.get("retrievalResponse") or []),
                        "actions": _compact_actions(ev.get("actions")),
                        "memory": _memory_metadata(ev),
                        "failures": [f.get("message") for f in (ev.get("failures") or [])],
                    })
                elif ev["type"] == "text":
                    yield _frame("text", {"text": ev["text"]})
                elif ev["type"] == "result":
                    yield _frame("result", {
                        "answer": ev["answer"],
                        "citations": ev.get("citations"),
                        "sources": [_source(r) for r in ev["results"]],
                        "totalMs": round((time.monotonic() - started) * 1000),
                    })
                elif ev["type"] == "error":
                    log.warning("correlationId=%s stream error event: %s", correlation_id,
                                json.dumps(ev["raw"], default=str))
                    yield _frame("error", {"correlationId": correlation_id, "message": "request failed"})
        except Exception:  # log, then end the stream with a generic error
            log.exception("correlationId=%s chat request failed", correlation_id)
            yield _frame("error", {"correlationId": correlation_id, "message": "request failed"})
        yield _frame("done", {})

    return StreamingResponse(sse(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/conversations")
def conversations(user: Principal = Depends(current_user)):
    """Read the memory resource directly: it is the conversation store."""
    return assistant.list_conversations(user)


@app.get("/api/conversations/{session_id}")
def conversation(session_id: Annotated[str, Path(pattern=SESSION_ID_PATTERN)],
                 user: Principal = Depends(current_user)):
    # session_id comes from the client, but actorId comes from the token, so this can
    # only ever read a session inside the caller's own memory space.
    return assistant.conversation_history(user, session_id)


@app.get("/api/memory")
def memory(user: Principal = Depends(current_user)):
    """What long-term memory currently knows about the caller (demo/transparency view)."""
    return assistant.long_term_records(user)


@app.exception_handler(ClientError)
@app.exception_handler(BotoCoreError)
def aws_error(request: Request, exc: Exception) -> JSONResponse:
    # AWS error messages can name the backend's role, session and account; keep them in the log.
    cid = str(uuid.uuid4())
    log.error("correlationId=%s %s %s", cid, request.url.path, exc, exc_info=exc)
    return JSONResponse(status_code=502, content={"detail": {"message": "request failed", "correlationId": cid}})


# ----------------------------------------------------------------- helpers

def _frame(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n"


def _source(r: dict) -> dict:
    md = r.get("metadata") or {}
    uri = md.get("_source_uri") or ((r.get("location") or {}).get("s3Location") or {}).get("uri") or ""
    path = uri.split("/docs/", 1)[-1] if "/docs/" in uri else uri
    return {"knowledgeBaseId": (r.get("sourceRetriever") or {}).get("identifier"),
            "document": path or md.get("_document_title"),
            "preview": (r.get("content") or {}).get("text", "")[:200]}


def _compact_actions(actions):
    out = []
    for a in actions or []:
        if "memoryRetrieve" in a:
            out.append({"type": "memoryRetrieve", "query": a["memoryRetrieve"].get("inputQuery", {}).get("text"),
                        "namespacePath": a["memoryRetrieve"].get("namespacePath")})
        elif "retrieve" in a:
            out.append({"type": "retrieve", "query": a["retrieve"].get("inputQuery", {}).get("text"),
                        "retrievers": [r.get("identifier") for r in a["retrieve"].get("sourceRetrievers", [])]})
        elif "fullDocumentExpansion" in a:
            out.append({"type": "fullDocumentExpansion", "documentId": a["fullDocumentExpansion"].get("documentId")})
    return out


def _memory_metadata(ev):
    for item in ev.get("retrievalResponse") or []:
        md = {k: v for k, v in (item.get("metadata") or {}).items() if k.startswith("_memory_")}
        if md:
            return md
    return None


TRACE_LOG = ROOT / "runs" / "backend-trace.jsonl"
TRACE_LOG.parent.mkdir(exist_ok=True)


def _log_trace(correlation_id: str, user: Principal, session_id: str, raw: dict) -> None:
    # In production this goes to CloudWatch Logs. The record carries the actorId in clear
    # text because this is a local demo; decide whether your logs may carry user identifiers.
    with TRACE_LOG.open("a") as f:
        f.write(json.dumps({"correlationId": correlation_id, "actorId": user.actor_id,
                            "sessionId": session_id, "event": raw}, default=str) + "\n")


# ---------------------------------------------------------------- frontend

FRONTEND = ROOT / "frontend"
if FRONTEND.exists():
    @app.get("/")
    def index():
        return FileResponse(FRONTEND / "index.html", headers={"Content-Security-Policy": CSP})

    @app.get("/config.js")
    def config_js():
        # Only public client configuration reaches the browser.
        cog = CFG["cognito"]
        return StreamingResponse(iter([
            f"window.APP_CONFIG = {json.dumps({'region': CFG['region'], 'clientId': cog['clientId']})};"
        ]), media_type="application/javascript")

    app.mount("/static", StaticFiles(directory=FRONTEND / "static"), name="static")
