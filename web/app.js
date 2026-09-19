const $ = (id) => document.getElementById(id);

const HISTORY_KEY = "apex_workbench_history_v1";
const PROVIDER_LABELS = {
  groq: "Groq",
  gemini: "Google Gemini",
  openai: "OpenAI",
  local: "Local (scripted)",
};

const FILE_STATUS_LABEL = {
  available: "Available",
  reading: "Reading",
  in_use: "In use",
  completed: "Completed",
  not_accessed: "Not accessed",
};

const TOOL_LABELS = {
  list_dir: "List directory",
  read_file: "Read file",
  inspect_xlsx: "Inspect spreadsheet",
  read_xlsx: "Read spreadsheet",
  read_pdf: "Read PDF",
  run_python: "Python analysis",
  submit_answer: "Submit answer",
};

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
  interrupted: false,
  waiting: false,
  agentStatus: "idle",
  currentTask: null,
  provider: null,
  model: null,
  files: new Map(), // path -> { path, status, dir }
  cards: new Map(), // call_id -> { el, argsEl, outEl, statEl }
  lastGrade: null,
  lastAnswer: null,
  history: loadHistory(),
  llmPhase: 0,
};

// ---------- boot ----------

async function boot() {
  const [tasks, status] = await Promise.all([
    fetch("/api/tasks").then((r) => r.json()),
    fetch("/api/status").then((r) => r.json()),
  ]);
  state.tasks = tasks;
  state.status = status;
  fillTaskSelect();
  fillProviderSelect();
  updateModelSelect();
  syncTaskPanel();
  renderHistory();
  setAgentStatus("idle");
  showSetup(true);
  $("sel-task").addEventListener("change", syncTaskPanel);
}

function fillTaskSelect() {
  const sel = $("sel-task");
  sel.innerHTML = state.tasks
    .map(
      (t) =>
        `<option value="${escAttr(t.task_id)}">${esc(t.task_name)}${
          t.category ? ` · ${esc(t.category)}` : ""
        }</option>`
    )
    .join("");
}

function syncTaskPanel() {
  const task = taskById($("sel-task").value);
  if (!task) {
    $("task-id").textContent = "—";
    $("task-category").textContent = "—";
    $("task-prompt").value = "";
    $("prompt-chars").textContent = "0 characters";
    return;
  }
  $("task-id").textContent = task.task_id;
  $("task-category").textContent = task.category || "—";
  $("task-prompt").value = task.prompt || "";
  const n = (task.prompt || "").length;
  $("prompt-chars").textContent = `${n} character${n === 1 ? "" : "s"}`;
}

function fillProviderSelect() {
  const sel = $("sel-provider");
  const providers = state.status?.providers || {};
  const defaults = state.status?.defaults || {};
  const keys = Object.keys(providers);
  // Prefer configured providers first
  const ordered = ["groq", "openai", "gemini", "local"].filter((k) => k in providers);
  keys.forEach((k) => {
    if (!ordered.includes(k)) ordered.push(k);
  });
  sel.innerHTML = ordered
    .map((k) => {
      const ok = providers[k];
      const label = PROVIDER_LABELS[k] || k;
      const mark = ok ? "" : " (no key)";
      return `<option value="${escAttr(k)}" ${ok ? "" : ""}>${esc(label)}${mark}</option>`;
    })
    .join("");

  // Prefer first available with key, else local
  const preferred =
    ordered.find((k) => providers[k] && k !== "local") ||
    (providers.local ? "local" : ordered[0]);
  if (preferred) sel.value = preferred;

  sel.onchange = () => {
    updateModelSelect();
    updateProviderHint();
    syncAgentKvPreview();
  };
  updateProviderHint();
  $("sel-model").onchange = syncAgentKvPreview;
}

function syncAgentKvPreview() {
  if (state.live) return;
  const provider = $("sel-provider").value;
  const model = $("sel-model").value;
  $("kv-provider").textContent = PROVIDER_LABELS[provider] || provider || "—";
  $("kv-model").textContent = model || "—";
}

function updateModelSelect() {
  const provider = $("sel-provider").value;
  const defaults = state.status?.defaults || {};
  const model = defaults[provider] || "";
  const sel = $("sel-model");
  // Use backend defaults; allow free-form via single option + custom if needed
  const options = new Set();
  if (model) options.add(model);
  // Sensible extras per provider without hard-coding as sole source of truth
  if (provider === "openai") {
    ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini"].forEach((m) => options.add(m));
  } else if (provider === "gemini") {
    ["gemini-2.5-flash", "gemini-2.0-flash"].forEach((m) => options.add(m));
  } else if (provider === "groq") {
    ["openai/gpt-oss-120b", "llama-3.3-70b-versatile"].forEach((m) => options.add(m));
  } else if (provider === "local") {
    options.add("local-loop");
  }
  sel.innerHTML = [...options]
    .map((m) => `<option value="${escAttr(m)}">${esc(m)}</option>`)
    .join("");
  if (model) sel.value = model;
  syncAgentKvPreview();
}

function updateProviderHint() {
  const provider = $("sel-provider").value;
  const ok = state.status?.providers?.[provider];
  const el = $("provider-hint");
  if (provider === "local") {
    el.textContent = "Local runs a scripted solver for Task 30 only — no API key required.";
  } else if (!ok) {
    el.textContent = `No API key detected for ${PROVIDER_LABELS[provider] || provider}. Set it in .env or the run may fail.`;
  } else {
    el.textContent = `Using ${PROVIDER_LABELS[provider] || provider} · model from server defaults unless changed.`;
  }
}

// ---------- start / pick ----------

function pickRandom() {
  const pool = state.tasks.filter((t) => t.task_id !== state.lastId);
  const list = pool.length ? pool : state.tasks;
  return list[Math.floor(Math.random() * list.length)];
}

function taskById(id) {
  return state.tasks.find((t) => t.task_id === id || t.slug === id);
}

$("btn-start").addEventListener("click", () => {
  const task = taskById($("sel-task").value);
  if (!task) return;
  start(task);
});

$("btn-random").addEventListener("click", () => {
  const task = pickRandom();
  if (!task) return;
  $("sel-task").value = task.task_id;
  syncTaskPanel();
  start(task);
});

$("btn-new-run").addEventListener("click", () => {
  softStop();
  showSetup(true);
  setAgentStatus("idle");
  clearWorkspace();
  syncTaskPanel();
  $("kv-model").textContent = $("sel-model").value || "—";
  $("kv-provider").textContent =
    PROVIDER_LABELS[$("sel-provider").value] || $("sel-provider").value || "—";
  $("kv-run").textContent = "—";
  $("center-title").textContent = "Agent Activity";
  $("center-sub").textContent = "Observable actions only — the agent works autonomously";
  setRunControlsEnabled(true);
});

function setRunControlsEnabled(on) {
  $("btn-start").disabled = !on;
  $("btn-random").disabled = !on;
  $("sel-task").disabled = !on;
  $("sel-provider").disabled = !on;
  $("sel-model").disabled = !on;
}

async function start(task) {
  softStop();
  state.lastId = task.task_id;
  state.currentTask = task;
  state.cards.clear();
  state.files.clear();
  state.paused = false;
  state.interrupted = false;
  state.waiting = false;
  state.lastGrade = null;
  state.lastAnswer = null;
  state.llmPhase = 0;
  state.provider = $("sel-provider").value;
  state.model = $("sel-model").value;

  syncTaskPanel();
  $("kv-model").textContent = state.model;
  $("kv-provider").textContent = PROVIDER_LABELS[state.provider] || state.provider;
  $("kv-run").textContent = "…";
  $("file-list").innerHTML = `<li class="empty">Mounting workspace…</li>`;
  $("file-count").textContent = "…";
  $("timeline").innerHTML = "";
  $("answer").textContent = "";
  $("rubric").innerHTML = "";
  $("score").textContent = "";
  $("score").className = "score";
  $("waiting-block").classList.add("hidden");

  showSetup(false);
  showResult(false);
  $("timeline-wrap").classList.remove("hidden");
  $("center-title").textContent = "Agent Activity";
  $("center-sub").textContent = task.task_name;
  setRunControlsEnabled(false);

  state.t0 = Date.now();
  if (state.timer) clearInterval(state.timer);
  state.timer = setInterval(() => {
    $("live-timer").textContent = `${((Date.now() - state.t0) / 1000).toFixed(1)}s`;
  }, 200);

  setAgentStatus("running");
  setComposer(true);

  addEvent({
    kind: "start",
    icon: "●",
    type: "Task started",
    desc: `Agent started APEX task “${task.task_name}”`,
    status: "running",
  });

  const res = await fetch("/api/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      task_id: task.task_id,
      provider: state.provider,
      model: state.model,
      max_steps: 40,
    }),
  });
  const { run_id } = await res.json();
  state.runId = run_id;
  $("kv-run").textContent = run_id;

  const src = new EventSource(`/api/runs/${run_id}/events`);
  state.source = src;
  src.onmessage = (e) => onEvent(JSON.parse(e.data));
  src.onerror = () => {
    src.close();
    if (state.timer) clearInterval(state.timer);
    if (state.live) setAgentStatus(state.interrupted ? "interrupted" : "failed");
    setComposer(false);
    setRunControlsEnabled(true);
  };
}

function softStop() {
  if (state.source) {
    state.source.close();
    state.source = null;
  }
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  state.live = false;
}

// ---------- SSE events ----------

function onEvent(ev) {
  switch (ev.type) {
    case "run_started":
      if (ev.model) {
        state.model = ev.model;
        $("kv-model").textContent = ev.model;
      }
      if (ev.provider) {
        state.provider = ev.provider;
        $("kv-provider").textContent = PROVIDER_LABELS[ev.provider] || ev.provider;
      }
      setLiveLabel(`running · ${ev.provider || ""}`);
      break;

    case "workspace_ready":
      mountFiles(ev.files || []);
      addEvent({
        kind: "workspace",
        icon: "▣",
        type: "Workspace inspected",
        desc: `Agent inspected available workspace files (${(ev.files || []).length} available)`,
        status: "ok",
      });
      break;

    case "harness_prompt":
      // Internal — skip (would expose system prompt)
      break;

    case "step_started": {
      const div = document.createElement("div");
      div.className = "step-mark";
      const tok = ev.tokens_used ? ` · ${(ev.tokens_used / 1000).toFixed(1)}k tok` : "";
      div.textContent = `Step ${ev.step}${tok}`;
      $("timeline").appendChild(div);
      setLiveLabel(`step ${ev.step}`);
      break;
    }

    case "llm_request":
      addEvent({
        kind: "llm",
        icon: "◇",
        type: safeLlmLabel(),
        desc: observableLlmDesc(),
        status: "running",
      });
      state.llmPhase += 1;
      break;

    case "llm_thinking":
      // Never show chain-of-thought. Local scripted runs have no llm_request, so emit a safe status.
      if (state.provider === "local") {
        addEvent({
          kind: "llm",
          icon: "◇",
          type: "Analyzing task",
          desc: "Agent is determining next actions",
          status: "running",
        });
      }
      break;

    case "llm_text":
      // Observable agent output (not hidden reasoning) — keep concise
      if (ev.text && String(ev.text).trim()) {
        addEvent({
          kind: "llm",
          icon: "◇",
          type: "Agent update",
          desc: clip(String(ev.text).trim(), 400),
          status: "ok",
        });
      }
      break;

    case "tokens":
      break;

    case "tool_call":
      addToolEvent(ev);
      inferFileFromTool(ev.name, ev.args, "selected");
      break;

    case "tool_result":
      resolveToolEvent(ev);
      break;

    case "file_touch":
      onFileTouch(ev);
      break;

    case "user_message":
      addEvent({
        kind: "human",
        icon: "☺",
        type: "Human Supervisor",
        desc: ev.text,
        status: "ok",
        human: true,
      });
      break;

    case "user_message_injected":
      addEvent({
        kind: "human",
        icon: "↳",
        type: "Agent received guidance",
        desc: `Guidance delivered at step ${ev.step}`,
        status: "ok",
      });
      break;

    case "paused":
      state.paused = true;
      if (!state.interrupted) setAgentStatus("paused");
      updateControlButtons();
      if (!state.interrupted) {
        addEvent({
          kind: "human",
          icon: "Ⅱ",
          type: "Agent paused",
          desc: "Supervisor paused the agent — it will hold before the next step",
          status: "ok",
        });
      }
      break;

    case "resumed":
      state.paused = false;
      state.waiting = false;
      $("waiting-block").classList.add("hidden");
      if (!state.interrupted) setAgentStatus("running");
      updateControlButtons();
      if (!state.interrupted) {
        addEvent({
          kind: "ok",
          icon: "▶",
          type: "Agent resumed",
          desc:
            ev.reason === "user message"
              ? "Agent resumed execution after guidance"
              : "Agent resumed execution",
          status: "ok",
        });
      }
      break;

    case "answer":
      state.lastAnswer = ev.text;
      $("answer").textContent = ev.text;
      addEvent({
        kind: "ok",
        icon: "★",
        type: "Final answer ready",
        desc: "Agent prepared the final deliverable",
        status: "ok",
      });
      break;

    case "grade":
      state.lastGrade = ev;
      renderGrade(ev);
      break;

    case "error":
      addEvent({
        kind: "err",
        icon: "!",
        type: "Error",
        desc: ev.message || "Unknown error",
        status: "bad",
      });
      break;

    case "run_finished": {
      if (state.timer) clearInterval(state.timer);
      if (state.source) state.source.close();
      const st = mapFinishedStatus(ev.status);
      setAgentStatus(st);
      setComposer(false);
      const elapsed = ev.elapsed_ms || Date.now() - state.t0;
      $("live-timer").textContent = `${(elapsed / 1000).toFixed(1)}s`;
      if (ev.answer && !state.lastAnswer) {
        state.lastAnswer = ev.answer;
        $("answer").textContent = ev.answer;
      }
      // Settle file statuses: used → completed, never touched → not accessed
      for (const [path, f] of state.files) {
        if (f.status === "reading" || f.status === "in_use") {
          f.status = "completed";
        } else if (f.status === "available") {
          f.status = "not_accessed";
        }
        updateFileRow(path);
      }
      addEvent({
        kind: st === "failed" || st === "interrupted" ? "err" : "ok",
        icon: st === "completed" ? "✓" : "■",
        type: st === "completed" ? "Task completed" : `Run ${st}`,
        desc: `Status: ${ev.status || st}`,
        status: st === "completed" ? "ok" : "bad",
      });
      if (st === "completed" || state.lastAnswer) {
        showResult(true);
      }
      pushHistory({
        runId: state.runId,
        task: state.currentTask?.task_name || "—",
        taskId: state.currentTask?.task_id,
        model: state.model,
        provider: state.provider,
        status: st,
        durationMs: elapsed,
        score: state.lastGrade
          ? `${state.lastGrade.passed}/${state.lastGrade.total}`
          : "—",
        scoreOk: state.lastGrade?.score === 1,
        date: new Date().toISOString(),
      });
      setRunControlsEnabled(true);
      break;
    }

    case "log":
      break;

    default:
      break;
  }
}

function mapFinishedStatus(s) {
  if (state.interrupted) return "interrupted";
  if (s === "submitted" || s === "done") return "completed";
  if (s === "error" || s === "no_submit") return "failed";
  return s || "completed";
}

function safeLlmLabel() {
  const labels = [
    "Analyzing task",
    "Selecting relevant files",
    "Preparing tool call",
    "Processing tool result",
    "Preparing final response",
  ];
  return labels[state.llmPhase % labels.length];
}

function observableLlmDesc() {
  const descs = [
    "Agent is analyzing the accounting task",
    "Agent is deciding which workspace files are relevant",
    "Agent is preparing the next tool action",
    "Agent is incorporating the latest tool output",
    "Agent is preparing its response",
  ];
  return descs[state.llmPhase % descs.length];
}

// ---------- files ----------

function clearWorkspace() {
  state.files.clear();
  $("file-list").innerHTML = `<li class="empty">Workspace mounts when a run starts</li>`;
  $("file-count").textContent = "0 files";
}

function mountFiles(files) {
  state.files.clear();
  const list = $("file-list");
  list.innerHTML = "";
  const visible = (files || []).filter((f) => !f.dir && !String(f.path).startsWith(".__"));
  if (!visible.length) {
    list.innerHTML = `<li class="empty">No files in workspace</li>`;
    $("file-count").textContent = "0 files";
    return;
  }
  for (const f of visible) {
    const path = f.path;
    state.files.set(path, { path, status: "available", dir: !!f.dir });
    list.appendChild(fileRow(path));
  }
  // After mount, show not_accessed until touched — still "available" initially per spec
  $("file-count").textContent = `${visible.length} files`;
}

function fileRow(path) {
  const f = state.files.get(path);
  const li = document.createElement("li");
  li.className = "file-item";
  li.dataset.path = path;
  li.dataset.status = f.status;
  const name = basename(path);
  const type = fileTypeLabel(name);
  li.innerHTML = `
    <span class="icon"></span>
    <span class="file-main">
      <span class="name" title="${escAttr(path)}">${esc(name)}</span>
      <span class="ftype">${esc(type)}</span>
    </span>
    <span class="st">${FILE_STATUS_LABEL[f.status] || f.status}</span>
  `;
  return li;
}

function fileTypeLabel(name) {
  const ext = String(name).split(".").pop()?.toLowerCase() || "";
  const map = {
    xlsx: "Excel",
    xls: "Excel",
    csv: "CSV",
    pdf: "PDF",
    txt: "Text",
    json: "JSON",
    md: "Markdown",
  };
  return map[ext] || (ext ? ext.toUpperCase() : "File");
}

function findFileRow(path) {
  return [...$("file-list").children].find((li) => li.dataset.path === path);
}

function updateFileRow(path) {
  const f = state.files.get(path);
  if (!f) return;
  let li = findFileRow(path);
  if (!li) {
    // File discovered via touch but not in initial mount list
    state.files.set(path, f);
    li = fileRow(path);
    const empty = $("file-list").querySelector(".empty");
    if (empty) empty.remove();
    $("file-list").appendChild(li);
    $("file-count").textContent = `${state.files.size} files`;
  }
  li.dataset.status = f.status;
  li.querySelector(".st").textContent = FILE_STATUS_LABEL[f.status] || f.status;
  li.classList.remove("flash");
  void li.offsetWidth;
  li.classList.add("flash");
}

function ensureFile(path) {
  if (!path || path === "." || path.startsWith(".__")) return null;
  const norm = path.replace(/^\.\//, "");
  if (!state.files.has(norm)) {
    state.files.set(norm, { path: norm, status: "available", dir: false });
  }
  return norm;
}

function onFileTouch(ev) {
  const path = ensureFile(ev.path);
  if (!path) return;
  const f = state.files.get(path);
  const action = ev.action || "read";
  let status = "in_use";
  let type = "File selected";
  let desc = `Agent selected ${basename(path)}`;

  if (action === "list" || action === "stat") {
    status = f.status === "available" || f.status === "not_accessed" ? "available" : f.status;
    // Don't spam timeline for list of "."
    if (path === "." || action === "list") return;
  } else if (action === "read" || action === "inspect") {
    status = "reading";
    type = "File opened";
    desc = `Reading ${basename(path)}`;
  } else if (action === "exec") {
    return;
  } else {
    status = "in_use";
  }

  // Promote reading -> in_use after a beat via status; keep reading visible
  if (f.status === "reading" && status === "reading") status = "in_use";
  f.status = status;
  updateFileRow(path);

  addEvent({
    kind: "file",
    icon: "📄",
    type,
    desc: `${desc}\nAgent accessed file`,
    status: "ok",
    time: true,
  });

  // After reading, settle to in_use
  if (status === "reading") {
    setTimeout(() => {
      const cur = state.files.get(path);
      if (cur && cur.status === "reading") {
        cur.status = "in_use";
        updateFileRow(path);
      }
    }, 1200);
  }
}

function inferFileFromTool(name, args, mode) {
  if (!args) return;
  const path = args.path;
  if (!path || path === ".") return;
  const norm = ensureFile(path);
  if (!norm) return;
  const f = state.files.get(norm);
  if (name === "list_dir") return;
  if (["read_file", "inspect_xlsx", "read_xlsx", "read_pdf"].includes(name)) {
    if (f.status === "available" || f.status === "not_accessed") {
      f.status = "reading";
      updateFileRow(norm);
      addEvent({
        kind: "file",
        icon: "📄",
        type: "File selected",
        desc: `Agent selected ${basename(norm)}`,
        status: "ok",
      });
    }
  }
}

// ---------- timeline / tools ----------

function addEvent({ kind, icon, type, desc, status, human, detailsHtml }) {
  const el = document.createElement("div");
  el.className = `ev${human ? " human" : ""}`;
  el.dataset.kind = kind || "llm";
  const stClass = status === "running" ? "running" : status === "bad" ? "bad" : status === "ok" ? "ok" : "";
  el.innerHTML = `
    <div class="ev-icon">${icon || "●"}</div>
    <div class="ev-body">
      <div class="ev-top">
        <span class="ev-type">${esc(type)}</span>
        <div class="ev-meta">
          ${status ? `<span class="ev-status ${stClass}">${esc(status)}</span>` : ""}
          <span class="ev-time">${nowTime()}</span>
        </div>
      </div>
      <p class="ev-desc">${esc(desc)}</p>
      ${detailsHtml || ""}
    </div>
  `;
  $("timeline").appendChild(el);
  el.scrollIntoView({ block: "end", behavior: "smooth" });
  return el;
}

function addToolEvent(ev) {
  const label = TOOL_LABELS[ev.name] || ev.name;
  const details = `
    <div class="tcard" data-call="${escAttr(ev.call_id)}">
      <div class="tcard-head">
        <span class="tname">${esc(label)}</span>
        <span class="tstat run">Running…</span>
      </div>
      <details class="tsec"><summary>Input</summary><pre>${esc(shortArgs(ev.name, ev.args))}</pre></details>
      <details class="tsec out hidden"><summary>Output</summary><pre></pre></details>
    </div>
  `;
  const wrap = addEvent({
    kind: "tool",
    icon: "⚙",
    type: "Tool called",
    desc: label,
    status: "running",
    detailsHtml: details,
  });
  const card = wrap.querySelector(".tcard");
  state.cards.set(ev.call_id, {
    el: card,
    statEl: card.querySelector(".tstat"),
    outDetails: card.querySelector(".tsec.out"),
    outPre: card.querySelector(".tsec.out pre"),
    wrap,
  });

  if (ev.name === "submit_answer") {
    addEvent({
      kind: "ok",
      icon: "★",
      type: "Preparing final response",
      desc: "Agent is submitting the final answer",
      status: "running",
    });
  } else if (ev.name === "run_python") {
    addEvent({
      kind: "tool",
      icon: "∑",
      type: "Running analysis",
      desc: "Python analysis tool",
      status: "running",
    });
  }
}

function resolveToolEvent(ev) {
  const card = state.cards.get(ev.call_id);
  const label = TOOL_LABELS[ev.name] || ev.name;
  if (card) {
    card.statEl.textContent = `${ev.ok ? "Completed" : "Failed"} · ${ev.ms}ms`;
    card.statEl.className = `tstat ${ev.ok ? "ok" : "bad"}`;
    card.outDetails.classList.remove("hidden");
    if (!ev.ok) card.outDetails.open = true;
    card.outPre.textContent = clip(ev.preview, 4000);
    const st = card.wrap.querySelector(".ev-status");
    if (st) {
      st.textContent = ev.ok ? "ok" : "bad";
      st.className = `ev-status ${ev.ok ? "ok" : "bad"}`;
    }
  } else {
    addEvent({
      kind: ev.ok ? "tool" : "err",
      icon: "⚙",
      type: "Tool completed",
      desc: `${label} · ${ev.ok ? "ok" : "failed"} · ${ev.ms}ms`,
      status: ev.ok ? "ok" : "bad",
    });
  }
}

// ---------- grade / result ----------

function renderGrade(ev) {
  $("score").textContent = `${ev.passed}/${ev.total}`;
  $("score").className = `score ${ev.score === 1 ? "ok" : "bad"}`;
  $("rubric").innerHTML = (ev.criteria || [])
    .map(
      (c) =>
        `<div class="crit ${c.met ? "met" : "miss"}">${c.met ? "✓" : "✗"} ${esc(
          c.description
        )}</div>`
    )
    .join("");
  $("eval-full").innerHTML = `
    <p><strong>Score:</strong> ${ev.passed}/${ev.total} (${Math.round((ev.score || 0) * 100)}%)</p>
    <div class="rubric">${$("rubric").innerHTML}</div>
    ${
      ev.gold
        ? `<h3 style="margin-top:16px;font-size:12px;color:var(--mute)">Reference output</h3><pre>${esc(
            typeof ev.gold === "string" ? ev.gold : JSON.stringify(ev.gold, null, 2)
          )}</pre>`
        : ""
    }
  `;
}

function showSetup(on) {
  $("setup").classList.toggle("hidden", !on);
  if (on) {
    $("timeline-wrap").classList.add("hidden");
    $("result").classList.add("hidden");
  }
}

function showResult(on) {
  $("result").classList.toggle("hidden", !on);
  if (on) $("timeline-wrap").classList.add("hidden");
}

$("btn-show-timeline").addEventListener("click", () => {
  $("result").classList.add("hidden");
  $("timeline-wrap").classList.remove("hidden");
});

$("btn-full-eval").addEventListener("click", () => {
  $("eval-drawer").classList.remove("hidden");
  $("eval-drawer").setAttribute("aria-hidden", "false");
});
$("btn-close-eval").addEventListener("click", closeEval);
$("eval-backdrop").addEventListener("click", closeEval);
function closeEval() {
  $("eval-drawer").classList.add("hidden");
  $("eval-drawer").setAttribute("aria-hidden", "true");
}

// ---------- supervisor controls ----------

function setAgentStatus(s) {
  state.agentStatus = s;
  $("kv-status").textContent = s === "idle" ? "Ready" : statusTitle(s);
  $("status-panel").dataset.state = s;
  $("status-label").textContent = statusTitle(s);
  $("status-help").textContent = statusHelp(s);
  $("live-chip").dataset.state = s;
  $("live-label").textContent = statusTitle(s);
  updateControlButtons();
}

function statusTitle(s) {
  return (
    {
      idle: "Idle",
      running: "Running",
      paused: "Paused",
      waiting: "Waiting for Human",
      completed: "Completed",
      failed: "Failed",
      interrupted: "Interrupted",
    }[s] || s
  );
}

function statusHelp(s) {
  return (
    {
      idle: "Start a run to supervise the agent.",
      running: "Agent is working autonomously. Intervene anytime.",
      paused: "Agent is held between steps. Resume or send guidance.",
      waiting: "The agent needs your input to continue.",
      completed: "Run finished. Review the final answer and evaluation.",
      failed: "The run ended with an error or missing submission.",
      interrupted: "You interrupted the agent. Start a new run when ready.",
    }[s] || ""
  );
}

function setLiveLabel(base) {
  // keep chip in sync; status title still drives main label when running
  if (state.agentStatus === "running") {
    $("live-label").textContent = "Running";
  }
}

function setComposer(live) {
  state.live = live;
  $("say").disabled = !live;
  $("btn-send").disabled = !live;
  updateControlButtons();
}

function updateControlButtons() {
  const live = state.live;
  $("btn-pause").disabled = !live || state.paused || state.interrupted;
  $("btn-resume").disabled = !live || (!state.paused && !state.waiting) || state.interrupted;
  $("btn-interrupt").disabled = !live || state.interrupted;
  $("btn-pause").textContent = "Pause Agent";
  $("btn-resume").textContent = "Resume Agent";
}

$("btn-pause").addEventListener("click", async () => {
  if (!state.runId || !state.live) return;
  await fetch(`/api/runs/${state.runId}/pause`, { method: "POST" }).catch(() => {});
});

$("btn-resume").addEventListener("click", async () => {
  if (!state.runId || !state.live) return;
  state.waiting = false;
  $("waiting-block").classList.add("hidden");
  await fetch(`/api/runs/${state.runId}/resume`, { method: "POST" }).catch(() => {});
});

$("btn-interrupt").addEventListener("click", interruptAgent);
$("btn-interrupt-wait").addEventListener("click", interruptAgent);

async function interruptAgent() {
  if (!state.runId || !state.live) return;
  state.interrupted = true;
  setAgentStatus("interrupted");
  addEvent({
    kind: "err",
    icon: "■",
    type: "Interrupted",
    desc: "Supervisor interrupted the agent",
    status: "bad",
  });
  updateControlButtons();
  // No cancel API yet: pause → inject stop guidance → resume so it can submit/halt
  await fetch(`/api/runs/${state.runId}/pause`, { method: "POST" }).catch(() => {});
  await fetch(`/api/runs/${state.runId}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: "STOP. The human supervisor interrupted this run. Submit your best current answer immediately with submit_answer, or halt.",
    }),
  }).catch(() => {});
  await fetch(`/api/runs/${state.runId}/resume`, { method: "POST" }).catch(() => {});
}

$("btn-continue").addEventListener("click", async () => {
  state.waiting = false;
  $("waiting-block").classList.add("hidden");
  if (state.runId && state.live) {
    await fetch(`/api/runs/${state.runId}/resume`, { method: "POST" }).catch(() => {});
  }
});

$("btn-focus-guidance").addEventListener("click", () => {
  $("say").focus();
});

async function sendGuidance() {
  const text = $("say").value.trim();
  if (!text || !state.runId || !state.live) return;
  $("say").value = "";
  await fetch(`/api/runs/${state.runId}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  }).catch(() => {});
  // user_message event comes from server
  if (state.waiting) {
    state.waiting = false;
    $("waiting-block").classList.add("hidden");
  }
}

$("btn-send").addEventListener("click", sendGuidance);
$("say").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendGuidance();
  }
});

/** Ready for a future "waiting_for_human" SSE event */
function enterWaitingForHuman(reason) {
  state.waiting = true;
  setAgentStatus("waiting");
  $("waiting-block").classList.remove("hidden");
  $("waiting-reason").textContent = reason || "The agent needs your decision to continue.";
  addEvent({
    kind: "human",
    icon: "⚠",
    type: "Human input requested",
    desc: reason || "The agent is waiting for supervisor guidance",
    status: "ok",
  });
  $("panel-right").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// Expose for future API wiring / console testing
window.__apexEnterWaiting = enterWaitingForHuman;

// ---------- history ----------

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveHistory() {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history.slice(0, 40)));
}

function pushHistory(entry) {
  state.history.unshift(entry);
  state.history = state.history.slice(0, 40);
  saveHistory();
  renderHistory();
}

function renderHistory() {
  const list = $("history-list");
  if (!state.history.length) {
    list.innerHTML = `<li class="empty">No runs yet</li>`;
    return;
  }
  list.innerHTML = state.history
    .map((h) => {
      const dur = h.durationMs != null ? formatDur(h.durationMs) : "—";
      const when = h.date ? new Date(h.date).toLocaleString() : "";
      return `<li class="hist-item">
        <div class="hist-top">
          <span>${esc(h.runId || "—")}</span>
          <span class="hist-score ${h.scoreOk ? "ok" : "bad"}">${esc(h.score || "—")}</span>
        </div>
        <div class="hist-meta">
          <span>${esc(h.task || "—")}</span>
          <span>${esc(h.model || h.provider || "—")}</span>
          <span>${esc(h.status || "—")}</span>
          <span>${esc(dur)}</span>
        </div>
        <div class="hist-meta">${esc(when)}</div>
      </li>`;
    })
    .join("");
}

$("btn-clear-history").addEventListener("click", () => {
  state.history = [];
  saveHistory();
  renderHistory();
});

// ---------- utils ----------

function nowTime() {
  return new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

function basename(p) {
  const s = String(p || "");
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i >= 0 ? s.slice(i + 1) : s;
}

function formatDur(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m ${r}s`;
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

function escAttr(s) {
  return esc(s).replace(/"/g, "&quot;");
}

boot();
