from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parent
APEX = REPO / "apex-accounting"
WORLD_FS = APEX / "world" / "filesystem"
APPS_DATA = APEX / "world" / "apps_data" / "quickbooks"
TASKS_DIR = APEX / "tasks"
TASK_FILES = APEX / "task_files"
RUN_DIR = ROOT / ".run"

load_dotenv(ROOT / ".env")


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


PROVIDER = env("APEX_PROVIDER", "groq")
DEFAULT_MODELS = {
    "groq": "openai/gpt-oss-120b",
    "gemini": "gemini-2.5-flash",
    "openai": "gpt-4.1-mini",
    "local": "local-loop",
}
MODEL = env("APEX_MODEL") or DEFAULT_MODELS.get(PROVIDER, "openai/gpt-oss-120b")
MAX_STEPS = int(env("APEX_MAX_STEPS", "40"))
MAX_TOKENS = int(env("APEX_MAX_TOKENS", "200000"))
HOST = env("APEX_HOST", "apex-accounting-harness.ai")
PORT = int(env("APEX_PORT", "8765"))


def provider_status() -> dict:
    return {
        "groq": bool(env("GROQ_API_KEY")),
        "gemini": bool(env("GOOGLE_API_KEY")),
        "openai": bool(env("OPENAI_API_KEY")),
        "local": True,
    }


def client_kwargs(provider: str, api_key: str | None = None) -> dict:
    key = (api_key or "").strip()
    if provider == "groq":
        return {
            "base_url": "https://api.groq.com/openai/v1",
            "api_key": key or env("GROQ_API_KEY"),
        }
    if provider == "gemini":
        return {
            "base_url": "https://generativelanguage.googleapis.com/v1beta/openai/",
            "api_key": key or env("GOOGLE_API_KEY"),
        }
    if provider == "openai":
        return {"api_key": key or env("OPENAI_API_KEY")}
    raise ValueError(f"unknown provider {provider}")
