const $ = (id) => document.getElementById(id);

const HISTORY_KEY = "apex_workbench_history_v2";
const PROVIDER_LABELS = { groq: "Groq", gemini: "Google Gemini", openai: "OpenAI", local: "Local (scripted)" };
const FILE_STATUS_LABEL = { available: "Available", reading: "Reading", in_use: "In use", completed: "Completed", not_accessed: "Not accessed" };
const TOOL_LABELS = { list_dir: "list_dir", read_file: "read_file", inspect_xlsx: "inspect_xlsx", read_xlsx: "read_xlsx", read_pdf: "read_pdf", run_python: "run_python", submit_answer: "submit_answer" };

const state = {
  tasks: [],
  status: null,
  runId: null,
  source: null,
  timer: null,
  t0: 0,
  live: false,
  paused: false,
  interrupted: false,
  waiting: false,
  guidancePending: false,
  runComplete: false,
  lastSeq: -1,
  currentTask: null,
  provider: null,
  model: null,
  // step tracking
  currentStep: 0,
  stepsMax: 40,
  tokensUsed: 0,
  tokensMax: 200000,
  stepCards: new Map(),
  focusedStep: 0,
  // files
  files: new Map(),
  // tools
  toolData: new Map(),
  // review
  flags: new Map(),
  // grade
  lastGrade: null,
  lastAnswer: null,
  // auto-follow
  autoFollow: true,
  // history
  history: loadHistory(),
  // dropdown state
  openDropdown: null,
};

// ===================== BOOT =====================

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
  $("sel-task").addEventListener("change", syncTaskPanel);
  bindSetupEvents();
  bindRunEvents();
  bindKeyboard();
}

// ===================== SETUP =====================

function fillTaskSelect() {
  $("sel-task").innerHTML = state.tasks
    .map((t) => `<option value="${escAttr(t.task_id)}">${esc(t.task_name)}${t.category ? ` · ${esc(t.category)}` : ""}</option>`)
    .join("");
}

function syncTaskPanel() {
  const task = taskById($("sel-task").value);
  if (!task) {
    $("task-id").textContent = "—";
    $("task-category").textContent = "—";
    $("instructions-preview").textContent = "";
    $("task-prompt").value = "";
    $("prompt-chars").textContent = "0 characters";
    return;
  }
  $("task-id").textContent = task.task_id;
  $("task-category").textContent = task.category || "—";
  const prompt = task.prompt || "";
  $("instructions-preview").textContent = clip(prompt, 200);
  $("task-prompt").value = prompt;
  $("prompt-chars").textContent = `${prompt.length} character${prompt.length === 1 ? "" : "s"}`;
}

function fillProviderSelect() {
  const sel = $("sel-provider");
  const providers = state.status?.providers || {};
  const ordered = ["groq", "openai", "gemini", "local"].filter((k) => k in providers);
  Object.keys(providers).forEach((k) => { if (!ordered.includes(k)) ordered.push(k); });
  sel.innerHTML = ordered
    .map((k) => {
      const label = PROVIDER_LABELS[k] || k;
      const mark = providers[k] ? "" : " (no key)";
      return `<option value="${escAttr(k)}">${esc(label)}${mark}</option>`;
    })
    .join("");
  const preferred = ordered.find((k) => providers[k] && k !== "local") || (providers.local ? "local" : ordered[0]);
  if (preferred) sel.value = preferred;
  sel.onchange = () => { updateModelSelect(); updateProviderHint(); };
  updateProviderHint();
}

function updateModelSelect() {
  const provider = $("sel-provider").value;
  const defaults = state.status?.defaults || {};
  const model = defaults[provider] || "";
  const sel = $("sel-model");
  const options = new Set();
  if (model) options.add(model);
  if (provider === "openai") ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini"].forEach((m) => options.add(m));
  else if (provider === "gemini") ["gemini-2.5-flash", "gemini-2.0-flash"].forEach((m) => options.add(m));
  else if (provider === "groq") ["openai/gpt-oss-120b", "llama-3.3-70b-versatile"].forEach((m) => options.add(m));
  else if (provider === "local") options.add("local-loop");
  sel.innerHTML = [...options].map((m) => `<option value="${escAttr(m)}">${esc(m)}</option>`).join("");
  if (model) sel.value = model;
}

function updateProviderHint() {
  const provider = $("sel-provider").value;
  const ok = state.status?.providers?.[provider];
  const el = $("provider-hint");
  if (provider === "local") el.textContent = "Local runs a scripted solver for Task 30 only — no API key required.";
  else if (!ok) el.textContent = `No API key detected for ${PROVIDER_LABELS[provider] || provider}. Set it in .env or the run may fail.`;
  else el.textContent = `Using ${PROVIDER_LABELS[provider] || provider} · model from server defaults unless changed.`;
}

function taskById(id) { return state.tasks.find((t) => t.task_id === id || t.slug === id); }
function pickRandom() {
  const pool = state.tasks.filter((t) => t.task_id !== (state.currentTask?.task_id));
  return (pool.length ? pool : state.tasks)[Math.floor(Math.random() * state.tasks.length)];
}

function bindSetupEvents() {
  $("btn-start").addEventListener("click", () => {
    const task = taskById($("sel-task").value);
    if (task) startRun(task);
  });
  $("btn-random").addEventListener("click", () => {
    const task = pickRandom();
    if (!task) return;
    $("sel-task").value = task.task_id;
    syncTaskPanel();
    startRun(task);
  });
  $("btn-toggle-prompt").addEventListener("click", () => {
    const full = $("instructions-full");
    const btn = $("btn-toggle-prompt");
    full.classList.toggle("hidden");
    btn.textContent = full.classList.contains("hidden") ? "Show full instructions" : "Hide full instructions";
  });
  $("btn-history").addEventListener("click", openHistory);
}

// ===================== VIEW SWITCHING =====================

function showSetupView() {
  $("setup-view").classList.remove("hidden");
  $("run-view").classList.add("hidden");
}

function showRunView() {
  $("setup-view").classList.add("hidden");
  $("run-view").classList.remove("hidden");
}

// ===================== START RUN =====================

async function startRun(task) {
  softStop();
  state.currentTask = task;
  state.provider = $("sel-provider").value;
  state.model = $("sel-model").value;
  state.runId = null;
  state.paused = false;
  state.interrupted = false;
  state.waiting = false;
  state.guidancePending = false;
  state.runComplete = false;
  state.lastSeq = -1;
  state.lastGrade = null;
  state.lastAnswer = null;
  state.currentStep = 0;
  state.stepsMax = 40;
  state.tokensUsed = 0;
  state.tokensMax = 200000;
  state.stepCards.clear();
  state.toolData.clear();
  state.files.clear();
  state.flags.clear();
  state.autoFollow = true;
  state.focusedStep = 0;

  // Setup run view
  showRunView();
  $("topbar-task").textContent = task.task_name;
  $("topbar-model").textContent = state.model;
  $("topbar-files").textContent = "Files (0)";
  $("topbar-timer").textContent = "0.0s";
  $("topbar-steps").textContent = "Step 0/40";
  $("topbar-tokens").textContent = "0 tok";
  $("step-rail").innerHTML = "";
  $("file-list").innerHTML = '<li class="empty">Mounting…</li>';
  $("file-count").textContent = "…";
  $("flagged-list").innerHTML = '<li class="empty">No flags yet</li>';
  $("flag-count").classList.add("hidden");
  $("composer-context").classList.add("hidden");
  $("say").value = "";
  $("say").disabled = false;
  $("btn-send").disabled = false;
  $("waiting-banner").classList.add("hidden");
  $("jump-live").classList.add("hidden");
  $("prompt-dd-text").textContent = task.prompt || "";
  setLiveState("running");
  updateControls();

  state.t0 = Date.now();
  if (state.timer) clearInterval(state.timer);
  state.timer = setInterval(() => {
    $("topbar-timer").textContent = `${((Date.now() - state.t0) / 1000).toFixed(1)}s`;
  }, 200);

  addSysCard("●", `Run started · ${PROVIDER_LABELS[state.provider] || state.provider} · ${state.model}`);

  const res = await fetch("/api/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task_id: task.task_id, provider: state.provider, model: state.model, max_steps: 40 }),
  });
  const { run_id } = await res.json();
  state.runId = run_id;
  state.live = true;
  updateControls();

  const src = new EventSource(`/api/runs/${run_id}/events`);
  state.source = src;
  src.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    // A reconnect replays the whole history, so skip anything already rendered.
    if (ev.seq != null) {
      if (ev.seq <= state.lastSeq) return;
      state.lastSeq = ev.seq;
    }
    onEvent(ev);
  };
  src.onerror = () => {
    // EventSource reconnects on its own. Only a confirmed server-side status
    // change ends the run — a dropped connection does not.
    if (state.runComplete) {
      src.close();
      return;
    }
    confirmRunStatus();
  };
}

async function confirmRunStatus() {
  if (!state.runId || state.runComplete) return;
  try {
    const res = await fetch(`/api/runs/${state.runId}`);
    if (!res.ok) return;
    const data = await res.json();
    if (data.status === "running") return;
    if (state.source) state.source.close();
    if (state.timer) clearInterval(state.timer);
    setLiveState(state.interrupted ? "interrupted" : "failed");
    finishUI();
  } catch {
    // network still down; the next reconnect attempt will retry
  }
}

function softStop() {
  if (state.source) { state.source.close(); state.source = null; }
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
  state.live = false;
  state.runComplete = true;
}

function finishUI() {
  state.live = false;
  state.runComplete = true;
  updateControls();
}

// ===================== SSE EVENTS =====================

function onEvent(ev) {
  switch (ev.type) {
    case "run_started":
      if (ev.model) { state.model = ev.model; $("topbar-model").textContent = ev.model; }
      if (ev.max_steps) state.stepsMax = ev.max_steps;
      if (ev.max_tokens) state.tokensMax = ev.max_tokens;
      break;

    case "workspace_ready":
      mountFiles(ev.files || []);
      addSysCard("▣", `Workspace mounted · ${(ev.files || []).length} files`);
      break;

    case "harness_prompt":
      break;

    case "step_started": {
      state.currentStep = ev.step;
      if (ev.tokens_used) state.tokensUsed = ev.tokens_used;
      $("topbar-steps").textContent = `Step ${ev.step}/${state.stepsMax}`;
      $("topbar-tokens").textContent = formatTokens(state.tokensUsed);
      getOrCreateStep(ev.step);
      // Mark previous step as done
      if (ev.step > 1) {
        const prev = state.stepCards.get(ev.step - 1);
        if (prev && prev.el.dataset.status === "running") prev.el.dataset.status = "done";
      }
      break;
    }

    case "llm_request":
      break;

    case "llm_thinking": {
      const sc = getOrCreateStep(state.currentStep || 1);
      if (ev.text) {
        sc.thinkingText = (sc.thinkingText || "") + ev.text;
        sc.thinkingEl.textContent = sc.thinkingText;
        if (!sc.el.classList.contains("expanded")) {
          sc.previewEl.textContent = clip(sc.thinkingText, 80);
        }
      }
      break;
    }

    case "llm_text": {
      const sc = getOrCreateStep(state.currentStep || 1);
      if (ev.text && String(ev.text).trim()) {
        sc.textEl.textContent = (sc.textEl.textContent || "") + ev.text;
        sc.textEl.style.display = "block";
        if (!sc.thinkingText && !sc.el.classList.contains("expanded")) {
          sc.previewEl.textContent = clip(ev.text, 80);
        }
      }
      break;
    }

    case "tokens":
      if (ev.total) {
        state.tokensUsed = ev.total;
        $("topbar-tokens").textContent = formatTokens(ev.total);
      }
      break;

    case "tool_call":
      addToolChip(ev);
      inferFileFromTool(ev.name, ev.args);
      break;

    case "tool_result":
      resolveToolChip(ev);
      break;

    case "file_touch":
      onFileTouch(ev);
      break;

    case "user_message":
      addOperatorCard("☺", "Human guidance queued", ev.text);
      state.guidancePending = true;
      break;

    case "guidance_queued":
      state.guidancePending = true;
      if (!state.interrupted) setLiveState("queued");
      break;

    case "user_message_injected":
      state.guidancePending = false;
      addOperatorCard(
        "↳",
        "Guidance applied",
        `Applied before step ${ev.step}${ev.text ? `: ${ev.text}` : ""}`
      );
      if (!state.paused && !state.interrupted) setLiveState("running");
      break;

    case "paused":
      state.paused = true;
      if (!state.interrupted) setLiveState("paused");
      updateControls();
      break;

    case "resumed":
      state.paused = false;
      state.waiting = false;
      $("waiting-banner").classList.add("hidden");
      if (!state.interrupted) setLiveState(state.guidancePending ? "queued" : "running");
      updateControls();
      break;

    case "answer":
      state.lastAnswer = ev.text;
      break;

    case "grade":
      state.lastGrade = ev;
      break;

    case "error":
      addSysCard("!", ev.message || "Unknown error", true);
      break;

    case "run_finished": {
      state.runComplete = true;
      if (state.timer) clearInterval(state.timer);
      if (state.source) state.source.close();
      const elapsed = ev.elapsed_ms || (Date.now() - state.t0);
      $("topbar-timer").textContent = `${(elapsed / 1000).toFixed(1)}s`;
      if (ev.answer && !state.lastAnswer) state.lastAnswer = ev.answer;

      // Settle files
      for (const [path, f] of state.files) {
        if (f.status === "reading" || f.status === "in_use") f.status = "completed";
        else if (f.status === "available") f.status = "not_accessed";
        updateFileRow(path);
      }

      // Mark last step done
      const last = state.stepCards.get(state.currentStep);
      if (last && last.el.dataset.status === "running") {
        last.el.dataset.status = ev.status === "error" || ev.status === "no_submit" ? "error" : "done";
      }

      const st = mapFinishedStatus(ev.status);
      setLiveState(st);
      finishUI();

      // Result card
      if (state.lastAnswer || state.lastGrade) renderResult();

      pushHistory({
        runId: state.runId,
        task: state.currentTask?.task_name || "—",
        taskId: state.currentTask?.task_id,
        model: state.model,
        provider: state.provider,
        status: st,
        durationMs: elapsed,
        score: state.lastGrade ? `${state.lastGrade.passed}/${state.lastGrade.total}` : "—",
        scoreOk: state.lastGrade?.score === 1,
        date: new Date().toISOString(),
      });
      break;
    }

    default:
      break;
  }

  if (state.autoFollow) scrollToBottom();
}

function mapFinishedStatus(s) {
  if (state.interrupted) return "interrupted";
  if (s === "submitted" || s === "done") return "completed";
  if (s === "error" || s === "no_submit") return "failed";
  return s || "completed";
}

// ===================== STEP CARDS =====================

function getOrCreateStep(stepNum) {
  if (state.stepCards.has(stepNum)) return state.stepCards.get(stepNum);

  const el = document.createElement("div");
  el.className = "step-card";
  el.dataset.step = stepNum;
  el.dataset.status = "running";

  const header = document.createElement("div");
  header.className = "step-header";
  header.innerHTML = `
    <div class="step-left">
      <span class="step-dot"></span>
      <span class="step-label">Step ${stepNum}</span>
      <span class="step-preview"></span>
    </div>
    <div class="step-meta"></div>
  `;

  const body = document.createElement("div");
  body.className = "step-body";

  const thinking = document.createElement("div");
  thinking.className = "step-thinking";

  const text = document.createElement("div");
  text.className = "step-text";
  text.style.display = "none";

  const tools = document.createElement("div");
  tools.className = "step-tools";

  body.appendChild(thinking);
  body.appendChild(text);
  body.appendChild(tools);
  el.appendChild(header);
  el.appendChild(body);

  header.addEventListener("click", () => toggleStep(stepNum));

  $("step-rail").appendChild(el);

  const card = {
    el,
    header,
    body,
    thinkingEl: thinking,
    textEl: text,
    toolsEl: tools,
    previewEl: header.querySelector(".step-preview"),
    metaEl: header.querySelector(".step-meta"),
    expanded: false,
    thinkingText: "",
    toolWraps: new Map(),
  };
  state.stepCards.set(stepNum, card);
  return card;
}

function toggleStep(stepNum) {
  const card = state.stepCards.get(stepNum);
  if (!card) return;
  card.expanded = !card.expanded;
  card.el.classList.toggle("expanded", card.expanded);
  state.focusedStep = card.expanded ? stepNum : 0;
}

// ===================== TOOL CHIPS =====================

function addToolChip(ev) {
  const sc = getOrCreateStep(ev.step || state.currentStep || 1);
  const label = TOOL_LABELS[ev.name] || ev.name;
  const primaryArg = extractPrimaryArg(ev.name, ev.args);

  const wrap = document.createElement("div");
  wrap.className = "tool-wrap";
  wrap.dataset.callId = ev.call_id;
  wrap.dataset.status = "running";

  const chip = document.createElement("div");
  chip.className = "tool-chip";
  chip.innerHTML = `
    <span class="chip-icon">⚙</span>
    <span class="chip-name">${esc(label)}</span>
    ${primaryArg ? `<span class="chip-arg">${esc(primaryArg)}</span>` : ""}
    <span class="chip-spacer"></span>
    <span class="chip-stat run">Running…</span>
    <div class="chip-actions">
      <button class="chip-btn" data-action="approve" title="Approve">👍</button>
      <button class="chip-btn" data-action="flag" title="Flag issue">👎</button>
      <button class="chip-btn" data-action="comment" title="Comment">✎</button>
    </div>
  `;

  const detail = document.createElement("div");
  detail.className = "tool-detail";
  detail.innerHTML = `
    <div class="tool-section"><div class="tool-section-head">Input</div><pre>${esc(shortArgs(ev.name, ev.args))}</pre></div>
    <div class="tool-section"><div class="tool-section-head">Output</div><pre class="tool-output">Waiting…</pre></div>
  `;

  wrap.appendChild(chip);
  wrap.appendChild(detail);
  sc.toolsEl.appendChild(wrap);

  // Toggle detail on chip click
  chip.addEventListener("click", (e) => {
    if (e.target.closest(".chip-btn")) return;
    wrap.classList.toggle("detail-open");
  });

  // Review actions
  chip.querySelectorAll(".chip-btn").forEach((btn) => {
    btn.addEventListener("click", () => handleReviewAction(btn.dataset.action, ev.call_id, ev.step || state.currentStep, ev.name));
  });

  state.toolData.set(ev.call_id, { name: ev.name, args: ev.args, step: ev.step || state.currentStep, wrap, chip, detail });
}

function resolveToolChip(ev) {
  const td = state.toolData.get(ev.call_id);
  if (!td) return;
  td.wrap.dataset.status = ev.ok ? "ok" : "error";
  const statEl = td.chip.querySelector(".chip-stat");
  statEl.textContent = `${ev.ok ? "✓" : "✗"} ${ev.ms}ms`;
  statEl.className = `chip-stat ${ev.ok ? "ok" : "bad"}`;
  const outPre = td.detail.querySelector(".tool-output");
  outPre.textContent = clip(ev.preview || "(no output)", 4000);
  if (!ev.ok) td.wrap.classList.add("detail-open");
  td.result = ev;
}

function extractPrimaryArg(name, args) {
  if (!args) return "";
  if (args.path && args.path !== ".") return basename(args.path);
  if (name === "run_python") return "script";
  if (name === "submit_answer") return "answer";
  return "";
}

// ===================== REVIEW ACTIONS =====================

function handleReviewAction(action, callId, step, toolName) {
  const td = state.toolData.get(callId);
  if (!td) return;

  // Clear all active states on this chip's buttons
  td.chip.querySelectorAll(".chip-btn").forEach((b) => b.classList.remove("active"));

  // Remove any previous review badge
  td.chip.querySelector(".review-badge")?.remove();

  if (action === "approve") {
    state.flags.delete(callId);
    td.wrap.dataset.status = "approved";
    td.chip.querySelector('[data-action="approve"]').classList.add("active");
    const badge = document.createElement("span");
    badge.className = "review-badge approved";
    badge.textContent = "Approved";
    td.chip.querySelector(".chip-spacer").after(badge);
  } else if (action === "flag") {
    state.flags.set(callId, { step, tool: toolName, type: "flag" });
    td.wrap.dataset.status = "flagged";
    td.chip.querySelector('[data-action="flag"]').classList.add("active");
    const badge = document.createElement("span");
    badge.className = "review-badge flagged";
    badge.textContent = "Flagged";
    td.chip.querySelector(".chip-spacer").after(badge);
    const sc = state.stepCards.get(step);
    if (sc) sc.el.dataset.status = "flagged";
    prefillComposer(step, toolName);
  } else if (action === "comment") {
    prefillComposer(step, toolName);
    $("say").focus();
    return;
  }
  renderFlags();
}

function prefillComposer(step, toolName) {
  const ctx = $("composer-context");
  ctx.textContent = `Re: step ${step}, ${toolName}`;
  ctx.classList.remove("hidden");
  $("say").placeholder = `Feedback on step ${step} ${toolName}…`;
}

function renderFlags() {
  const list = $("flagged-list");
  const count = state.flags.size;
  $("flag-count").textContent = count;
  $("flag-count").classList.toggle("hidden", count === 0);

  if (count === 0) {
    list.innerHTML = '<li class="empty">No flags yet</li>';
    return;
  }
  list.innerHTML = "";
  for (const [callId, flag] of state.flags) {
    const li = document.createElement("li");
    li.className = "flag-item";
    li.innerHTML = `<span class="flag-step">Step ${flag.step}</span><span class="flag-tool">${esc(flag.tool)}</span>`;
    li.addEventListener("click", () => {
      // Scroll to the tool wrap
      const td = state.toolData.get(callId);
      if (td) {
        const sc = state.stepCards.get(flag.step);
        if (sc && !sc.expanded) toggleStep(flag.step);
        td.wrap.scrollIntoView({ behavior: "smooth", block: "center" });
        td.wrap.classList.add("detail-open");
      }
    });
    list.appendChild(li);
  }
}

// ===================== SYSTEM / OPERATOR CARDS =====================

function addSysCard(icon, text, isError) {
  const el = document.createElement("div");
  el.className = "sys-card";
  if (isError) el.style.borderColor = "var(--bad-soft)";
  el.innerHTML = `<span class="sys-icon">${icon}</span><span class="sys-text">${esc(text)}</span>`;
  $("step-rail").appendChild(el);
}

function addOperatorCard(icon, label, text) {
  const el = document.createElement("div");
  el.className = "operator-card";
  el.innerHTML = `
    <span class="op-icon">${icon}</span>
    <div class="op-body">
      <div class="op-label">${esc(label)}</div>
      <div>${esc(text)}</div>
    </div>
  `;
  $("step-rail").appendChild(el);
}

// ===================== RESULT =====================

function renderResult() {
  const rail = $("step-rail");
  const el = document.createElement("div");
  el.className = "result-card";

  const answer = state.lastAnswer || "(no answer submitted)";
  const grade = state.lastGrade;
  let gradeHtml = "";

  if (grade) {
    const criteria = (grade.criteria || [])
      .map((c, index) => renderCriterion(c, index))
      .join("");
    const pct = Math.round((grade.score || 0) * 100);
    const allPassed = grade.score === 1;
    gradeHtml = `
      <section class="evaluation-panel">
        <div class="eval-summary">
          <div>
            <h3>Evaluation</h3>
            <div class="eval-verdict ${allPassed ? "ok" : "bad"}">${allPassed ? "All criteria passed" : "Review required"}</div>
          </div>
          <div class="score-block ${allPassed ? "ok" : "bad"}">
            <strong>${grade.passed}/${grade.total}</strong>
            <span>${pct}%</span>
          </div>
        </div>
        <div class="score-track"><span style="width:${pct}%"></span></div>
        <div class="rubric">${criteria}</div>
        <p class="eval-method">${esc(grade.method || "Automated rubric evaluation")}</p>
      </section>
    `;
    const reference = grade.gold
      ? `<section class="reference-output">
          <h3>Reference output</h3>
          <pre>${esc(typeof grade.gold === "string" ? grade.gold : JSON.stringify(grade.gold, null, 2))}</pre>
        </section>`
      : "";
    $("eval-full").innerHTML = `
      <div class="drawer-score ${allPassed ? "ok" : "bad"}">
        <strong>${pct}%</strong>
        <span>${grade.passed} of ${grade.total} criteria passed</span>
      </div>
      <div class="rubric">${criteria}</div>
      ${reference}
    `;
  }

  el.innerHTML = `
    <div class="result-title">
      <div>
        <span class="eyebrow">Run complete</span>
        <h2>Final answer</h2>
      </div>
      <span class="completion-check">✓</span>
    </div>
    <div class="result-answer">${formatAnswerHtml(answer)}</div>
    ${gradeHtml}
    <div class="result-actions">
      <button type="button" class="btn ghost sm" id="btn-full-eval">View Full Evaluation</button>
      <button type="button" class="btn ghost sm" id="btn-new-run-result">New Run</button>
    </div>
  `;
  rail.appendChild(el);

  el.querySelector("#btn-full-eval")?.addEventListener("click", () => {
    $("eval-drawer").classList.remove("hidden");
    $("eval-drawer").setAttribute("aria-hidden", "false");
  });
  el.querySelector("#btn-new-run-result")?.addEventListener("click", goToSetup);
}

function renderCriterion(c, index) {
  return `
    <div class="crit ${c.met ? "met" : "miss"}">
      <span class="crit-icon">${c.met ? "✓" : "!"}</span>
      <div class="crit-body">
        <div class="crit-top">
          <span>Criterion ${index + 1}</span>
          ${c.type ? `<span class="crit-type">${esc(c.type)}</span>` : ""}
        </div>
        <p>${esc(c.description)}</p>
        ${c.matched != null ? `<span class="crit-match">Matched: ${esc(c.matched)}</span>` : ""}
      </div>
    </div>
  `;
}

function formatAnswerHtml(answer) {
  return String(answer)
    .split(/\r?\n/)
    .map((raw) => {
      const line = raw.trim();
      if (!line) return '<div class="answer-space"></div>';
      const escaped = esc(line);
      if (/^\d+\.\s/.test(line)) return `<div class="answer-entry">${escaped}</div>`;
      if (/^-\s*(Debit|Credit):/i.test(line)) {
        const kind = /^-\s*Debit:/i.test(line) ? "debit" : "credit";
        return `<div class="answer-ledger ${kind}"><span>${kind === "debit" ? "DR" : "CR"}</span><p>${escaped.replace(/^-\s*(Debit|Credit):\s*/i, "")}</p></div>`;
      }
      if (/^(Explanation|Therefore|Conclusion|Proposed JE|Date|Memo):?/i.test(line)) {
        return `<div class="answer-emphasis">${escaped}</div>`;
      }
      return `<p>${escaped}</p>`;
    })
    .join("");
}

// ===================== FILES =====================

function mountFiles(files) {
  state.files.clear();
  const list = $("file-list");
  const visible = (files || []).filter((f) => !f.dir && !String(f.path).startsWith(".__"));
  if (!visible.length) {
    list.innerHTML = '<li class="empty">No files in workspace</li>';
    $("file-count").textContent = "0 files";
    $("topbar-files").textContent = "Files (0)";
    return;
  }
  list.innerHTML = "";
  for (const f of visible) {
    state.files.set(f.path, { path: f.path, status: "available", dir: false });
    list.appendChild(fileRow(f.path));
  }
  $("file-count").textContent = `${visible.length} files`;
  $("topbar-files").textContent = `Files (${visible.length})`;
}

function fileRow(path) {
  const li = document.createElement("li");
  li.className = "file-item";
  li.dataset.path = path;
  li.dataset.status = "available";
  li.innerHTML = `<span class="icon"></span><span class="fname" title="${escAttr(path)}">${esc(basename(path))}</span><span class="fstat">Available</span>`;
  return li;
}

function updateFileRow(path) {
  const f = state.files.get(path);
  if (!f) return;
  let li = [...$("file-list").children].find((el) => el.dataset?.path === path);
  if (!li) {
    li = fileRow(path);
    const empty = $("file-list").querySelector(".empty");
    if (empty) empty.remove();
    $("file-list").appendChild(li);
    $("file-count").textContent = `${state.files.size} files`;
    $("topbar-files").textContent = `Files (${state.files.size})`;
  }
  li.dataset.status = f.status;
  li.querySelector(".fstat").textContent = FILE_STATUS_LABEL[f.status] || f.status;
  li.classList.remove("flash");
  void li.offsetWidth;
  li.classList.add("flash");
}

function ensureFile(path) {
  if (!path || path === "." || path.startsWith(".__")) return null;
  const norm = path.replace(/^\.\//, "");
  if (!state.files.has(norm)) state.files.set(norm, { path: norm, status: "available", dir: false });
  return norm;
}

function onFileTouch(ev) {
  const path = ensureFile(ev.path);
  if (!path) return;
  const f = state.files.get(path);
  const action = ev.action || "read";
  if (action === "list" || action === "stat" || action === "exec") return;
  if (action === "read" || action === "inspect") f.status = f.status === "reading" ? "in_use" : "reading";
  else f.status = "in_use";
  updateFileRow(path);
  if (f.status === "reading") {
    setTimeout(() => {
      const cur = state.files.get(path);
      if (cur && cur.status === "reading") { cur.status = "in_use"; updateFileRow(path); }
    }, 1200);
  }
}

function inferFileFromTool(name, args) {
  if (!args || !args.path || args.path === ".") return;
  const norm = ensureFile(args.path);
  if (!norm) return;
  if (name === "list_dir") return;
  const f = state.files.get(norm);
  if (["read_file", "inspect_xlsx", "read_xlsx", "read_pdf"].includes(name)) {
    if (f.status === "available" || f.status === "not_accessed") {
      f.status = "reading";
      updateFileRow(norm);
    }
  }
}

// ===================== CONTROLS =====================

function bindRunEvents() {
  $("btn-pause-toggle").addEventListener("click", async () => {
    if (!canControlRun()) return;
    const button = $("btn-pause-toggle");
    button.disabled = true;
    if (state.paused) {
      button.textContent = "Resuming…";
      state.waiting = false;
      $("waiting-banner").classList.add("hidden");
      const response = await fetch(`/api/runs/${state.runId}/resume`, { method: "POST" }).catch(() => null);
      if (response?.ok) {
        state.paused = false;
        setLiveState(state.guidancePending ? "queued" : "running");
      }
    } else {
      button.textContent = "Pausing…";
      const response = await fetch(`/api/runs/${state.runId}/pause`, { method: "POST" }).catch(() => null);
      if (response?.ok) {
        state.paused = true;
        setLiveState("paused");
      }
    }
    updateControls();
  });

  $("btn-interrupt").addEventListener("click", interruptAgent);

  $("btn-new-run").addEventListener("click", goToSetup);

  $("btn-send").addEventListener("click", sendGuidance);
  $("say").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendGuidance(); }
  });

  $("btn-continue").addEventListener("click", async () => {
    state.waiting = false;
    $("waiting-banner").classList.add("hidden");
    if (canControlRun()) await fetch(`/api/runs/${state.runId}/resume`, { method: "POST" }).catch(() => {});
  });

  $("btn-focus-say").addEventListener("click", () => $("say").focus());

  // Topbar dropdowns
  $("topbar-task").addEventListener("click", () => toggleDropdown("prompt-dropdown"));
  $("topbar-files").addEventListener("click", () => toggleDropdown("files-dropdown"));
  $("btn-close-prompt-dd").addEventListener("click", () => closeDropdowns());

  // Close dropdowns on outside click
  document.addEventListener("click", (e) => {
    if (state.openDropdown && !e.target.closest(".dropdown-panel") && !e.target.closest(".topbar-chip")) closeDropdowns();
  });

  // History
  $("btn-close-history").addEventListener("click", closeHistory);
  $("history-backdrop").addEventListener("click", closeHistory);
  $("btn-clear-history").addEventListener("click", () => { state.history = []; saveHistory(); renderHistory(); });

  // Eval
  $("btn-close-eval").addEventListener("click", closeEval);
  $("eval-backdrop").addEventListener("click", closeEval);

  // Auto-follow: detect manual scroll
  $("step-rail").addEventListener("scroll", () => {
    const rail = $("step-rail");
    const atBottom = rail.scrollHeight - rail.scrollTop - rail.clientHeight < 60;
    if (atBottom) {
      state.autoFollow = true;
      $("jump-live").classList.add("hidden");
    } else if (state.live) {
      state.autoFollow = false;
      $("jump-live").classList.remove("hidden");
    }
  });

  $("jump-live").addEventListener("click", () => {
    state.autoFollow = true;
    $("jump-live").classList.add("hidden");
    scrollToBottom();
  });
}

async function interruptAgent() {
  if (!canControlRun()) return;
  state.interrupted = true;
  setLiveState("interrupted");
  addOperatorCard("■", "Interrupted", "Supervisor interrupted the agent");
  updateControls();
  await fetch(`/api/runs/${state.runId}/pause`, { method: "POST" }).catch(() => {});
  await fetch(`/api/runs/${state.runId}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "STOP. The human supervisor interrupted this run. Submit your best current answer immediately with submit_answer, or halt." }),
  }).catch(() => {});
  await fetch(`/api/runs/${state.runId}/resume`, { method: "POST" }).catch(() => {});
}

async function sendGuidance() {
  const text = $("say").value.trim();
  if (!text || !canControlRun()) return;
  const send = $("btn-send");
  const wasPaused = state.paused;
  send.disabled = true;
  send.textContent = "Queueing guidance…";

  try {
    // Hold the next checkpoint before queueing the message. If the current
    // model turn tries to submit, the harness defers it until this guidance
    // has been injected.
    const paused = await fetch(`/api/runs/${state.runId}/pause`, { method: "POST" });
    if (!paused.ok) throw new Error("could not pause the run");

    const queued = await fetch(`/api/runs/${state.runId}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!queued.ok) throw new Error("could not queue guidance");

    state.guidancePending = true;
    $("say").value = "";
    $("composer-context").classList.add("hidden");
    $("say").placeholder = "Tell the agent to reconsider…";
    setLiveState("queued");

    // Only hand control back if the supervisor was not already holding the run.
    if (!wasPaused) {
      const resumed = await fetch(`/api/runs/${state.runId}/resume`, { method: "POST" });
      if (!resumed.ok) throw new Error("could not resume the run");
      state.paused = false;
      state.waiting = false;
      $("waiting-banner").classList.add("hidden");
    }
  } catch (error) {
    addSysCard("!", `Guidance was not delivered: ${error.message}`, true);
  } finally {
    send.textContent = "Send Guidance";
    updateControls();
  }
}

function goToSetup() {
  softStop();
  showSetupView();
  syncTaskPanel();
}

function canControlRun() {
  return !!state.runId && !state.runComplete && !state.interrupted;
}

function updateControls() {
  const controllable = canControlRun();
  $("btn-pause-toggle").disabled = !controllable;
  $("btn-pause-toggle").textContent = state.paused ? "Resume" : "Pause";
  $("btn-interrupt").disabled = !controllable;
  $("say").disabled = !controllable;
  $("btn-send").disabled = !controllable;
}

function setLiveState(st) {
  $("live-indicator").dataset.state = st;
  $("topbar-status").textContent = { running: "Running", queued: "Guidance queued", paused: "Paused", waiting: "Waiting", completed: "Completed", failed: "Failed", interrupted: "Interrupted" }[st] || st;
  updateControls();
}

// ===================== DROPDOWNS =====================

function toggleDropdown(id) {
  if (state.openDropdown === id) { closeDropdowns(); return; }
  closeDropdowns();
  $(id).classList.remove("hidden");
  state.openDropdown = id;
}

function closeDropdowns() {
  if (state.openDropdown) $(state.openDropdown).classList.add("hidden");
  state.openDropdown = null;
}

// ===================== HISTORY =====================

function loadHistory() { try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); } catch { return []; } }
function saveHistory() { localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history.slice(0, 40))); }
function pushHistory(entry) { state.history.unshift(entry); state.history = state.history.slice(0, 40); saveHistory(); renderHistory(); }

function renderHistory() {
  const list = $("history-list");
  if (!state.history.length) { list.innerHTML = '<li class="empty">No runs yet</li>'; return; }
  list.innerHTML = state.history.map((h) => {
    const dur = h.durationMs != null ? formatDur(h.durationMs) : "—";
    const when = h.date ? new Date(h.date).toLocaleString() : "";
    return `<li class="hist-item">
      <div class="hist-top"><span>${esc(h.runId || "—")}</span><span class="hist-score ${h.scoreOk ? "ok" : "bad"}">${esc(h.score || "—")}</span></div>
      <div class="hist-meta"><span>${esc(h.task || "—")}</span><span>${esc(h.model || h.provider || "—")}</span><span>${esc(h.status || "—")}</span><span>${esc(dur)}</span></div>
      <div class="hist-meta">${esc(when)}</div>
    </li>`;
  }).join("");
}

function openHistory() { $("history-drawer").classList.remove("hidden"); $("history-drawer").setAttribute("aria-hidden", "false"); }
function closeHistory() { $("history-drawer").classList.add("hidden"); $("history-drawer").setAttribute("aria-hidden", "true"); }
function closeEval() { $("eval-drawer").classList.add("hidden"); $("eval-drawer").setAttribute("aria-hidden", "true"); }

// ===================== WAITING (for future SSE event) =====================

function enterWaitingForHuman(reason) {
  state.waiting = true;
  setLiveState("waiting");
  $("waiting-banner").classList.remove("hidden");
  $("waiting-reason").textContent = reason || "";
}
window.__apexEnterWaiting = enterWaitingForHuman;

// ===================== KEYBOARD =====================

function bindKeyboard() {
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
    const steps = [...state.stepCards.keys()].sort((a, b) => a - b);
    if (!steps.length) return;

    if (e.key === "j" || e.key === "ArrowDown") {
      e.preventDefault();
      const idx = steps.indexOf(state.focusedStep);
      const next = steps[Math.min(idx + 1, steps.length - 1)];
      focusStep(next);
    } else if (e.key === "k" || e.key === "ArrowUp") {
      e.preventDefault();
      const idx = steps.indexOf(state.focusedStep);
      const prev = steps[Math.max(idx - 1, 0)];
      focusStep(prev);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (state.focusedStep) toggleStep(state.focusedStep);
    } else if (e.key === "f") {
      e.preventDefault();
      if (state.focusedStep) {
        const sc = state.stepCards.get(state.focusedStep);
        if (sc) {
          const lastTool = [...state.toolData.values()].filter((td) => td.step === state.focusedStep).pop();
          if (lastTool) handleReviewAction("flag", [...state.toolData.entries()].find(([, v]) => v === lastTool)?.[0], state.focusedStep, lastTool.name);
        }
      }
    } else if (e.key === "/") {
      e.preventDefault();
      $("say").focus();
    }
  });
}

function focusStep(stepNum) {
  // Unfocus previous
  if (state.focusedStep) {
    const prev = state.stepCards.get(state.focusedStep);
    if (prev) prev.el.style.outline = "";
  }
  state.focusedStep = stepNum;
  const card = state.stepCards.get(stepNum);
  if (card) {
    card.el.style.outline = "2px solid var(--accent)";
    card.el.style.outlineOffset = "-2px";
    card.el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

// ===================== SCROLL =====================

function scrollToBottom() {
  const rail = $("step-rail");
  rail.scrollTop = rail.scrollHeight;
}

// ===================== UTILS =====================

function nowTime() { return new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" }); }
function basename(p) { const s = String(p || ""); const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\")); return i >= 0 ? s.slice(i + 1) : s; }
function formatDur(ms) { const s = Math.round(ms / 1000); if (s < 60) return `${s}s`; return `${Math.floor(s / 60)}m ${s % 60}s`; }
function formatTokens(n) { return n >= 1000 ? `${(n / 1000).toFixed(1)}k tok` : `${n} tok`; }
function shortArgs(name, args) { return name === "run_python" ? (args.code || "") : JSON.stringify(args, null, 2); }
function clip(s, n) { s = String(s ?? ""); return s.length > n ? s.slice(0, n) + "…" : s; }
function esc(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function escAttr(s) { return esc(s).replace(/"/g, "&quot;"); }

boot();
