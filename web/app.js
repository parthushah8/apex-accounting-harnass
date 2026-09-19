const $ = (id) => document.getElementById(id);
const state = { tasks: [], status: null, selected: null, source: null, timer: null, t0: 0 };

async function boot() {
  const [tasks, status] = await Promise.all([
    fetch("/api/tasks").then((r) => r.json()),
    fetch("/api/status").then((r) => r.json()),
  ]);
  state.tasks = tasks;
  state.status = status;
  const box = $("tasks");
  for (const t of tasks) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "task";
    btn.dataset.id = t.task_id;
    btn.innerHTML = `<div class="who">${esc(t.task_name)} · ${esc(t.category)} · ${t.rubric_count} checks</div><div class="q">${esc(clip(t.prompt, 220))}</div>`;
    btn.addEventListener("click", () => select(t, btn));
    box.appendChild(btn);
  }
}

function select(task, el) {
  state.selected = task;
  document.querySelectorAll(".task").forEach((b) => b.classList.remove("on"));
  el.classList.add("on");
  $("run").disabled = false;
}

function providerFor(task) {
  if (task.slug === "world_9_task_30") return "local";
  if (state.status?.providers?.groq) return "groq";
  if (state.status?.providers?.gemini) return "gemini";
  return "local";
}

$("run").addEventListener("click", () => {
  if (state.selected) start(state.selected);
});
$("back").addEventListener("click", goPick);
$("again").addEventListener("click", goPick);

function goPick() {
  if (state.source) state.source.close();
  if (state.timer) clearInterval(state.timer);
  $("session").classList.add("hidden");
  $("pick").classList.remove("hidden");
  $("done").classList.add("hidden");
  $("log").innerHTML = "";
  $("run").disabled = !state.selected;
}

async function start(task) {
  $("pick").classList.add("hidden");
  $("session").classList.remove("hidden");
  $("done").classList.add("hidden");
  $("log").innerHTML = "";
  $("sess-name").textContent = task.task_name;
  $("sess-prompt").textContent = task.prompt;
  $("sess-live").textContent = "starting";
  $("answer").textContent = "";
  $("rubric").innerHTML = "";
  $("score").textContent = "";
  state.t0 = Date.now();
  state.timer = setInterval(() => {
    const live = $("sess-live").dataset.base || "running";
    $("sess-live").textContent = `${live} · ${((Date.now() - state.t0) / 1000).toFixed(1)}s`;
  }, 200);

  const res = await fetch("/api/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      task_id: task.task_id,
      provider: providerFor(task),
      max_steps: 40,
    }),
  });
  const { run_id } = await res.json();
  const src = new EventSource(`/api/runs/${run_id}/events`);
  state.source = src;
  src.onmessage = (e) => onEvent(JSON.parse(e.data));
  src.onerror = () => {
    src.close();
    if (state.timer) clearInterval(state.timer);
  };
}

function onEvent(ev) {
  switch (ev.type) {
    case "run_started":
      setLive(`${ev.provider}`);
      break;
    case "step_started":
      setLive(`step ${ev.step}`);
      break;
    case "llm_thinking":
    case "llm_text":
      add("think", "Thinking", ev.text);
      break;
    case "tool_call":
      add(
        "tool",
        ev.name,
        `<details><summary>args</summary><pre>${esc(shortArgs(ev.name, ev.args))}</pre></details>`
      );
      break;
    case "tool_result":
      add(
        ev.ok ? "tool" : "err",
        `${ev.name} ${ev.ok ? "ok" : "failed"} · ${ev.ms}ms`,
        `<details ${ev.ok ? "" : "open"}><summary>${ev.ok ? "output" : "error"}</summary><pre>${esc(clip(ev.preview, 4000))}</pre></details>`
      );
      break;
    case "answer":
      $("answer").textContent = ev.text;
      break;
    case "grade":
      $("done").classList.remove("hidden");
      $("score").textContent = `${ev.passed}/${ev.total}`;
      $("score").className = ev.score === 1 ? "ok" : "bad";
      $("rubric").innerHTML = ev.criteria
        .map((c) => `<div class="crit ${c.met ? "met" : "miss"}">${c.met ? "✓" : "✗"} ${esc(c.description)}</div>`)
        .join("");
      break;
    case "error":
      add("err", "Error", ev.message);
      setLive("error");
      break;
    case "run_finished":
      setLive(ev.status || "done");
      if (state.timer) clearInterval(state.timer);
      if (state.source) state.source.close();
      $("sess-live").textContent = `${ev.status} · ${((ev.elapsed_ms || Date.now() - state.t0) / 1000).toFixed(1)}s`;
      if (ev.answer && !$("answer").textContent) $("answer").textContent = ev.answer;
      $("done").classList.remove("hidden");
      $("done").scrollIntoView({ behavior: "smooth", block: "start" });
      break;
    default:
      break;
  }
}

function setLive(base) {
  $("sess-live").dataset.base = base;
  $("sess-live").textContent = `${base} · ${((Date.now() - state.t0) / 1000).toFixed(1)}s`;
}

function add(kind, label, body) {
  const el = document.createElement("div");
  el.className = `item ${kind}`;
  el.innerHTML = `<div class="k">${esc(label)}</div>${String(body).startsWith("<") ? body : `<div class="body">${esc(body)}</div>`}`;
  $("log").appendChild(el);
  el.scrollIntoView({ block: "end" });
}

function shortArgs(name, args) {
  if (name === "run_python") return args.code || "";
  return JSON.stringify(args, null, 2);
}

function clip(s, n) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

boot();
