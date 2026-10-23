"use strict";
// First-run setup wizard (#/welcome): connects the Firebase MCP, picks the
// project/app, points at the fa_flutter_gt checkout and (optionally) Claude.
// Uses helpers from app.js: $, esc, api, post, cmdBox, store, fmt.

const WIZ_STEPS = [
  { id: "hello", icon: "👋", label: "Welcome" },
  { id: "tools", icon: "🧰", label: "Tools" },
  { id: "firebase", icon: "🔐", label: "Firebase" },
  { id: "project", icon: "📦", label: "Project" },
  { id: "code", icon: "💻", label: "Code" },
  { id: "ai", icon: "🤖", label: "AI" },
  { id: "done", icon: "🎉", label: "Done" },
];
const wiz = { step: 0, dir: 1, done: new Set(), checks: {}, login: null, projects: null, apps: null, cfg: null, busy: "", error: "", fix: "" };

function renderWelcome() {
  view.innerHTML = `<div class="wiz-bg"><i></i><i></i><i></i></div>
    <div class="wiz"><div id="wizStepper"></div><div class="card wiz-card"><div id="wizBody"></div></div>
    <div class="wiz-foot small muted">Runs on your machine with your own Google sign-in · nothing is uploaded
      · <a href="#/" id="wizSkip">skip setup</a></div></div>`;
  $("#wizSkip").addEventListener("click", () => store.set("setupDone", true));
  drawWiz();
  enterStep();
}

function go(step) {
  wiz.dir = step >= wiz.step ? 1 : -1;
  wiz.step = Math.max(0, Math.min(WIZ_STEPS.length - 1, step));
  wiz.error = wiz.fix = wiz.busy = "";
  drawWiz(true);
  enterStep();
}
const next = () => { wiz.done.add(WIZ_STEPS[wiz.step].id); go(wiz.step + 1); };

function drawWiz(animate) {
  if (!$("#wizBody")) return;
  const pctDone = (wiz.step / (WIZ_STEPS.length - 1)) * 100;
  $("#wizStepper").innerHTML = `<div class="stepper"><div class="stepper-line"><i style="width:${pctDone}%"></i></div>
    ${WIZ_STEPS.map((s, k) => `<button class="stp ${k === wiz.step ? "on" : ""} ${wiz.done.has(s.id) || k < wiz.step ? "ok" : ""}"
      data-go="${k}" ${k > wiz.step && !wiz.done.has(s.id) ? "disabled" : ""}><span>${wiz.done.has(s.id) || k < wiz.step ? "✓" : s.icon}</span><em>${s.label}</em></button>`).join("")}</div>`;
  $("#wizStepper").querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => go(+b.dataset.go)));
  const body = $("#wizBody");
  body.innerHTML = STEP_VIEWS[WIZ_STEPS[wiz.step].id]();
  if (animate) { body.classList.remove("in-l", "in-r"); void body.offsetWidth; body.classList.add(wiz.dir > 0 ? "in-r" : "in-l"); }
  bindStep();
}

// Status line shared by steps.
const busyLine = () => wiz.busy ? `<div class="wiz-busy"><span class="spinner"></span>${esc(wiz.busy)}</div>` : "";
const errLine = () => wiz.error ? `<div class="error small" style="margin-top:10px">${esc(wiz.error)}</div>${wiz.fix ? cmdBox(wiz.fix) : ""}` : "";
const chk = (c, label) => !c ? `<div class="wiz-chk"><span class="spinner"></span><span>${esc(label)}</span></div>`
  : `<div class="wiz-chk ${c.ok ? "ok" : c.optional ? "warn" : "bad"}"><span class="ic">${c.ok ? ICON_OK : ICON_BAD}</span>
      <span><b>${esc(label)}</b><br><span class="small muted">${esc(c.detail || "")}</span>${!c.ok && c.fix ? cmdBox(c.fix) : ""}</span></div>`;

const STEP_VIEWS = {
  hello: () => `<div class="wiz-hero">${heroArt()}</div>
    <h1 class="wiz-title">Crashlytics, without the console</h1>
    <p class="wiz-lead">Live crash triage for <b>fa_flutter_gt</b>: new-in-release crashes, blamed code at the shipped commit,
      git blame, bug patterns and AI root-cause drafts. Let's connect it in about <b>3 minutes</b>.</p>
    <div class="wiz-actions"><button class="btn primary" id="wizNext">Let's go →</button></div>`,

  tools: () => `<h2 class="wiz-h">Check your tools</h2>
    <p class="wiz-lead">Node runs the Firebase MCP server. uv already works, because it's running this dashboard.</p>
    ${chk({ ok: true, detail: "running this server" }, "uv + Python")}
    ${chk(wiz.checks.node, "Node.js 20+")}${chk(wiz.checks.git, "Git")}
    ${errLine()}
    <div class="wiz-actions"><button class="btn ghost" id="wizRecheck">↻ Re-check</button>
      <button class="btn primary" id="wizNext" ${wiz.checks.node?.ok && wiz.checks.git?.ok ? "" : "disabled"}>Continue →</button></div>`,

  firebase: () => {
    const m = wiz.checks.mcp, l = wiz.login;
    let inner;
    if (!m && !l) inner = `<div class="wiz-busy"><span class="spinner"></span>Starting the Firebase MCP server (first time ≈ 20s)…</div>`;
    else if (m?.ok && !l) inner = `<div class="wiz-user"><span class="avatar">${esc((m.user || "?")[0].toUpperCase())}</span>
        <div><b>${esc(m.user)}</b><div class="small muted">Signed in through the Firebase MCP</div></div>
        <span style="flex:1"></span><button class="btn ghost" id="wizSwitch">Switch account</button></div>`;
    else if (l?.status === "pending") inner = `<ol class="wiz-ol">
        <li>Open Google sign-in: <a class="btn" href="${esc(l.uri)}" target="_blank" rel="noopener">Sign in with Google ↗</a></li>
        ${l.sessionId ? `<li>Check that the page shows this session ID: <code class="sid">${esc(l.sessionId)}</code><div class="small muted">If it doesn't match, close the page; someone else's link.</div></li>` : ""}
        <li>Copy the authorization code Google shows you, and paste it here:
          <div class="wiz-row"><input id="authCode" placeholder="4/0A…" autocomplete="off" spellcheck="false">
          <button class="btn primary" id="wizCode">Connect</button></div></li></ol>`;
    else inner = `<div class="wiz-user muted">Not signed in yet.</div>
        <div class="wiz-actions" style="justify-content:flex-start"><button class="btn primary" id="wizLogin">Sign in with Google</button></div>
        <details><summary>Prefer the terminal?</summary>${cmdBox("npx -y firebase-tools@latest login")}<div class="small muted">Then press Re-check.</div></details>`;
    return `<h2 class="wiz-h">Connect Firebase</h2>
      <p class="wiz-lead">The dashboard reads Crashlytics through the Firebase MCP server with <b>your</b> Google account.</p>
      ${inner}${busyLine()}${errLine()}
      <div class="wiz-actions"><button class="btn ghost" id="wizRecheck">↻ Re-check</button>
        <button class="btn primary" id="wizNext" ${m?.ok && !l ? "" : "disabled"}>Continue →</button></div>`;
  },

  project: () => {
    const cfg = wiz.cfg || {}, c = wiz.checks.crashlytics;
    const projects = wiz.projects, apps = wiz.apps;
    const card = (sel, title, sub, attr) => `<button class="pick ${sel ? "on" : ""}" ${attr}><b>${esc(title)}</b><span>${esc(sub)}</span></button>`;
    const me = wiz.checks.mcp?.user || "my Google account";
    const ask = `Hi! Could you give ${me} the "Firebase Crashlytics Viewer" role on the Firebase project ${cfg.project}? I need it for the Crashlytics dashboard. Thanks!`;
    return `<h2 class="wiz-h">Pick the project and app</h2>
      <p class="wiz-lead">Only projects your account can see are listed.</p>
      <div class="small muted">Firebase project</div>
      <div class="picks">${projects ? projects.map((p) => card(p.projectId === cfg.project, p.name, p.projectId, `data-project="${esc(p.projectId)}"`)).join("") || `<div class="muted small">No Firebase projects visible to this account.</div>`
        : `<div class="skel" style="height:58px"></div><div class="skel" style="height:58px"></div>`}</div>
      ${cfg.project ? `<div class="small muted" style="margin-top:12px">Android app</div>
        <div class="picks">${apps ? apps.map((a) => card(a.appId === cfg.app, a.name, a.package, `data-app="${esc(a.appId)}"`)).join("") || `<div class="muted small">No Android apps in this project.</div>`
          : `<div class="skel" style="height:58px"></div><div class="skel" style="height:58px"></div>`}</div>` : ""}
      ${cfg.app ? `<div style="margin-top:14px">${c ? chk(c, "Crashlytics access") : chk(null, "Checking Crashlytics access…")}</div>
        ${c && !c.ok && /viewer/i.test(c.fix || "") ? `<div class="small" style="margin-top:6px">Send this to a Firebase admin:</div>${cmdBox(ask)}` : ""}` : ""}
      ${busyLine()}${errLine()}
      <div class="wiz-actions"><button class="btn primary" id="wizNext" ${c?.ok ? "" : "disabled"}>Continue →</button></div>`;
  },

  code: () => {
    const r = wiz.checks.repo;
    return `<h2 class="wiz-h">Point at your code</h2>
      <p class="wiz-lead">Your local <code>fa_flutter_gt</code> checkout powers blamed source, git blame and "which release broke it".</p>
      <div class="wiz-row"><input id="repoPath" value="${esc(wiz.repoDraft ?? wiz.cfg?.repo ?? "")}" placeholder="/Users/you/office/fa_flutter_gt" spellcheck="false">
        <button class="btn primary" id="wizRepo">Check</button></div>
      <div style="margin-top:10px">${r ? chk(r, "fa_flutter_gt checkout") : ""}</div>
      ${busyLine()}${errLine()}
      <div class="wiz-actions"><button class="btn ghost" id="wizSkipStep">Skip</button>
        <button class="btn primary" id="wizNext" ${r?.ok ? "" : "disabled"}>Continue →</button></div>`;
  },

  ai: () => `<h2 class="wiz-h">AI root-cause drafts <span class="badge">optional</span></h2>
    <p class="wiz-lead">The dashboard can ask Claude (read-only) to explain a crash and draft a fix. It uses your local Claude Code sign-in.</p>
    ${chk(wiz.checks.claude, "Claude CLI")}
    ${wiz.checks.claude && !wiz.checks.claude.ok ? `<div class="small muted">Run it in a terminal: it opens your browser to sign in. Then press Re-check.</div>` : ""}
    ${errLine()}
    <div class="wiz-actions"><button class="btn ghost" id="wizRecheck">↻ Re-check</button>
      <button class="btn primary" id="wizNext">${wiz.checks.claude?.ok ? "Continue →" : "Skip for now →"}</button></div>`,

  done: () => `<div class="confetti" aria-hidden="true">${Array.from({ length: 36 }, (_, k) =>
      `<i style="--x:${(k * 37) % 100}%;--d:${(k % 6) * 0.12}s;--r:${(k * 47) % 360}deg;--h:${(k * 53) % 360}"></i>`).join("")}</div>
    <div class="wiz-hero done-ring">${ICON_OK}</div>
    <h1 class="wiz-title">You're connected</h1>
    <div class="wiz-sum">
      <div>🔐 ${esc(wiz.checks.mcp?.user || "Signed in")}</div>
      <div>📦 ${esc(wiz.cfg?.project || "")}</div>
      <div>💻 ${wiz.checks.repo?.ok ? "Code checkout linked" : "No code checkout (skipped)"}</div>
      <div>🤖 ${wiz.checks.claude?.ok ? "AI drafts ready" : "AI drafts off"}</div>
    </div>
    <div class="wiz-actions" style="justify-content:center"><a class="cta" href="#/" id="wizFinish">Open the dashboard →</a></div>`,
};

function heroArt() {
  // Phone → crash spark → dashboard, with data dots flowing along the wire.
  return `<svg viewBox="0 0 320 120" class="hero-art" aria-hidden="true">
    <path id="heroWire" d="M78,60 C130,20 190,100 242,60" class="hero-wire"/>
    <circle r="4" class="hero-dot"><animateMotion dur="2.2s" repeatCount="indefinite"><mpath href="#heroWire"/></animateMotion></circle>
    <circle r="4" class="hero-dot"><animateMotion dur="2.2s" begin="-1.1s" repeatCount="indefinite"><mpath href="#heroWire"/></animateMotion></circle>
    <g transform="translate(40,18)"><rect width="38" height="84" rx="8" class="hero-dev"/><rect x="6" y="10" width="26" height="54" rx="3" class="hero-screen"/>
      <path d="M19,24 l-6,14 h6 l-3,12 l10,-17 h-6 l4,-9z" class="hero-bolt"/></g>
    <g transform="translate(242,22)"><rect width="56" height="76" rx="8" class="hero-dev"/>
      <rect x="8" y="46" width="7" height="20" rx="2" class="hero-bar"/><rect x="19" y="34" width="7" height="32" rx="2" class="hero-bar" style="animation-delay:.2s"/>
      <rect x="30" y="40" width="7" height="26" rx="2" class="hero-bar" style="animation-delay:.4s"/><rect x="41" y="24" width="7" height="42" rx="2" class="hero-bar" style="animation-delay:.6s"/>
      <rect x="8" y="10" width="40" height="6" rx="3" class="hero-screen"/></g>
  </svg>`;
}

// ------------------------------------------------------------ step logic
async function runChecks(ids) {
  const r = await api("/api/setup", { only: ids.join(",") });
  for (const c of r.checks) wiz.checks[c.id] = c;
}

async function enterStep() {
  const id = WIZ_STEPS[wiz.step].id;
  try {
    if (id === "tools" && !wiz.checks.node) { await runChecks(["node", "git"]); drawWiz(); }
    if (id === "firebase" && !wiz.checks.mcp) { await runChecks(["mcp"]); drawWiz(); }
    if (id === "project") {
      wiz.cfg = await api("/api/config");
      drawWiz();
      if (!wiz.projects) { wiz.projects = await api("/api/projects"); drawWiz(); }
      if (wiz.cfg.project && !wiz.apps) await loadApps2();
      if (wiz.cfg.app && !wiz.checks.crashlytics) { await runChecks(["crashlytics"]); drawWiz(); }
    }
    if (id === "code") {
      wiz.cfg = wiz.cfg || await api("/api/config");
      if (!wiz.checks.repo) { await runChecks(["repo"]); drawWiz(); }
    }
    if (id === "ai" && !wiz.checks.claude) { await runChecks(["claude"]); drawWiz(); }
    if (id === "done") store.set("setupDone", true);
  } catch (e) { wiz.error = e.message; wiz.fix = e.fix || ""; drawWiz(); }
}

async function loadApps2() {
  wiz.apps = null; drawWiz();
  wiz.apps = await api("/api/apps");
  drawWiz();
}

async function act(label, fn) {
  wiz.busy = label; wiz.error = wiz.fix = ""; drawWiz();
  try { await fn(); } catch (e) { wiz.error = e.message; wiz.fix = e.fix || ""; }
  wiz.busy = ""; drawWiz();
}

function bindStep() {
  const on = (sel, fn) => $(sel)?.addEventListener("click", fn);
  on("#wizNext", next);
  on("#wizSkipStep", () => go(wiz.step + 1));
  on("#wizRecheck", () => {
    const id = WIZ_STEPS[wiz.step].id;
    const ids = { tools: ["node", "git"], firebase: ["mcp"], ai: ["claude"] }[id] || [];
    ids.forEach((k) => delete wiz.checks[k]);
    wiz.login = null;
    act("Checking…", () => runChecks(ids));
  });
  on("#wizLogin", () => act("Asking Google for a sign-in link…", async () => { wiz.login = await post("/api/firebase/login", {}); afterLogin(); }));
  on("#wizSwitch", () => act("Starting a new sign-in…", async () => { wiz.login = await post("/api/firebase/login", { reauth: true }); afterLogin(); }));
  on("#wizCode", () => {
    const code = $("#authCode").value.trim();
    if (!code) return;
    act("Connecting…", async () => { wiz.login = await post("/api/firebase/login", { authCode: code }); afterLogin(); });
  });
  view.querySelectorAll("[data-project]").forEach((b) => b.addEventListener("click", () => act("Switching project…", async () => {
    wiz.cfg = await post("/api/config", { project: b.dataset.project });
    delete wiz.checks.crashlytics;
    wiz.projectsPicked = true;
    await loadApps2();
  })));
  view.querySelectorAll("[data-app]").forEach((b) => b.addEventListener("click", () => act("Checking Crashlytics access…", async () => {
    wiz.cfg = await post("/api/config", { app: b.dataset.app });
    delete wiz.checks.crashlytics;
    drawWiz();
    await runChecks(["crashlytics"]);
    F.app = wiz.cfg.app; store.set("filters", F); // dashboard follows the wizard's pick
  })));
  on("#wizRepo", () => {
    const repo = wiz.repoDraft = $("#repoPath").value.trim(); // read before act() redraws the step
    act("Checking the checkout…", async () => {
    wiz.cfg = await post("/api/config", { repo });
    delete wiz.checks.repo;
    await runChecks(["repo"]);
    });
  });
  on("#wizFinish", () => store.set("setupDone", true));
}

async function afterLogin() {
  if (wiz.login?.status === "signed_in") {
    wiz.checks.mcp = { ok: true, user: wiz.login.email, detail: "" };
    wiz.login = null;
    wiz.projects = wiz.apps = null; // a different account may see different projects
  }
}
