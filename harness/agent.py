from __future__ import annotations

import asyncio
import json
import time
import traceback
import uuid
from pathlib import Path
from typing import Any, Callable

from .config import DEFAULT_MODELS, MAX_STEPS, MAX_TOKENS, RUN_DIR, client_kwargs
from .grader import grade_answer
from .tasks import get_task
from .tools import TOOL_SCHEMA, ToolError, Toolbelt, preview
from .workspace import mount_workspace

SYSTEM = """You are a staff accountant inside a synthetic company's month-end close.

Rules:
- The prompt is the complete task. You are not given a file list. Find evidence in the filesystem.
- Never invent numbers. Read source files. Use run_python + pandas/openpyxl for arithmetic.
- Do not round intermediate values. Follow the prompt's rounding for final figures.
- Amounts in $ unless the prompt asks for %.
- Final deliverable is a console message. Call submit_answer once when done.
- If you are told you are out of steps or tokens, submit immediately.

Tools: list_dir, read_file, inspect_xlsx, read_xlsx, read_pdf, run_python, submit_answer.
"""

Emit = Callable[[dict], Any]


class LoopHarness:
    def __init__(
        self,
        emit: Emit,
        inbox: asyncio.Queue | None = None,
        gate: asyncio.Event | None = None,
    ):
        self.emit = emit
        self.inbox = inbox
        self.gate = gate

    async def _checkpoint(self, messages: list[dict] | None, step: int) -> None:
        """Between steps: block while paused, then inject any queued human corrections."""
        if self.gate is not None and not self.gate.is_set():
            await self.gate.wait()
        if self.inbox is None:
            return
        while True:
            try:
                text = self.inbox.get_nowait()
            except asyncio.QueueEmpty:
                break
            await self.emit({"type": "user_message_injected", "step": step, "text": text})
            if messages is not None:
                messages.append(
                    {
                        "role": "user",
                        "content": (
                            "[human operator interrupt] The human supervising this run says:\n"
                            f"{text}\n"
                            "This overrides your current approach. Acknowledge and adjust."
                        ),
                    }
                )
            else:
                await self.emit(
                    {
                        "type": "llm_text",
                        "step": step,
                        "text": (
                            "[local scripted run — human note recorded but cannot reroute this solver. "
                            f"Use groq/gemini to steer the agent.] {text}"
                        ),
                    }
                )

    async def run(
        self,
        task_id: str,
        provider: str = "groq",
        model: str | None = None,
        api_key: str | None = None,
        max_steps: int = MAX_STEPS,
        max_tokens: int = MAX_TOKENS,
    ) -> dict:
        task = get_task(task_id)
        model = model or DEFAULT_MODELS.get(provider, "openai/gpt-oss-120b")
        run_id = uuid.uuid4().hex[:10]
        ws = RUN_DIR / run_id / "fs"
        files = mount_workspace(ws, task["slug"])
        tools = Toolbelt(ws)
        t0 = time.time()
        tokens_used = 0

        await self.emit(
            {
                "type": "run_started",
                "run_id": run_id,
                "provider": provider,
                "model": model,
                "max_steps": max_steps,
                "max_tokens": max_tokens,
                "task": {
                    "task_id": task["task_id"],
                    "slug": task["slug"],
                    "task_name": task["task_name"],
                    "prompt": task["prompt"],
                    "category": task.get("metadata", {}).get("category"),
                    "hours": task.get("metadata", {}).get("estimated_completion_hours"),
                    "rubric": task.get("rubric", []),
                },
            }
        )
        await self.emit({"type": "workspace_ready", "files": files, "root": str(ws)})
        await self.emit(
            {
                "type": "harness_prompt",
                "system": SYSTEM,
                "user": task["prompt"],
            }
        )

        try:
            if provider == "local":
                answer = await self._local(task, tools, max_steps)
            else:
                answer = await self._llm(
                    task, tools, provider, model, api_key, max_steps, max_tokens
                )
                tokens_used = getattr(self, "_tokens", 0)
        except Exception as exc:
            await self.emit({"type": "error", "message": str(exc), "trace": traceback.format_exc()})
            await self.emit({"type": "run_finished", "status": "error", "elapsed_ms": int((time.time() - t0) * 1000)})
            raise

        if not answer:
            await self.emit({"type": "error", "message": "agent did not call submit_answer — score 0"})
            grade = grade_answer("", task.get("rubric", []))
            grade["score"] = 0
            grade["passed"] = 0
            status = "no_submit"
        else:
            await self.emit({"type": "answer", "text": answer})
            grade = grade_answer(answer, task.get("rubric", []))
            status = "submitted"

        await self.emit({"type": "grade", **grade, "gold": task.get("gold_output")})
        result = {
            "run_id": run_id,
            "status": status,
            "answer": answer,
            "grade": grade,
            "tokens_used": tokens_used,
            "files_touched": tools.touched,
            "elapsed_ms": int((time.time() - t0) * 1000),
        }
        await self.emit({"type": "run_finished", **result})
        return result

    async def _llm(
        self,
        task: dict,
        tools: Toolbelt,
        provider: str,
        model: str,
        api_key: str | None,
        max_steps: int,
        max_tokens: int,
    ) -> str | None:
        from openai import AsyncOpenAI

        kw = client_kwargs(provider, api_key)
        if not kw.get("api_key"):
            raise RuntimeError(f"no API key for {provider}. paste one in the UI or set the env var.")
        client = AsyncOpenAI(**kw)
        messages: list[dict] = [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": task["prompt"]},
        ]
        self._tokens = 0

        for step in range(1, max_steps + 1):
            await self._checkpoint(messages, step)
            remaining = max_steps - step
            tok_left = max(0, max_tokens - self._tokens)
            if remaining == 0 or tok_left < 800:
                messages.append(
                    {
                        "role": "user",
                        "content": "[harness] last turn. submit_answer now or you score zero.",
                    }
                )

            await self.emit(
                {
                    "type": "step_started",
                    "step": step,
                    "steps_remaining": remaining,
                    "tokens_used": self._tokens,
                    "tokens_remaining": tok_left,
                }
            )
            await self.emit(
                {
                    "type": "llm_request",
                    "step": step,
                    "model": model,
                    "messages": len(messages),
                }
            )

            try:
                resp = await client.chat.completions.create(
                    model=model,
                    messages=messages,
                    tools=TOOL_SCHEMA,
                    temperature=0.1,
                    extra_body={"reasoning_effort": "medium"} if provider == "groq" else {},
                )
            except Exception:
                # groq extra_body can fail on some models
                resp = await client.chat.completions.create(
                    model=model,
                    messages=messages,
                    tools=TOOL_SCHEMA,
                    temperature=0.1,
                )

            usage = resp.usage
            if usage:
                self._tokens += usage.total_tokens or 0
                await self.emit(
                    {
                        "type": "tokens",
                        "step": step,
                        "prompt": usage.prompt_tokens,
                        "completion": usage.completion_tokens,
                        "total": self._tokens,
                    }
                )

            choice = resp.choices[0]
            msg = choice.message
            text = msg.content or ""
            reasoning = getattr(msg, "reasoning") or getattr(msg, "reasoning_content", None)
            if reasoning:
                await self.emit({"type": "llm_thinking", "step": step, "text": reasoning})
            if text:
                await self.emit({"type": "llm_text", "step": step, "text": text})

            tool_calls = msg.tool_calls or []
            assistant = {
                "role": "assistant",
                "content": text or None,
            }
            if tool_calls:
                assistant["tool_calls"] = [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {"name": tc.function.name, "arguments": tc.function.arguments},
                    }
                    for tc in tool_calls
                ]
            messages.append(assistant)

            if not tool_calls:
                if text and step >= max_steps:
                    tools.answer = text
                    return text
                messages.append(
                    {
                        "role": "user",
                        "content": "[harness] no tool call. use tools or submit_answer.",
                    }
                )
                continue

            for tc in tool_calls:
                name = tc.function.name
                try:
                    args = json.loads(tc.function.arguments or "{}")
                except json.JSONDecodeError:
                    args = {}
                call_id = tc.id or uuid.uuid4().hex
                await self.emit({"type": "tool_call", "step": step, "call_id": call_id, "name": name, "args": args})
                t1 = time.time()
                try:
                    result, answer = tools.dispatch(name, args)
                    ok = True
                except (ToolError, TypeError) as exc:
                    result, answer = str(exc), tools.answer
                    ok = False
                ms = int((time.time() - t1) * 1000)
                for touch in tools.touched[-3:]:
                    await self.emit({"type": "file_touch", "step": step, **touch})
                await self.emit(
                    {
                        "type": "tool_result",
                        "step": step,
                        "call_id": call_id,
                        "name": name,
                        "ok": ok,
                        "ms": ms,
                        "chars": len(result),
                        "preview": preview(result, 6000),
                    }
                )
                messages.append({"role": "tool", "tool_call_id": call_id, "content": result[:24000]})
                if answer:
                    return answer

        return tools.answer

    async def _local(self, task: dict, tools: Toolbelt, max_steps: int) -> str | None:
        slug = task["slug"]
        if slug != "world_9_task_30":
            await self.emit(
                {
                    "type": "llm_text",
                    "step": 1,
                    "text": "local provider only ships a scripted solver for Task 30. pick groq/gemini and paste a key.",
                }
            )
            await self._call(tools, 1, "list_dir", {"path": "."})
            return None

        plan = [
            (
                1,
                "Locate the AR aging workpaper and the closing TB. No file list was given — browse.",
                "list_dir",
                {"path": "."},
            ),
            (
                2,
                "Inspect workpaper_ar_aging_2024_12_31.xlsx — sheets, headers, aging basis.",
                "inspect_xlsx",
                {"path": "workpaper_ar_aging_2024_12_31.xlsx", "max_rows": 8},
            ),
            (
                3,
                "Cross-check qbo_closing_trial_balance_2024_12_31.xlsx for AR (1100) existence.",
                "inspect_xlsx",
                {"path": "qbo_closing_trial_balance_2024_12_31.xlsx", "max_rows": 20},
            ),
            (
                4,
                "Do not trust the Bucket label. Re-age from Days Past Due (Net 30). Print labeled vs corrected.",
                "run_python",
                {
                    "code": """
import openpyxl
from collections import OrderedDict

wb = openpyxl.load_workbook('workpaper_ar_aging_2024_12_31.xlsx', data_only=True)
ws = wb['Invoice Detail']
rows = list(ws.iter_rows(values_only=True))
for i, r in enumerate(rows):
    if r and r[0] == 'Invoice':
        header, data = r, rows[i + 1:]
        break
idx = {h: n for n, h in enumerate(header)}

def age(dpd):
    if dpd is None:
        return None
    dpd = int(dpd)
    if dpd <= 0:
        return 'Current'
    if dpd <= 30:
        return '1-30'
    if dpd <= 60:
        return '31-60'
    if dpd <= 90:
        return '61-90'
    return '>90'

order = ['Current', '1-30', '31-60', '61-90', '>90']
labeled = OrderedDict((b, 0.0) for b in order)
fixed = OrderedDict((b, 0.0) for b in order)
for r in data:
    if not r or not r[0]:
        continue
    amt = float(r[idx['Outstanding']] or 0)
    lab = r[idx['Bucket']]
    if lab in labeled:
        labeled[lab] += amt
    b = age(r[idx['Days Past Due']])
    if b:
        fixed[b] += amt
    if lab != b:
        print(f'MISLABEL {r[0]} dpd={r[idx["Days Past Due"]]} labeled={lab} correct={b} amt={amt}')

grand = sum(fixed.values())
print(f'Total outstanding: {grand:.10f}')
print('bucket\\tlabeled_%\\tcorrected_%\\tcorrected_2dp')
for b in order:
    lp = labeled[b] / grand * 100
    fp = fixed[b] / grand * 100
    print(f'{b}\\t{lp:.10f}\\t{fp:.10f}\\t{fp:.2f}%')
"""
                },
            ),
        ]

        py_out = ""
        for step, thought, name, args in plan:
            await self._checkpoint(None, step)
            await self.emit(
                {
                    "type": "step_started",
                    "step": step,
                    "steps_remaining": max_steps - step,
                    "tokens_used": 0,
                    "tokens_remaining": 0,
                }
            )
            await self.emit({"type": "llm_thinking", "step": step, "text": thought})
            await asyncio.sleep(0.25)
            raw = await self._call(tools, step, name, args)
            if name == "run_python":
                py_out = raw
            await asyncio.sleep(0.15)

        pct = {}
        for line in py_out.splitlines():
            parts = line.split("\t")
            if len(parts) >= 4 and parts[0] in {"Current", "1-30", "31-60", "61-90", ">90"}:
                pct[parts[0]] = parts[3]
        answer = (
            "Aging Bucket in days\t  --      Exposure in %\n"
            f"Current\t                      --        {pct.get('Current', '?')}\n"
            f"1-30\t                              --        {pct.get('1-30', '?')}\n"
            f"31-60 \t                          --         {pct.get('31-60', '?')}\n"
            f"61-90 \t                          --         {pct.get('61-90', '?')}\n"
            f">90\t                              --         {pct.get('>90', '?')}"
        )
        await self.emit({"type": "step_started", "step": 5, "steps_remaining": max_steps - 5, "tokens_used": 0, "tokens_remaining": 0})
        await self.emit(
            {
                "type": "llm_thinking",
                "step": 5,
                "text": "Invoice-detail outstanding / total. Rounded to 2 decimals for the console only.",
            }
        )
        await self._call(tools, 5, "submit_answer", {"answer": answer})
        return answer

    async def _call(self, tools: Toolbelt, step: int, name: str, args: dict) -> str:
        call_id = uuid.uuid4().hex[:8]
        await self.emit({"type": "tool_call", "step": step, "call_id": call_id, "name": name, "args": args})
        t1 = time.time()
        try:
            result, _ = tools.dispatch(name, args)
            ok = True
        except (ToolError, TypeError) as exc:
            result = str(exc)
            ok = False
        ms = int((time.time() - t1) * 1000)
        for touch in tools.touched[-4:]:
            await self.emit({"type": "file_touch", "step": step, **touch})
        await self.emit(
            {
                "type": "tool_result",
                "step": step,
                "call_id": call_id,
                "name": name,
                "ok": ok,
                "ms": ms,
                "chars": len(result),
                "preview": preview(result, 6000),
            }
        )
        return result
