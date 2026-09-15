"""Minimal FastAPI entrypoint for the OmniAgent backend."""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="OmniAgent API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, str]:
    """Return a lightweight liveness response for local and hosted checks."""

    return {"status": "ok"}

