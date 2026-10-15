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
  main.append(h("h1", {}, "Workflows"), h("p", { class: "sub" }, "Deterministic automations. Running one makes no model calls."), h("div", { class: "split" }, list, detail));
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
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const inputs = {};
    for (const [key, { input, def }] of Object.entries(fields)) {
      if (def.type === "boolean") inputs[key] = input.checked;
      else if (input.value !== "") inputs[key] = def.type === "number" ? Number(input.value) : input.value;
    }
    runBtn.disabled = true;
    try {
      const { id } = await api("POST", "/v1/runs", { workflow: name, inputs });
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
    ),
  );
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
      s.error ? h("div", { class: "err" }, `${s.error.code}: ${s.error.message}`) : null));
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
