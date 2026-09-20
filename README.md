# APEX Loop Harness

Local Archipelago-style loop: tools + model + live UI.

AI loop harness (step loop, tools, pause/inject, events): **[ARCHITECTURE.md](./ARCHITECTURE.md)**.

```bash
cd apex-harness
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
./setup-domain.sh   # maps apex-accounting-harness.ai → 127.0.0.1 (needs sudo)
./run.sh
```

Open http://apex-accounting-harness.ai:8765

While a run is live, use the bottom bar: **Pause** holds the agent between steps; **Send** injects a correction into the next LLM turn (groq/gemini). Tool calls render as highlighted cards (args + output).

- **local** — Task 30 only. Real tools against the workpapers. No key.
- **groq** — paste a free key from https://console.groq.com/keys
- **gemini** — Google AI Studio key

The official QBO tool layer is not in the public APEX drop. This mount flattens `world/filesystem` + `apps_data/quickbooks` + `task_files` so the agent can still close the books from the source files.
