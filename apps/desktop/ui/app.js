// UI for Beacon Motive. All data comes through Tauri commands; this page makes no network requests and never
// holds the API token. Text is always set with textContent, never innerHTML.
const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args);
const api = (method, path, body) => invoke("api", { method, path, body: body ?? null });

const main = document.getElementById("main");
const state = { view: "workflows", workflow: null, runId: null, poll: null };

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, String(v));
  }
  for (const kid of kids.flat()) if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

// replaceChildren turns null into the text "null", so drop empty slots first.
function fill(el, ...kids) {
  el.replaceChildren(...kids.filter((k) => k != null));
}

function clear() {
  if (state.poll) clearInterval(state.poll);
  state.poll = null;
  main.replaceChildren();
}

function when(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
const ms = (n) => (n == null ? "" : n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${n} ms`);
const status = (s) => h("span", { class: `st ${s}` }, s);

// ---- engine status -----------------------------------------------------------------------------------------

async function refreshEngine() {
  const box = document.getElementById("engine");
  let s;
  try {
    s = await invoke("engine_status");
  } catch (e) {
    s = { running: false, port: 0 };
  }
  fill(box,
    h("span", {}, h("span", { class: `dot ${s.running ? "on" : "off"}` }), s.running ? `Engine running on 127.0.0.1:${s.port}` : "Engine not running"),
    s.running ? null : h("button", { class: "ghost", type: "button", onclick: startEngine }, "Start engine"),
  );
  return s.running;
}

async function startEngine() {
  try {
    await invoke("start_engine");
  } catch (e) {
    alert(String(e));
  }
  for (let i = 0; i < 40; i++) {
    if (await refreshEngine()) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  show(state.view);
}

document.getElementById("stop").addEventListener("click", async () => {
  try {
    const r = await api("POST", "/v1/stop");
    alert(r.cancelled ? `Cancelled ${r.cancelled} active run(s).` : "No active runs.");
  } catch (e) {
    alert(String(e));
  }
});

// ---- views -------------------------------------------------------------------------------------------------

function offline() {
  clear();
  main.append(
    h("div", { class: "banner" },
      h("strong", {}, "The engine is not running."),
      h("p", {}, "This app is a window onto the local Motive engine. Start it here, or run ", h("code", {}, "motive serve --port 47615"), " yourself."),
    ),
  );
}

async function show(view) {
  state.view = view;
  for (const b of document.querySelectorAll(".nav")) if (b.dataset.view === view) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  if (!(await refreshEngine())) return offline();
  try {
    if (view === "workflows") await workflowsView();
    else if (view === "runs") await runsView();
    else if (view === "audit") await auditView();
    else if (view === "teach") await teachView();
    else if (view === "schedules") await schedulesView();
    else if (view === "inspector") await inspectorView();
    else if (view === "permissions") await permissionsView();
    else if (view === "run") await runView(state.runId);
  } catch (e) {
    clear();
    main.append(h("div", { class: "banner" }, String(e)));
  }
}

async function workflowsView() {
  const { workflows } = await api("GET", "/v1/workflows");
  clear();
  const list = h("div", { class: "list" });
  const detail = h("div", {});
  if (!workflows.length) list.append(h("div", { class: "empty pad" }, "No workflows saved. Run ", h("code", {}, "motive save <file.json>"), "."));
  for (const w of workflows) {
    list.append(h("button", { class: "item", type: "button", "aria-current": String(state.workflow === w.name), onclick: () => { state.workflow = w.name; workflowsView(); } }, w.name, h("small", {}, `saved ${when(w.updatedAt)}`)));
  }
  main.append(h("h1", {}, "Workflows"), h("p", { class: "sub" }, "Deterministic automations. A run makes no model calls unless you turn on repair help for it."), h("div", { class: "split" }, list, detail));
  if (state.workflow && workflows.some((w) => w.name === state.workflow)) await workflowDetail(detail, state.workflow);
  else if (workflows.length) detail.append(h("div", { class: "empty" }, "Select a workflow."));
}

async function workflowDetail(into, name) {
  const w = await api("GET", `/v1/workflows/${encodeURIComponent(name)}`);
  const fields = {};
  const form = h("form", { class: "inputs" });
  for (const [key, def] of Object.entries(w.inputs)) {
    const input = h("input", {
      id: `in-${key}`,
      type: def.secret ? "password" : def.type === "number" ? "number" : def.type === "boolean" ? "checkbox" : "text",
      autocomplete: "off",
      value: def.default !== undefined && !def.secret ? String(def.default) : null,
    });
    if (def.type === "boolean" && def.default === true) input.checked = true;
    fields[key] = { input, def };
    form.append(h("label", { for: `in-${key}` }, key, def.secret ? " (secret)" : ""), input);
  }
  const runBtn = h("button", { class: "primary", type: "submit" }, "Run workflow");
  const caps = await api("GET", "/v1/capabilities").catch(() => ({}));
  const aiOk = Boolean(caps.ai && caps.ai.available);
  const aiBox = h("input", { id: "run-ai", type: "checkbox", disabled: !aiOk });
  const aiNote = h("span", { class: "sub" }, aiOk ? `Uses ${caps.ai.model} on this machine only. Nothing is applied automatically.` : `Unavailable: ${caps.ai?.reason ?? "no local model"}`);
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const inputs = {};
    for (const [key, { input, def }] of Object.entries(fields)) {
      if (def.type === "boolean") inputs[key] = input.checked;
      else if (input.value !== "") inputs[key] = def.type === "number" ? Number(input.value) : input.value;
    }
    runBtn.disabled = true;
    try {
      const { id } = await api("POST", "/v1/runs", { workflow: name, inputs, aiRecovery: aiBox.checked });
      state.runId = id;
      show("run");
    } catch (e) {
      runBtn.disabled = false;
      alert(String(e));
    }
  });
  const scopes = [...w.scopes.hosts.map((x) => `host ${x}`), ...w.scopes.dirs.map((x) => `folder ${x}`), ...w.scopes.apps.map((x) => `app ${x}`)];
  into.replaceChildren(
    h("div", { class: "card" },
      h("h1", {}, w.name),
      h("p", { class: "sub" }, w.description || "No description."),
      h("h2", {}, "May touch"),
      h("div", { class: "chips" }, scopes.length ? scopes.map((s) => h("span", { class: "chip" }, s)) : h("span", { class: "chip" }, "nothing outside its own steps")),
      h("h2", {}, "Inputs"),
      Object.keys(w.inputs).length ? null : h("p", { class: "sub" }, "None."),
      form,
      h("h2", {}, `Steps (${w.steps.length})`),
      h("ol", { class: "steps" }, w.steps.map((s) => h("li", { class: "plain" }, s.id, " ", h("span", { class: "mono" }, s.op), " ", s.when ? h("span", { class: "chip" }, "conditional") : null, s.forEach ? h("span", { class: "chip" }, "loop") : null))),
      h("div", { class: "row" }, h("button", { class: "ghost", type: "button", onclick: () => editView(w.name) }, "Edit workflow"), h("button", { class: "ghost", type: "button", onclick: () => deleteWorkflow(w.name) }, "Delete workflow")),
    ),
  );
  form.append(h("label", { for: "run-ai" }, "Repair help"), h("div", {}, h("label", {}, aiBox, " If a control cannot be found, ask the local model to suggest a repair"), h("div", {}, aiNote)));
  form.append(h("span", {}), h("div", { class: "row tight" }, runBtn));
}

async function runsView() {
  const { runs } = await api("GET", "/v1/runs");
  clear();
  main.append(h("h1", {}, "Run history"), h("p", { class: "sub" }, "Every run is recorded with its steps and outcome."));
  if (!runs.length) return main.append(h("div", { class: "empty" }, "No runs yet."));
  const rows = runs.map((r) => h("tr", { class: "click", tabindex: "0", onclick: () => { state.runId = r.id; show("run"); }, onkeydown: (e) => { if (e.key === "Enter") { state.runId = r.id; show("run"); } } },
    h("td", {}, r.workflow), h("td", {}, status(r.status)), h("td", {}, when(r.startedAt)), h("td", {}, ms(r.durationMs))));
  main.append(h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Workflow"), h("th", {}, "Status"), h("th", {}, "Started"), h("th", {}, "Took"))), h("tbody", {}, rows)));
}

async function runView(id) {
  const paint = async () => {
    const r = await api("GET", `/v1/runs/${encodeURIComponent(id)}`);
    const steps = r.steps.map((s) => h("li", {},
      h("span", { class: `st ${s.status}`, "aria-label": s.status }, s.status === "succeeded" ? "✓" : s.status === "skipped" ? "–" : "✗"),
      h("span", {}, s.stepId, " ", h("span", { class: "mono" }, s.op)),
      h("span", { class: "mono" }, ms(s.durationMs)),
      s.error ? h("div", { class: "err" }, `${s.error.code}: ${s.error.message}`) : null,
      ...repairs(r, s)));
    const cancel = r.status === "running" ? h("button", { class: "ghost", type: "button", onclick: async () => { await api("POST", `/v1/runs/${encodeURIComponent(id)}/cancel`); paint(); } }, "Cancel run") : null;
    const outputs = r.outputs && Object.keys(r.outputs).length ? h("pre", { class: "mono card" }, JSON.stringify(r.outputs, null, 2)) : null;
    fill(main,
      h("button", { class: "ghost", type: "button", onclick: () => show("runs") }, "← Run history"),
      h("h1", { class: "gap" }, r.workflow, " ", status(r.status)),
      h("p", { class: "sub" }, `Started ${when(r.startedAt)}`, r.durationMs != null ? ` · took ${ms(r.durationMs)}` : ""),
      r.error ? h("div", { class: "banner" }, `${r.error.code}: ${r.error.message}`) : null,
      h("h2", {}, "Steps"),
      steps.length ? h("ol", { class: "steps card" }, steps) : h("p", { class: "sub" }, "No steps finished yet."),
      outputs ? h("h2", {}, "Outputs") : null, outputs,
      h("div", { class: "row" }, cancel),
    );
    if (r.status !== "running" && state.poll) { clearInterval(state.poll); state.poll = null; }
  };
  clear();
  await paint();
  state.poll = setInterval(() => paint().catch(() => {}), 500);
}

async function auditView() {
  const { audit } = await api("GET", "/v1/audit");
  clear();
  main.append(h("h1", {}, "Audit log"), h("p", { class: "sub" }, "Runs, cancellations and refused requests. Nothing leaves this machine."));
  if (!audit.length) return main.append(h("div", { class: "empty" }, "Nothing recorded yet."));
  main.append(h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "When"), h("th", {}, "Actor"), h("th", {}, "Action"), h("th", {}, "Detail"))),
    h("tbody", {}, audit.map((a) => h("tr", {}, h("td", {}, when(a.ts)), h("td", {}, a.actor), h("td", {}, a.action), h("td", { class: "mono" }, typeof a.detail === "string" ? a.detail : JSON.stringify(a.detail ?? "")))))));
}

for (const b of document.querySelectorAll(".nav")) b.addEventListener("click", () => show(b.dataset.view));
show("workflows");
setInterval(refreshEngine, 5000);

// ---- Teach Mode --------------------------------------------------------------------------------------------

async function teachView() {
  clear();
  if (state.recId) return recordingView();
  const kind = h("select", { id: "rec-kind" }, h("option", { value: "browser" }, "A website in a browser"), h("option", { value: "windows" }, "A Windows app"));
  const name = h("input", { id: "rec-name", type: "text", placeholder: "e.g. submit-timesheet", autocomplete: "off" });
  const url = h("input", { id: "rec-url", type: "text", placeholder: "https://…", autocomplete: "off" });
  const win = h("input", { id: "rec-window", type: "text", placeholder: "Title of the app window", autocomplete: "off" });
  const cmd = h("input", { id: "rec-command", type: "text", placeholder: "Optional: program to launch first", autocomplete: "off" });
  const expectText = h("input", { id: "rec-expect", type: "text", placeholder: "Optional: text that proves it worked", autocomplete: "off" });
  const browserRows = [h("label", { for: "rec-url" }, "Start page"), url, h("label", { for: "rec-expect" }, "Expect on page"), expectText];
  const winRows = [h("label", { for: "rec-window" }, "Window"), win, h("label", { for: "rec-command" }, "Launch"), cmd];
  const form = h("form", { class: "inputs" }, h("label", { for: "rec-kind" }, "Teach me"), kind, h("label", { for: "rec-name" }, "Workflow name"), name);
  const swap = () => {
    for (const el of [...browserRows, ...winRows]) el.remove();
    form.append(...(kind.value === "browser" ? browserRows : winRows));
  };
  kind.addEventListener("change", swap);
  swap();
  const go = h("button", { class: "primary", type: "submit" }, "Start recording");
  form.append(h("span", {}), h("div", { class: "row tight" }, go));
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const spec = kind.value === "browser" ? { kind: "browser", name: name.value.trim(), url: url.value.trim(), ...(expectText.value.trim() ? { expectText: expectText.value.trim() } : {}) } : { kind: "windows", name: name.value.trim(), window: win.value.trim(), ...(cmd.value.trim() ? { command: cmd.value.trim() } : {}) };
    go.disabled = true;
    try {
      const { id } = await api("POST", "/v1/record", spec);
      state.recId = id;
      teachView();
    } catch (e) {
      go.disabled = false;
      alert(String(e));
    }
  });
  main.append(
    h("h1", {}, "Teach Mode"),
    h("p", { class: "sub" }, "Show it once; replay it with new values. Recording is always visible: a browser window opens, or a red indicator appears over the app. Passwords and card numbers are never captured."),
    h("div", { class: "card" }, form),
  );
}

async function recordingView() {
  const id = state.recId;
  const paint = async () => {
    const r = await api("GET", `/v1/record/${encodeURIComponent(id)}`);
    if (r.status === "starting" || r.status === "recording") {
      return fill(main,
        h("div", { class: "rec-banner", role: "status" }, h("span", { class: "rec-dot", "aria-hidden": "true" }), r.status === "starting" ? "Starting…" : `Recording “${r.name}”`),
        h("p", { class: "sub" }, r.kind === "browser" ? "Do the task in the browser window that opened. Press Finish here, or close that window, when you are done." : "Do the task in the app window. Press Finish here when you are done."),
        h("div", { class: "row" },
          h("button", { class: "primary", type: "button", onclick: async () => { try { await api("POST", `/v1/record/${encodeURIComponent(id)}/finish`); } catch (e) { alert(String(e)); } paint(); } }, "Finish"),
          h("button", { class: "ghost", type: "button", onclick: () => discard(id) }, "Discard")));
    }
    if (state.poll) { clearInterval(state.poll); state.poll = null; }
    if (r.status === "failed") {
      return fill(main, h("h1", {}, "Recording failed"), h("div", { class: "banner" }, `${r.error.code}: ${r.error.message}`), h("div", { class: "row" }, h("button", { class: "ghost", type: "button", onclick: () => { state.recId = null; teachView(); } }, "Back")));
    }
    if (r.status === "discarded") { state.recId = null; return teachView(); }
    const w = r.workflow;
    const inputs = Object.entries(w.inputs);
    fill(main,
      h("h1", {}, "Review “", w.name, "”"),
      h("p", { class: "sub" }, `${r.steps} recorded ${r.steps === 1 ? "action" : "actions"} became ${w.steps.length} ${w.steps.length === 1 ? "step" : "steps"}. Nothing is saved until you save it.`),
      r.warnings.length ? h("div", { class: "banner" }, h("strong", {}, "Check these"), h("ul", {}, r.warnings.map((x) => h("li", {}, x)))) : null,
      h("h2", {}, "Inputs (change per run)"),
      inputs.length ? h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Name"), h("th", {}, "Type"), h("th", {}, "Demonstrated value"))),
        h("tbody", {}, inputs.map(([k, d]) => h("tr", {}, h("td", {}, k), h("td", {}, d.type, d.secret ? " · secret" : ""), h("td", {}, d.secret ? "not recorded" : String(d.default ?? "")))))) : h("p", { class: "sub" }, "None: it does the same thing every time."),
      h("h2", {}, `Steps (${w.steps.length})`),
      h("ol", { class: "steps card" }, w.steps.map((s) => h("li", { class: "plain" }, s.id, " ", h("span", { class: "mono" }, s.op)))),
      h("div", { class: "row" },
        h("button", { class: "primary", type: "button", onclick: async () => { try { await api("POST", `/v1/record/${encodeURIComponent(id)}/save`); state.recId = null; state.workflow = w.name; show("workflows"); } catch (e) { alert(String(e)); } } }, "Save to library"),
        h("button", { class: "ghost", type: "button", onclick: () => discard(id) }, "Discard")));
  };
  await paint();
  state.poll = setInterval(() => paint().catch(() => {}), 700);
}

async function discard(id) {
  try { await api("DELETE", `/v1/record/${encodeURIComponent(id)}`); } catch (e) { alert(String(e)); }
  state.recId = null;
  show("teach");
}

// ---- Schedules ---------------------------------------------------------------------------------------------

function describeEvery(e) {
  return e.kind === "minutes" ? (e.value === 1 ? "every minute" : `every ${e.value} minutes`) : `daily at ${e.at}`;
}

async function schedulesView() {
  const [{ schedules }, { workflows }] = await Promise.all([api("GET", "/v1/schedules"), api("GET", "/v1/workflows")]);
  clear();
  const wf = h("select", { id: "sch-wf" }, workflows.map((w) => h("option", { value: w.name }, w.name)));
  const kind = h("select", { id: "sch-kind" }, h("option", { value: "minutes" }, "Every N minutes"), h("option", { value: "daily" }, "Daily at a time"));
  const minutes = h("input", { id: "sch-min", type: "number", min: "1", max: "10080", value: "60" });
  const at = h("input", { id: "sch-at", type: "text", value: "09:00", placeholder: "HH:MM (24 hour)", autocomplete: "off" });
  const whenBox = h("span", {}, minutes);
  kind.addEventListener("change", () => whenBox.replaceChildren(kind.value === "minutes" ? minutes : at));
  const add = h("button", { class: "primary", type: "submit" }, "Add schedule");
  const form = h("form", { class: "inputs" }, h("label", { for: "sch-wf" }, "Workflow"), wf, h("label", { for: "sch-kind" }, "Repeat"), kind, h("label", {}, "When"), whenBox, h("span", {}), h("div", { class: "row tight" }, add));
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const every = kind.value === "minutes" ? { kind: "minutes", value: Number(minutes.value) } : { kind: "daily", at: at.value.trim() };
    try {
      await api("POST", "/v1/schedules", { workflow: wf.value, every });
      schedulesView();
    } catch (e) {
      alert(String(e));
    }
  });
  const rows = schedules.map((s) => h("tr", {},
    h("td", {}, s.workflow), h("td", {}, describeEvery(s.every)), h("td", {}, s.enabled ? "on" : "off"),
    h("td", {}, s.lastFiredAt ? `${when(s.lastFiredAt)}: ${s.lastResult}` : "not yet"),
    h("td", {}, h("button", { class: "ghost", type: "button", onclick: async () => { await api("POST", `/v1/schedules/${encodeURIComponent(s.id)}/${s.enabled ? "disable" : "enable"}`); schedulesView(); } }, s.enabled ? "Pause" : "Resume"), " ",
      h("button", { class: "ghost", type: "button", onclick: async () => { await api("DELETE", `/v1/schedules/${encodeURIComponent(s.id)}`); schedulesView(); } }, "Delete"))));
  fill(main,
    h("h1", {}, "Schedules"),
    h("p", { class: "sub" }, "Runs happen only while this app (or motive serve) is running. A run that comes due while the engine is busy or off is skipped, never queued. Secret inputs cannot be scheduled."),
    workflows.length ? h("div", { class: "card" }, form) : h("p", { class: "empty" }, "Save a workflow first."),
    h("h2", {}, "Active schedules"),
    schedules.length ? h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Workflow"), h("th", {}, "Repeats"), h("th", {}, "State"), h("th", {}, "Last firing"), h("th", {}, ""))), h("tbody", {}, rows)) : h("p", { class: "empty" }, "None yet."));
}

// ---- Workflow editing --------------------------------------------------------------------------------------
// Edits a local copy; nothing changes until Save, and the engine validates the whole workflow on save.

async function deleteWorkflow(name) {
  if (!confirm(`Delete workflow "${name}"? Its run history is kept.`)) return;
  try {
    await api("DELETE", `/v1/workflows/${encodeURIComponent(name)}`);
    state.workflow = null;
    show("workflows");
  } catch (e) {
    alert(String(e));
  }
}

async function editView(name) {
  const original = await api("GET", `/v1/workflows/${encodeURIComponent(name)}`);
  const draft = structuredClone(original);
  let dirty = false;
  state.workflow = name;
  clear();
  const status = h("div", { role: "status", class: "sub" });
  const desc = h("input", { id: "ed-desc", type: "text", value: draft.description ?? "", autocomplete: "off" });
  desc.addEventListener("input", () => {
    draft.description = desc.value || undefined;
    dirty = true;
  });
  const list = h("div", {});
  const move = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= draft.steps.length) return;
    [draft.steps[i], draft.steps[j]] = [draft.steps[j], draft.steps[i]];
    dirty = true;
    paint();
  };
  const paint = () => {
    list.replaceChildren(
      ...draft.steps.map((s, i) => {
        const text = JSON.stringify(s, null, 2);
        const area = h("textarea", { class: "mono json", rows: String(Math.min(14, text.split("\n").length + 1)), "aria-label": `Step ${s.id} as JSON`, spellcheck: "false" });
        area.value = text;
        const msg = h("span", { class: "sub" });
        area.addEventListener("change", () => {
          try {
            const parsed = JSON.parse(area.value);
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("a step is a JSON object");
            draft.steps[i] = parsed;
            dirty = true;
            msg.textContent = "Applied (checked when you save).";
          } catch (e) {
            msg.textContent = `Not applied: ${e.message}`;
          }
        });
        return h("div", { class: "card step-edit" },
          h("div", { class: "row tight" },
            h("strong", {}, `${i + 1}. ${s.id}`), " ", h("span", { class: "mono" }, s.op),
            h("button", { class: "ghost", type: "button", disabled: i === 0, onclick: () => move(i, -1) }, "Up"),
            h("button", { class: "ghost", type: "button", disabled: i === draft.steps.length - 1, onclick: () => move(i, 1) }, "Down"),
            h("button", { class: "ghost", type: "button", disabled: draft.steps.length === 1, onclick: () => { draft.steps.splice(i, 1); dirty = true; paint(); } }, "Remove")),
          area, msg);
      }),
    );
  };
  paint();
  const save = h("button", { class: "primary", type: "button", onclick: async () => {
    try {
      await api("PUT", `/v1/workflows/${encodeURIComponent(name)}`, draft);
      dirty = false;
      show("workflows");
    } catch (e) {
      status.textContent = `Not saved: ${e}`;
      status.className = "banner";
    }
  } }, "Save changes");
  const cancel = h("button", { class: "ghost", type: "button", onclick: () => { if (!dirty || confirm("Discard your edits?")) show("workflows"); } }, "Cancel");
  fill(main,
    h("h1", {}, `Edit “${name}”`),
    h("p", { class: "sub" }, "Change the description, reorder or remove steps, or edit a step as JSON (selectors, values, conditions, retries). Inputs and scopes are not edited here: to widen what a workflow may touch, change its file and save it with the CLI."),
    h("div", { class: "card" }, h("form", { class: "inputs" }, h("label", { for: "ed-desc" }, "Description"), desc)),
    h("h2", {}, `Steps (${draft.steps.length})`), list,
    status, h("div", { class: "row" }, save, cancel));
}

// ---- Permissions: what the engine can reach, and what each workflow may touch ----------------------------------

async function permissionsView() {
  const [{ adapters }, { workflows }] = await Promise.all([api("GET", "/v1/capabilities"), api("GET", "/v1/workflows")]);
  const full = await Promise.all(workflows.map((w) => api("GET", `/v1/workflows/${encodeURIComponent(w.name)}`)));
  clear();
  const adapterRows = adapters.map((a) => h("tr", {}, h("td", {}, a.adapter), h("td", {}, h("span", { class: `st ${a.available ? "succeeded" : "failed"}` }, a.available ? "available" : "unavailable")), h("td", {}, a.reason || ""), h("td", { class: "mono" }, a.ops.join(" "))));
  const scopeCell = (list) => (list.length ? h("div", { class: "chips" }, list.map((x) => h("span", { class: "chip" }, x))) : h("span", { class: "sub" }, "none"));
  const wfRows = full.map((w) => h("tr", {}, h("td", {}, w.name), h("td", {}, scopeCell(w.scopes.hosts)), h("td", {}, scopeCell(w.scopes.dirs)), h("td", {}, scopeCell(w.scopes.apps)),
    h("td", {}, Object.entries(w.inputs).filter(([, d]) => d.secret).map(([k]) => k).join(", ") || "none")));
  fill(main,
    h("h1", {}, "Permissions"),
    h("p", { class: "sub" }, "Workflows can touch only what they declare, and adapters refuse anything else. Nothing here is sent anywhere. The engine never elevates, never reads password fields, and never runs shell commands."),
    h("h2", {}, "What this machine can automate"),
    h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Adapter"), h("th", {}, "State"), h("th", {}, "Why not"), h("th", {}, "Operations"))), h("tbody", {}, adapterRows)),
    h("h2", {}, "What each workflow may touch"),
    full.length ? h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Workflow"), h("th", {}, "Websites"), h("th", {}, "Folders"), h("th", {}, "Apps"), h("th", {}, "Secret inputs"))), h("tbody", {}, wfRows)) : h("p", { class: "empty" }, "No workflows saved."));
}

// ---- Inspector: read-only view of a Windows app's controls -----------------------------------------------------

async function inspectorView() {
  clear();
  const out = h("div", {});
  const list = h("div", { class: "list" });
  const depth = h("input", { id: "insp-depth", type: "number", min: "1", max: "6", value: "3" });
  main.append(
    h("h1", {}, "Inspector"),
    h("p", { class: "sub" }, "Shows the controls of a Windows app (names, automation ids, types) so you can write or fix selectors. It reads control metadata only, never what is typed into fields, and password controls are never read. Each look is written to the audit log."),
    h("div", { class: "row" }, h("label", { for: "insp-depth" }, "Depth"), depth, h("button", { class: "ghost", type: "button", onclick: loadWindows }, "Refresh windows")),
    h("div", { class: "split" }, list, out),
  );
  async function loadWindows() {
    list.replaceChildren(h("div", { class: "empty pad" }, "Loading…"));
    try {
      const { windows } = await api("GET", "/v1/inspect/windows");
      const named = windows.filter((w) => w.name && w.controlType === "Window");
      list.replaceChildren(...(named.length ? named.map((w) => h("button", { class: "item", type: "button", onclick: () => loadTree(w.name) }, w.name, h("small", {}, w.className))) : [h("div", { class: "empty pad" }, "No windows found.")]));
    } catch (e) {
      list.replaceChildren(h("div", { class: "empty pad" }, String(e)));
    }
  }
  async function loadTree(name) {
    out.replaceChildren(h("div", { class: "empty" }, "Reading…"));
    try {
      const { tree } = await api("GET", `/v1/inspect/tree?window=${encodeURIComponent(name)}&depth=${encodeURIComponent(depth.value)}`);
      const rows = [];
      const walk = (n, d) => {
        const sel = n.automationId ? `automationId: ${n.automationId}` : n.name ? `name: ${n.name}` : "";
        rows.push(h("li", { class: "plain tree" , "data-depth": String(d) }, h("span", { class: "mono" }, n.controlType), " ", n.name || h("span", { class: "sub" }, "(no name)"), n.password ? h("span", { class: "chip" }, "password: never read") : null, sel ? h("div", { class: "mono sub" }, sel) : null));
        for (const c of n.children || []) walk(c, d + 1);
      };
      walk(tree, 0);
      out.replaceChildren(h("h2", {}, name), h("ol", { class: "steps card" }, rows));
    } catch (e) {
      out.replaceChildren(h("div", { class: "banner" }, String(e)));
    }
  }
  loadWindows();
}

// Repair proposals recorded by the engine when a target stopped matching. Each is checked to resolve to exactly one
// control; applying one is always an explicit click here (it edits the stored workflow, keeping the old target as an alternative).
function repairs(run, step) {
  const props = step.error && step.error.details && step.error.details.proposals;
  if (!props || !props.length) return [];
  return props.map((p, i) => h("div", { class: "repair" },
    h("div", {}, h("strong", {}, "Suggested repair"), p.source ? ` (from ${p.source})` : " (a recorded alternative)", ": ", h("span", { class: "mono" }, JSON.stringify(p.target))),
    p.reason ? h("div", { class: "sub" }, p.reason) : null,
    h("button", { class: "ghost", type: "button", onclick: async () => {
      if (!confirm("Update the stored workflow to use this target? The old target is kept as an alternative.")) return;
      try {
        await api("POST", `/v1/runs/${encodeURIComponent(run.id)}/heal`, { step: step.stepId, index: i });
        alert("Workflow updated. Run it again to check.");
      } catch (e) {
        alert(String(e));
      }
    } }, "Apply this repair")));
}
