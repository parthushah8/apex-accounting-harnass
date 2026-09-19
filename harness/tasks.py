from __future__ import annotations

import json
import re
from pathlib import Path

from .config import TASKS_DIR


def slug_from_name(task_name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", task_name.lower()).strip("_")


def load_tasks() -> list[dict]:
    tasks = []
    for path in sorted(TASKS_DIR.glob("*.json")):
        task = json.loads(path.read_text())
        task["slug"] = path.stem
        task["source_file"] = str(path)
        tasks.append(task)
    return tasks


def get_task(task_id: str) -> dict:
    for task in load_tasks():
        if task["task_id"] == task_id or task["slug"] == task_id:
            return task
    raise KeyError(task_id)


def public_task(task: dict) -> dict:
    return {
        "task_id": task["task_id"],
        "slug": task["slug"],
        "task_name": task["task_name"],
        "prompt": task["prompt"],
        "category": task.get("metadata", {}).get("category"),
        "subcategory": task.get("metadata", {}).get("subcategory"),
        "hours": task.get("metadata", {}).get("estimated_completion_hours"),
        "rubric_count": len(task.get("rubric", [])),
        "context_files": task.get("context_files", []),
    }
