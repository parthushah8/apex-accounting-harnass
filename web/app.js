const $ = (id) => document.getElementById(id);
const state = {
  tasks: [],
  status: null,
  lastId: null,
  source: null,
  timer: null,
  t0: 0,
  runId: null,
  live: false,
  paused: false,
  cards: new Map(), // call_id -> tool card element
};

async function boot() {
  const [tasks, status] = await Promise.all([
    fetch("/api/tasks").then((r) => r.json()),
    fetch("/api/status").then((r) => r.json()),
  ]);
  state.tasks = tasks;
  state.status = status;
  start(pick());
}

function pick() {
  const pool = state.tasks.filter((t) => t.task_id !== state.lastId);
  const list = pool.length ? pool : state.tasks;
  return list[Math.floor(Math.random() * list.length)];
}

function providerFor(task) {
  if (task.slug === "world_9_task_30") return "local";
  if (state.status?.providers?.groq) return "groq";
  if (state.status?.providers?.gemini) return "gemini";
  return "local";
}

$("again").addEventListener("click", () => start(pick()));

async function start(task) {
  if (state.source) state.source.close();
  if (state.timer) clearInterval(state.timer);
  state.lastId = task.task_id;
  state.cards.clear();
  state.paused = false;
  $("done").classList.add("hidden");
  $("log").innerHTML = "";
  $("sess-name").textContent = `${task.task_name} · ${task.category}`;
  $("sess-prompt").textContent = task.prompt;
  $("sess-live").textContent = "starting";
  $("answer").textContent = "";
  $("rubric").innerHTML = "";
  $("score").textContent = "";
  $("score").className = "";
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
  state.runId = run_id;
  setComposer(true);
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
      setLive(ev.provider);
      break;
    case "step_started":
      setLive(`step ${ev.step}`);
      addStepDivider(ev);
      break;
    case "llm_thinking":
      add("think", "Thinking", ev.text);
      break;
    case "llm_text":
      add("agent", "Agent", ev.text);
      break;
    case "tool_call":
      addToolCard(ev);
      break;
    case "tool_result":
      resolveToolCard(ev);
      break;
    case "user_message":
      add("user", "You", ev.text);
      break;
    case "user_message_injected":
      addNote(`↳ delivered to the agent at step ${ev.step}`);
      break;
    case "paused":
      state.paused = true;
      setLive("paused");
      updatePauseBtn();
      addNote("run paused — the agent will hold before its next step");
      break;
    case "resumed":
      state.paused = false;
      setLive("running");
      updatePauseBtn();
      addNote(ev.reason === "user message" ? "resumed by your message" : "resumed");
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
      setComposer(false);
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

// ---------- log rendering ----------

function addStepDivider(ev) {
  const el = document.createElement("div");
  el.className = "step-div";
  const tok = ev.tokens_used ? ` · ${(ev.tokens_used / 1000).toFixed(1)}k tok` : "";
  el.innerHTML = `<span>step ${ev.step}${tok}</span>`;
  $("log").appendChild(el);
  el.scrollIntoView({ block: "end" });
}

function addToolCard(ev) {
  const el = document.createElement("div");
  el.className = "tcard";
  el.innerHTML = `
    <div class="tcard-head">
      <span class="tname">${esc(ev.name)}</span>
      <span class="tstat run">running…</span>
    </div>
    <details class="tsec"><summary>args</summary><pre>${esc(shortArgs(ev.name, ev.args))}</pre></details>
  `;
  state.cards.set(ev.call_id, el);
  $("log").appendChild(el);
  el.scrollIntoView({ block: "end" });
}

function resolveToolCard(ev) {
  let el = state.cards.get(ev.call_id);
  if (!el) {
    // result without a visible call (shouldn't happen) — make a card so nothing is lost
    addToolCard({ call_id: ev.call_id, name: ev.name, args: {} });
    el = state.cards.get(ev.call_id);
  }
  const stat = el.querySelector(".tstat");
  stat.textContent = `${ev.ok ? "ok" : "failed"} · ${ev.ms}ms`;
  stat.className = `tstat ${ev.ok ? "ok" : "bad"}`;
  el.classList.add(ev.ok ? "done-ok" : "done-bad");
  const out = document.createElement("details");
  out.className = "tsec";
  if (!ev.ok) out.open = true;
  out.innerHTML = `<summary>${ev.ok ? "output" : "error"} · ${ev.chars} chars</summary><pre>${esc(clip(ev.preview, 4000))}</pre>`;
  el.appendChild(out);
  el.scrollIntoView({ block: "end" });
}

function add(kind, label, body) {
  const el = document.createElement("div");
  el.className = `item ${kind}`;
  el.innerHTML = `<div class="k">${esc(label)}</div><div class="body">${esc(body)}</div>`;
  $("log").appendChild(el);
  el.scrollIntoView({ block: "end" });
}

function addNote(text) {
  const el = document.createElement("div");
  el.className = "note";
  el.textContent = text;
  $("log").appendChild(el);
  el.scrollIntoView({ block: "end" });
}

// ---------- composer ----------

function setComposer(live) {
  state.live = live;
  $("composer").classList.toggle("hidden", !live);
  document.body.classList.toggle("has-composer", live);
  if (live) {
    state.paused = false;
    updatePauseBtn();
  }
}

function updatePauseBtn() {
  $("pause").textContent = state.paused ? "Resume" : "Pause";
  $("pause").classList.toggle("paused", state.paused);
}

async function sendMessage() {
  const text = $("say").value.trim();
  if (!text || !state.runId || !state.live) return;
  $("say").value = "";
  await fetch(`/api/runs/${state.runId}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  }).catch(() => {});
}

$("send").addEventListener("click", sendMessage);
$("say").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
$("pause").addEventListener("click", async () => {
  if (!state.runId || !state.live) return;
  const action = state.paused ? "resume" : "pause";
  await fetch(`/api/runs/${state.runId}/${action}`, { method: "POST" }).catch(() => {});
});

// ---------- utils ----------

function setLive(base) {
  $("sess-live").dataset.base = base;
  $("sess-live").textContent = `${base} · ${((Date.now() - state.t0) / 1000).toFixed(1)}s`;
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
