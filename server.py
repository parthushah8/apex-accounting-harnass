from __future__ import annotations

import asyncio
import json
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from harness.agent import LoopHarness
from harness.config import DEFAULT_MODELS, HOST, MAX_STEPS, MAX_TOKENS, PORT, provider_status
from harness.tasks import load_tasks, public_task

WEB = Path(__file__).resolve().parent / "web"
app = FastAPI(title="APEX Loop Harness")
runs: dict[str, dict] = {}
run_counter = 0


class StartRun(BaseModel):
    task_id: str
    provider: str = "local"
    model: str | None = None
    api_key: str | None = None
    max_steps: int = MAX_STEPS
    max_tokens: int = MAX_TOKENS


class UserMessage(BaseModel):
    text: str


@app.get("/favicon.ico")
def favicon():
    return Response(status_code=204)


@app.get("/api/status")
def status():
    return {
        "providers": provider_status(),
        "defaults": DEFAULT_MODELS,
        "max_steps": MAX_STEPS,
        "max_tokens": MAX_TOKENS,
    }


@app.get("/api/tasks")
def tasks():
    return [public_task(t) for t in load_tasks()]


@app.get("/api/runs/{run_id}")
def get_run(run_id: str):
    run = runs.get(run_id)
    if not run:
        raise HTTPException(404, "unknown run")
    return {
        "id": run_id,
        "status": run["status"],
        "events": run["history"],
    }


@app.post("/api/runs")
async def start_run(body: StartRun):
    global run_counter
    run_counter += 1
    run_id = f"r{run_counter:04d}"
    queue: asyncio.Queue = asyncio.Queue()
    gate = asyncio.Event()
    gate.set()
    state = {
        "id": run_id,
        "status": "running",
        "queue": queue,
        "history": [],
        "task_id": body.task_id,
        "inbox": asyncio.Queue(),
        "gate": gate,
    }
    runs[run_id] = state

    async def emit(event: dict):
        # seq lets the client drop duplicates when an SSE reconnect replays history
        event = {"run_id": run_id, "seq": len(state["history"]), **event}
        state["history"].append(event)
        await queue.put("tick")

    async def runner():
        try:
            await emit({"type": "log", "level": "info", "message": f"loop start · {body.provider}"})
            harness = LoopHarness(emit, inbox=state["inbox"], gate=state["gate"])
            await harness.run(
                task_id=body.task_id,
                provider=body.provider,
                model=body.model,
                api_key=body.api_key,
                max_steps=body.max_steps,
                max_tokens=body.max_tokens,
            )
        except Exception as exc:
            await emit({"type": "error", "message": str(exc)})
            await emit({"type": "run_finished", "status": "error", "elapsed_ms": 0})
        finally:
            state["status"] = "done"
            await queue.put(None)

    asyncio.create_task(runner())
    return {"run_id": run_id}


async def _push(run: dict, event: dict) -> None:
    run["history"].append({"run_id": run["id"], "seq": len(run["history"]), **event})
    await run["queue"].put("tick")


def _live_run(run_id: str) -> dict:
    run = runs.get(run_id)
    if not run:
        raise HTTPException(404, "unknown run")
    if run["status"] != "running":
        raise HTTPException(409, "run already finished")
    return run


@app.post("/api/runs/{run_id}/message")
async def message_run(run_id: str, body: UserMessage):
    run = _live_run(run_id)
    text = body.text.strip()
    if not text:
        raise HTTPException(422, "empty message")
    await _push(run, {"type": "user_message", "text": text})
    await run["inbox"].put(text)
    await _push(run, {"type": "guidance_queued"})
    return {"ok": True, "paused": not run["gate"].is_set()}


@app.post("/api/runs/{run_id}/pause")
async def pause_run(run_id: str):
    run = _live_run(run_id)
    if run["gate"].is_set():
        run["gate"].clear()
        await _push(run, {"type": "paused"})
    return {"ok": True}


@app.post("/api/runs/{run_id}/resume")
async def resume_run(run_id: str):
    run = _live_run(run_id)
    if not run["gate"].is_set():
        run["gate"].set()
        await _push(run, {"type": "resumed"})
    return {"ok": True}


@app.get("/api/runs/{run_id}/events")
async def events(run_id: str):
    run = runs.get(run_id)
    if not run:
        raise HTTPException(404, "unknown run")

    async def gen():
        idx = 0
        while True:
            hist = run["history"]
            while idx < len(hist):
                yield f"data: {json.dumps(hist[idx])}\n\n"
                idx += 1
            if run["status"] != "running":
                return
            msg = await run["queue"].get()
            if msg is None:
                continue

    return StreamingResponse(gen(), media_type="text/event-stream")


@app.middleware("http")
async def no_store_ui(request: Request, call_next):
    resp = await call_next(request)
    path = request.url.path
    if path == "/" or path.endswith((".html", ".css", ".js")):
        resp.headers["Cache-Control"] = "no-store"
    return resp


app.mount("/", StaticFiles(directory=WEB, html=True), name="web")


if __name__ == "__main__":
    import uvicorn

    print(f"http://{HOST}:{PORT}")
    uvicorn.run("server:app", host="127.0.0.1", port=PORT, reload=False)
