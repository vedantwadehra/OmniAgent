"""Minimal FastAPI entrypoint for the OmniAgent backend."""

import json
from typing import Literal

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from agent import stream_agent_events

app = FastAPI(title="OmniAgent API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.api_route("/health", methods=["GET", "HEAD"])
async def health() -> dict[str, str]:
    """Return a lightweight liveness response for local and hosted checks."""

    return {"status": "ok"}


class ChatMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=8_000)

    @field_validator("content")
    @classmethod
    def content_must_not_be_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("message content cannot be blank")
        return value


class ChatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    messages: list[ChatMessage] = Field(min_length=1, max_length=50)

    @model_validator(mode="after")
    def validate_conversation(self):
        if self.messages[-1].role != "user":
            raise ValueError("the final message must have role 'user'")
        if sum(len(message.content) for message in self.messages) > 32_000:
            raise ValueError("conversation content exceeds the 32000 character limit")
        return self


@app.post("/api/chat")
async def chat(req: ChatRequest, request: Request):
    """Run the agent loop and stream SSE: tool_start/tool_end/token/done."""

    history = [{"role": m.role, "content": m.content} for m in req.messages]

    async def events():
        sent_done = False
        try:
            async for ev in stream_agent_events(history):
                if await request.is_disconnected():
                    break
                if ev.get("type") == "done":
                    if sent_done:
                        continue
                    sent_done = True
                yield f"data: {json.dumps(ev)}\n\n"
        except Exception:
            yield f"data: {json.dumps({'type': 'error', 'code': 'stream_failed', 'message': 'The response stream failed unexpectedly.'})}\n\n"
        finally:
            if not sent_done and not await request.is_disconnected():
                yield f"data: {json.dumps({'type': 'done'})}\n\n"

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
