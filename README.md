# APEX Loop Harness

Local Archipelago-style loop: tools + model + live UI.

```bash
cd apex-harness
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python3 server.py
```

Open http://127.0.0.1:8765

- **local** — Task 30 only. Real tools against the workpapers. No key.
- **groq** — paste a free key from https://console.groq.com/keys
- **gemini** — Google AI Studio key

The official QBO tool layer is not in the public APEX drop. This mount flattens `world/filesystem` + `apps_data/quickbooks` + `task_files` so the agent can still close the books from the source files.
