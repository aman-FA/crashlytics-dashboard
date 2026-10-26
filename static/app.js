"use strict";
// Crashlytics Live — vanilla SPA. Routes: #/  and  #/issue/<id>

const POLL_MS = 60_000;

// Blunder watch: heuristic risk score per open issue. Tune weights/keywords here.
const RISK = {
  userShare: 50,      // × fraction of users hit (of version users, else of the worst issue)
  newInRelease: 25,   // first seen in the selected version → this release introduced it
  regressed: 25,      // Crashlytics: came back after being closed
  fresh: 15,          // Crashlytics: new in the last 7 days
  early: 15,          // Crashlytics: crashes in the first seconds of a session
  criticalFlow: 15,   // title/exception touches a business-critical flow (below)
  growing: 10,        // gained events since the last poll
  fatal: 5,
};
const CRITICAL_FLOWS = [
  [/login|auth|token|\b401\b|unauthori[sz]ed/i, "Login / auth"],
  [/(?<!a)sync|master_?data/i, "Data sync"], // not "async"
  [/\border|Order|\bcart\b|scheme|invoice|payment|collection/, "Order / money"], // not "border"
  [/day_?(start|end)|attendance/i, "Day start/end"],
  [/upload|image_recognition|ir_v2|camera/i, "Upload / IR"],
  [/realm|database|\bdao\b/i, "Local DB"],
];
const $ = (s, el = document) => el.querySelector(s);
const view = $("#view");

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem("cd." + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("cd." + k, JSON.stringify(v)); } catch {} },
};

const F = Object.assign(
  { app: "", version: "5.7.1 (601)", type: "FATAL", days: "7", from: "", to: "", signal: "", device: "", os: "" },
  store.get("filters", {}));
const ui = Object.assign({ q: "", state: "OPEN", sort: "events", scope: "all" }, store.get("ui", {}));
let overview = null, issue = null, selectedEvent = 0, pollTimer = null, lastOk = null;
const noteDrafts = {};

// ------------------------------------------------------------------ utils
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => (n == null || n === "" ? "–" : Number(n).toLocaleString());
const pct = (n) => (n == null ? "–" : `${Number(n).toFixed(1)}%`);
const bytes = (n) => (n ? `${(Number(n) / 2 ** 30).toFixed(1)} GB` : "–");
// Exact local date-time, e.g. "26 Oct 2026, 08:45:12" (no relative "1h ago").
const DT_FMT = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const dt = (t) => (t ? DT_FMT.format(new Date(t)) : "–");
const isAppCode = (s) => /package:fa_flutter_gt\//.test(s || "");
// datetime-local values are local wall time; the server wants UTC ISO.
const localInput = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const toUtc = (v) => new Date(v).toISOString();
const rangeParams = () => F.days === "custom" && F.from && F.to
  ? { from: toUtc(F.from), to: toUtc(F.to) } : { days: F.days === "custom" ? "7" : F.days };
const rangeLabel = () => F.days === "custom" && F.from && F.to ? `${dt(F.from)} → ${dt(F.to)}`
  : ({ 1: "last 24h", 7: "last 7 days", 30: "last 30 days", 90: "last 90 days" }[F.days] || `last ${F.days} days`);
const filterParams = () => {
  const p = { type: F.type, ...rangeParams() };
  for (const k of ["app", "version", "signal", "device", "os"]) if (F[k]) p[k] = F[k];
  return p;
};

async function api(path, params = {}, opts) {
  const url = path + "?" + new URLSearchParams(params);
  const r = await fetch(url, opts);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
async function post(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app: F.app || undefined, ...body }) });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { fix: j.fix });
  return j;
}

function setStatus(text, cls) {
  $("#status").textContent = text;
  $("#liveDot").className = "dot " + (cls || "");
}

// ----------------------------------------------------------------- charts
// Single-series charts, so no legend: the card title names the measure.
function barChart(rows, key, label = fmt) {
  if (!rows.length) return `<div class="empty">No data</div>`;
  const W = 600, H = 150, pad = 26, max = Math.max(1, ...rows.map((r) => r[key] || 0));
  const bw = (W - pad) / rows.length, gap = Math.min(6, bw * 0.25);
  const ticks = [0, 0.5, 1].map((f) => Math.round(max * f));
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H + 18}" preserveAspectRatio="none"><g class="grid">`;
  for (const t of ticks) {
    const y = H - (t / max) * (H - 8);
    s += `<line x1="${pad}" x2="${W}" y1="${y}" y2="${y}"/><text x="0" y="${y + 3}">${compact(t)}</text>`;
  }
  s += "</g>";
  rows.forEach((r, i) => {
    const v = r[key] || 0, h = Math.max(v ? 2 : 0, (v / max) * (H - 8));
    const x = pad + i * bw + gap / 2, w = bw - gap, y = H - h;
    const tip = esc(`${r.date}: ${label(v)}`);
    s += `<rect class="hit" x="${pad + i * bw}" y="0" width="${bw}" height="${H}" data-tip="${tip}"/>`;
    s += `<path class="bar" data-tip="${tip}" d="M${x},${H}V${y + Math.min(4, h)}q0,-${Math.min(4, h)} ${Math.min(4, w / 2)},-${Math.min(4, h)}h${w - 2 * Math.min(4, w / 2)}q${Math.min(4, w / 2)},0 ${Math.min(4, w / 2)},${Math.min(4, h)}V${H}Z"/>`;
    if (rows.length <= 14 || i % Math.ceil(rows.length / 10) === 0)
      s += `<text x="${x + w / 2}" y="${H + 14}" text-anchor="middle">${r.date.slice(5)}</text>`;
  });
  return s + "</svg>";
}

function lineChart(rows, key, label = pct) {
  const pts = rows.filter((r) => r[key] != null);
  if (pts.length < 1) return `<div class="empty">No data</div>`;
  const W = 600, H = 150, pad = 30;
  const vals = pts.map((r) => r[key]);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 1) { lo -= 0.5; hi += 0.5; }
  const x = (i) => pad + (pts.length === 1 ? (W - pad) / 2 : (i / (pts.length - 1)) * (W - pad - 6));
  const y = (v) => H - 6 - ((v - lo) / (hi - lo)) * (H - 14);
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H + 18}" preserveAspectRatio="none"><g class="grid">`;
  for (const v of [lo, (lo + hi) / 2, hi])
    s += `<line x1="${pad}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text x="0" y="${y(v) + 3}">${v.toFixed(1)}%</text>`;
  s += `</g><polyline class="ln" pathLength="1" points="${pts.map((r, i) => `${x(i)},${y(r[key])}`).join(" ")}"/>`;
  pts.forEach((r, i) => {
    const tip = esc(`${r.date}: ${label(r[key])}`);
    s += `<circle class="pt" cx="${x(i)}" cy="${y(r[key])}" r="4"/>`;
    s += `<circle class="hit" cx="${x(i)}" cy="${y(r[key])}" r="12" data-tip="${tip}"/>`;
    if (pts.length <= 14 || i % Math.ceil(pts.length / 10) === 0)
      s += `<text x="${x(i)}" y="${H + 14}" text-anchor="middle">${r.date.slice(5)}</text>`;
  });
  return s + "</svg>";
}
const compact = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));

document.addEventListener("mousemove", (e) => {
  const t = e.target.closest?.("[data-tip]"), tip = $("#tip");
  if (!t) { tip.hidden = true; return; }
  tip.textContent = t.dataset.tip;
  tip.hidden = false;
  tip.style.left = Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8) + "px";
  tip.style.top = e.clientY + 14 + "px";
});

// ---------------------------------------------------------------- filters
function syncFilterInputs() {
  for (const k of ["version", "type", "days", "signal"]) $("#f-" + k).value = F[k];
  // From/To always show the active window: the custom one, or the preset's.
  const now = new Date();
  $("#f-from").value = F.days === "custom" ? F.from : localInput(new Date(now - Number(F.days) * 864e5));
  $("#f-to").value = F.days === "custom" ? F.to : localInput(now);
  $("#f-apply").disabled = true;
  $("#f-apply").classList.remove("primary");
  const chips = [];
  if (F.device) chips.push(["device", `Device: ${F.device}`]);
  if (F.os) chips.push(["os", `OS: ${F.os}`]);
  $("#chips").innerHTML = chips.map(([k, l]) => `<button class="chip" data-clear="${k}">${esc(l)} ✕</button>`).join("");
}
function setFilter(patch) {
  Object.assign(F, patch);
  store.set("filters", F);
  scheduleAlerts();
  syncFilterInputs();
  route();
}
for (const k of ["version", "type", "signal"])
  $("#f-" + k).addEventListener("change", (e) => setFilter({ [k]: e.target.value }));
$("#f-days").addEventListener("change", (e) => {
  if (e.target.value !== "custom") return setFilter({ days: e.target.value });
  $("#f-from").focus(); // edit From/To, then Apply
});
// Editing either field makes it a custom range, applied with the Apply button.
for (const id of ["#f-from", "#f-to"]) $(id).addEventListener("input", () => {
  $("#f-days").value = "custom";
  $("#f-apply").disabled = false;
  $("#f-apply").classList.add("primary");
});
$("#f-apply").addEventListener("click", () => {
  const from = $("#f-from").value, to = $("#f-to").value;
  if (!from || !to) return alert("Pick both a start and an end date-time.");
  if (new Date(from) >= new Date(to)) return alert("The range must start before it ends.");
  setFilter({ days: "custom", from, to });
});
$("#f-app").addEventListener("change", (e) => setFilter({ app: e.target.value, version: "", device: "", os: "" }));
$("#chips").addEventListener("click", (e) => {
  const k = e.target.dataset.clear;
  if (k) setFilter({ [k]: "" });
});

function fillVersions(versions) {
  const sel = $("#f-version");
  const names = versions.map((v) => v.name);
  if (F.version && !names.includes(F.version)) names.unshift(F.version);
  sel.innerHTML = `<option value="">All versions</option>` +
    names.map((n) => `<option>${esc(n)}</option>`).join("");
  sel.value = F.version;
}

async function loadApps() {
  try {
    const apps = await api("/api/apps");
    const sel = $("#f-app");
    sel.innerHTML = apps.map((a) => `<option value="${esc(a.appId)}">${esc(a.name)} · ${esc(a.package)}</option>`).join("");
    if (!F.app || !apps.some((a) => a.appId === F.app)) {
      F.app = (apps.find((a) => a.package === "com.flick2know.CokeBuddyForSales") || apps[0] || {}).appId || "";
    }
    sel.value = F.app;
    $("#appName").textContent = apps.find((a) => a.appId === F.app)?.package || "";
  } catch (e) {
    $("#f-app").innerHTML = `<option value="">default app</option>`;
  }
}

// --------------------------------------------------------------- overview
async function renderOverview(silent) {
  if (!silent || !overview) view.innerHTML = skeleton("Fetching Crashlytics data… the first load takes ~30s while the Firebase MCP starts.");
  const params = filterParams();
  const [ov, tr, nr] = await Promise.allSettled([api("/api/overview", params), api("/api/trend", params),
    api("/api/new-in-release", params)]);
  if (ov.status === "rejected") throw ov.reason;
  overview = ov.value;
  overview.trend = tr.status === "fulfilled" ? tr.value : null;
  overview.trendError = tr.status === "rejected" ? tr.reason.message : null;
  overview.newRel = nr.status === "fulfilled" ? nr.value : { error: nr.reason.message, issues: [], regressed: [] };
  fillVersions(overview.versions);
  drawOverview();
}

function drawOverview() {
  const o = overview, k = o.kpi;
  const open = o.issues.filter((i) => i.state === "OPEN");
  const totalEvents = o.issues.reduce((s, i) => s + i.events, 0);
  const fresh = o.issues.filter((i) => i.isNew).length;
  const regressed = o.issues.filter((i) => i.signals.some((s) => s.signal === "SIGNAL_REGRESSED")).length;
  const appEvents = o.issues.filter((i) => isAppCode(i.title)).reduce((s, i) => s + i.events, 0);
  const top = o.issues[0];
  const tiles = [
    k && ["Crash-free users", pct(k.crashFreeUsers), `${fmt(k.impactedUsers)} of ${fmt(k.totalUsers)} users hit`],
    k && ["Crash-free sessions", pct(k.crashFreeSessions), `${fmt(k.sessions)} of ${fmt(k.totalSessions)} sessions`],
    ["Events", fmt(k ? k.events : totalEvents), `${o.issues.length} issues in range`],
    ["Open issues", fmt(open.length), `${fresh} new since last poll · ${regressed} regressed`, fresh > 0],
    ["Top issue share", top && totalEvents ? pct((top.events / totalEvents) * 100) : "–", top ? shortTitle(top.title) : ""],
    ["In app code", totalEvents ? pct((appEvents / totalEvents) * 100) : "–", "of events blame fa_flutter_gt frames"],
  ].filter(Boolean);

  view.innerHTML = `
    ${!F.version ? `<div class="card small muted" style="margin-bottom:14px">Pick a version to see crash-free rates; all-version view shows counts only.</div>` : ""}
    <div class="grid g-tiles">${tiles.map(([l, v, s, bad]) => `
      <div class="card tile ${bad ? "crit" : ""}"><div class="label">${l}</div><div class="val">${v}</div>
      <div class="sub">${esc(s)}</div></div>`).join("")}</div>

    ${newReleaseCard(o.newRel)}

    <div class="grid g-2">
      <div class="card"><h2>Events per day <span class="muted small">UTC days · ${esc(rangeLabel())}</span></h2>
        ${o.trend ? barChart(o.trend, "events") : `<div class="error">${esc(o.trendError || "")}</div>`}</div>
      <div class="card"><h2>${F.version ? "Crash-free users per day" : "Users affected per day"}</h2>
        ${o.trend ? (F.version ? lineChart(o.trend, "crashFreeUsers") : barChart(o.trend, "impactedUsers")) : ""}</div>
    </div>

    <div class="split">
    <div class="card">
      <h2>Issues <span class="muted small">${o.deltaSince ? `Δ = new events since ${new Date(o.deltaSince * 1000).toLocaleTimeString()}` : "Δ appears after the next poll"}</span></h2>
      <div class="toolbar">
        <input type="search" id="q" placeholder="Search title, exception, file, issue id…" value="${esc(ui.q)}">
        <div class="seg" id="stateSeg">${["OPEN", "CLOSED", "MUTED", "ALL"].map((s) =>
          `<button data-v="${s}" class="${ui.state === s ? "on" : ""}">${s[0] + s.slice(1).toLowerCase()}</button>`).join("")}</div>
        <div class="seg" id="scopeSeg">${[["all", "All code"], ["app", "App code"], ["lib", "Libraries"], ["new", "🆕 New in release"]].map(([v, l]) =>
          `<button data-v="${v}" class="${ui.scope === v ? "on" : ""}">${l}</button>`).join("")}</div>
      </div>
      <div class="scroll" id="issueTable"></div>
    </div>
    ${blunderWatch(o)}
    </div>

    ${patternsCard(o)}

    <div class="grid g-3">
      ${dimCard("Versions", o.versions, "version", true)}
      ${dimCard("Devices", o.devices, "device")}
      ${dimCard("OS versions", o.os, "os")}
    </div>`;
  drawIssueTable();
  if (view.classList.contains("anim")) countUp(view);
  view.querySelectorAll("[data-goto]").forEach((tr) => tr.addEventListener("click", () => (location.hash = `#/issue/${tr.dataset.goto}`)));
  $("#q").addEventListener("input", (e) => { ui.q = e.target.value; store.set("ui", ui); drawIssueTable(); });
  $("#stateSeg").addEventListener("click", (e) => segPick(e, "state"));
  $("#scopeSeg").addEventListener("click", (e) => segPick(e, "scope"));
  view.querySelectorAll("[data-dim]").forEach((tr) => tr.addEventListener("click", () =>
    setFilter({ [tr.dataset.dim]: F[tr.dataset.dim] === tr.dataset.name ? "" : tr.dataset.name })));
}

function riskOf(i, o) {
  const k = o.kpi, reasons = [];
  let score = 0;
  const maxUsers = Math.max(1, ...o.issues.map((x) => x.impactedUsers));
  const share = k?.totalUsers ? i.impactedUsers / k.totalUsers : i.impactedUsers / maxUsers;
  score += share * RISK.userShare;
  reasons.push([k?.totalUsers ? `${pct(share * 100)} of users` : `${fmt(i.impactedUsers)} users`, share >= 0.5 ? "crit" : "warn"]);
  const release = F.version.split(" ")[0] || o.newRel?.release;
  if (release && i.firstSeen === release) { score += RISK.newInRelease; reasons.push([`New in ${release}`, "crit"]); }
  const has = (s) => i.signals.some((x) => x.signal === s);
  if (has("SIGNAL_REGRESSED")) { score += RISK.regressed; reasons.push(["Regressed", "crit"]); }
  if (has("SIGNAL_FRESH")) { score += RISK.fresh; reasons.push(["Fresh", "new"]); }
  if (has("SIGNAL_EARLY")) { score += RISK.early; reasons.push(["Crashes at start", "warn"]); }
  const text = `${i.title} ${i.subtitle}`;
  const flows = CRITICAL_FLOWS.filter(([re]) => re.test(text)).map(([, l]) => l);
  if (flows.length) { score += RISK.criticalFlow; flows.forEach((f) => reasons.push([f, "warn"])); }
  if (i.delta > 0) { score += RISK.growing; reasons.push([`+${fmt(i.delta)} since last poll`, "crit"]); }
  if (i.errorType === "FATAL") score += RISK.fatal;
  if (isAppCode(i.title)) reasons.push(["Our code", "info"]);
  return { score, reasons };
}

function blunderWatch(o) {
  const ranked = o.issues.filter((i) => i.state === "OPEN")
    .map((i) => ({ i, ...riskOf(i, o) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
  const max = Math.max(1, ...ranked.map((r) => r.score));
  return `<aside class="card blunder"><h2>⚠ Blunder watch <span class="muted small" title="${esc(
    "Score = users hit, new in this release, regressed, fresh, early crash, critical flow, growing, fatal. Weights: RISK in app.js")}">why?</span></h2>
    <div class="small muted" style="margin:-4px 0 10px">Open issues most likely to stop users working, ranked.</div>
    ${ranked.map(({ i, score, reasons }, n) => `<a class="risk" href="#/issue/${i.id}">
      <div class="risk-head"><span class="rank">${n + 1}</span><span class="t-title">${esc(shortTitle(i.title))}</span>
        <span class="score" title="risk score">${Math.round(score)}</span></div>
      <div class="share"><i style="width:${(score / max) * 100}%"></i></div>
      <div class="t-sub">${esc(i.subtitle.replace("io.flutter.plugins.firebase.crashlytics.FlutterError - ", "").slice(0, 140))}</div>
      <div class="reasons">${reasons.map(([l, c]) => `<span class="badge ${c}">${esc(l)}</span>`).join("")}</div>
      <div class="small muted">${fmt(i.events)} events · ${esc(i.firstSeen)} → ${esc(i.lastSeen)}</div>
    </a>`).join("") || `<div class="empty">No open issues.</div>`}
  </aside>`;
}

// Bug patterns: the same failure shape thrown from different places, so one
// shared fix (e.g. an isClosed guard) clears many issues.
function patternOf(subtitle) {
  return (subtitle || "")
    .replace(/^[\w.$]+?(Error|Exception)\s*-\s*/, "")
    .replace(/\[ERROR\]\s*Caught error:\s*/i, "")
    .replace(/\.?\s*Error thrown (Custom|Uncaught Fatal) Crash\.?$/i, "")
    .replace(/'[^']*'|"[^"]*"/g, "'…'")
    .replace(/\b0x[0-9a-f]+\b/gi, "0x…")
    .replace(/\d+/g, "N")
    .replace(/\s+/g, " ").trim().slice(0, 110);
}

function patternsCard(o) {
  const groups = new Map();
  for (const i of o.issues.filter((x) => x.state === "OPEN")) {
    const k = patternOf(i.subtitle);
    if (!k) continue;
    const g = groups.get(k) || { key: k, issues: [], events: 0, users: 0 };
    g.issues.push(i);
    g.events += i.events;
    g.users = Math.max(g.users, i.impactedUsers); // users overlap across issues; max is a floor
    groups.set(k, g);
  }
  const multi = [...groups.values()].filter((g) => g.issues.length > 1).sort((a, b) => b.events - a.events);
  const total = o.issues.reduce((s, i) => s + i.events, 0) || 1;
  return `<div class="card" style="margin-bottom:14px"><h2>Bug patterns
      <span class="muted small">same error from different places — fix the pattern once</span></h2>
    ${multi.slice(0, 8).map((g) => `<div class="pattern">
      <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap">
        <div class="msg">${esc(g.key)}</div>
        <div class="small" style="white-space:nowrap"><b>${g.issues.length}</b> issues · <b>${fmt(g.events)}</b> events
          (${pct((g.events / total) * 100)}) · ≥${fmt(g.users)} users</div></div>
      <div class="share"><i style="width:${(g.events / total) * 100}%"></i></div>
      <div class="files">${g.issues.map((i) => `<a href="#/issue/${i.id}" title="${esc(i.title)}">${esc(shortTitle(i.title))} (${fmt(i.events)})</a>`).join("")}</div>
    </div>`).join("") || `<div class="muted small">No repeated error patterns among open issues.</div>`}
  </div>`;
}

// New in release: Crashlytics' firstSeenVersion (tracked across all versions)
// equals the release, so no earlier version ever reported this crash.
const isNewInRelease = (i) => !!overview?.newRel?.release && String(i.firstSeen) === overview.newRel.release;

function newReleaseCard(nr) {
  if (!nr) return "";
  if (nr.error) return `<div class="error small">New-in-release check failed: ${esc(nr.error)}</div>`;
  if (!nr.version) return "";
  const issues = nr.issues, ev = issues.reduce((s, i) => s + i.events, 0);
  const users = Math.max(0, ...issues.map((i) => i.impactedUsers));
  const row = (i) => `<tr class="click" data-goto="${i.id}">
      <td>${isAppCode(i.title) ? `<span class="badge info">app</span>` : ""}<span class="t-title">${esc(shortTitle(i.title))}</span>
        <div class="t-sub">${esc(i.subtitle.replace("io.flutter.plugins.firebase.crashlytics.FlutterError - ", "").slice(0, 160))}</div>
        <div style="margin-top:3px">${stateBadge(i.state)}${signalBadges(i.signals)}</div></td>
      <td class="num">${fmt(i.events)}</td><td class="num">${fmt(i.impactedUsers)}</td>
      <td class="num">${nr.versionEvents ? pct((i.events / nr.versionEvents) * 100) : "–"}</td></tr>`;
  return `<div class="card newrel" style="margin-bottom:14px">
    <h2><span>🆕 New crashes in ${esc(nr.version)} <span class="muted small">never seen in earlier versions${nr.previous ? ` (incl. ${esc(nr.previous)})` : ""}</span></span>
      <span class="small">${issues.length ? `<b>${issues.length}</b> new issues · <b>${fmt(ev)}</b> events (${pct(nr.versionEvents ? (ev / nr.versionEvents) * 100 : 0)} of this release) · ≥${fmt(users)} users` : ""}</span></h2>
    ${issues.length ? `<div class="scroll"><table><thead><tr><th>Issue</th><th class="num">Events</th><th class="num">Users</th><th class="num">Share of release</th></tr></thead>
      <tbody>${issues.map(row).join("")}</tbody></table></div>`
      : `<div class="badge good" style="padding:4px 8px">✓ No new crash types in ${esc(nr.version)}: every issue here existed in an earlier version</div>`}
    ${nr.regressed.length ? `<details><summary>Also regressed in ${esc(nr.version)} (${nr.regressed.length}): old issues that came back after being closed</summary>
      <div class="scroll"><table><tbody>${nr.regressed.map(row).join("")}</tbody></table></div></details>` : ""}
    <div class="small muted" style="margin-top:6px">Based on Crashlytics' first-seen version for each issue, across ${fmt(nr.versionIssues)} issues reported by ${esc(nr.version)} in this range.
      ${F.version ? "" : "No version selected, so this uses the newest version."}</div>
  </div>`;
}

function segPick(e, key) {
  const v = e.target.dataset.v;
  if (!v) return;
  ui[key] = v;
  store.set("ui", ui);
  e.currentTarget.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
  drawIssueTable();
}

const shortTitle = (t) => (t || "").replace(/^package:[\w_]+\//, "").replace(/^.*\/(\w+\.dart)/, "$1");
const SIGNAL = { SIGNAL_FRESH: ["Fresh", "new"], SIGNAL_REGRESSED: ["Regressed", "crit"],
  SIGNAL_EARLY: ["Early", "warn"], SIGNAL_REPETITIVE: ["Repetitive", ""] };
const signalBadges = (sigs) => sigs.map((s) => {
  const [l, c] = SIGNAL[s.signal] || [s.signal, ""];
  return `<span class="badge ${c}" title="${esc(s.description)}">${l}</span>`;
}).join("");
const stateBadge = (s) => `<span class="badge ${s === "OPEN" ? "info" : s === "CLOSED" ? "good" : ""}">${esc(s)}</span>`;

function drawIssueTable() {
  const q = ui.q.trim().toLowerCase();
  const total = overview.issues.reduce((s, i) => s + i.events, 0) || 1;
  let rows = overview.issues.filter((i) =>
    (ui.state === "ALL" || i.state === ui.state) &&
    (ui.scope === "all" || (ui.scope === "new" ? isNewInRelease(i) : (ui.scope === "app") === isAppCode(i.title))) &&
    (!q || `${i.title} ${i.subtitle} ${i.id}`.toLowerCase().includes(q)));
  const key = ui.sort;
  rows.sort((a, b) => (b[key] ?? -1) - (a[key] ?? -1));
  const th = (k, l) => `<th class="num sortable ${key === k ? "sorted" : ""}" data-sort="${k}">${l}${key === k ? " ↓" : ""}</th>`;
  $("#issueTable").innerHTML = rows.length ? `<table><thead><tr><th>Issue</th>${th("events", "Events")}${th("delta", "Δ")}
    ${th("impactedUsers", "Users")}${F.version ? th("crashFreeUsers", "Crash-free users") : ""}<th>Versions</th></tr></thead><tbody>
    ${rows.map((i) => `<tr class="click" data-id="${i.id}">
      <td>${isNewInRelease(i) ? `<span class="badge crit">🆕 New in ${esc(overview.newRel.release)}</span>` : ""}${i.isNew ? `<span class="badge new" title="Appeared since the last poll">Just in</span>` : ""}${i.errorType !== "FATAL" ? `<span class="badge warn">${esc(i.errorType)}</span>` : ""}
        ${isAppCode(i.title) ? `<span class="badge info">app</span>` : ""}
        <span class="t-title">${esc(shortTitle(i.title))}</span>
        <div class="t-sub">${esc(i.subtitle.replace("io.flutter.plugins.firebase.crashlytics.FlutterError - ", ""))}</div>
        <div style="margin-top:4px">${stateBadge(i.state)}${signalBadges(i.signals)}</div>
        <div class="share" title="${pct((i.events / total) * 100)} of listed events"><i style="width:${(i.events / total) * 100}%"></i></div></td>
      <td class="num">${fmt(i.events)}</td>
      <td class="num">${i.delta ? `<span class="delta">+${fmt(i.delta)}</span>` : "–"}</td>
      <td class="num">${fmt(i.impactedUsers)}</td>
      ${F.version ? `<td class="num">${pct(i.crashFreeUsers)}</td>` : ""}
      <td class="small muted">${esc(i.firstSeen)} → ${esc(i.lastSeen)}</td></tr>`).join("")}
    </tbody></table>` : `<div class="empty">No issues match.</div>`;
  $("#issueTable").querySelectorAll("[data-sort]").forEach((h) => h.addEventListener("click", () => {
    ui.sort = h.dataset.sort; store.set("ui", ui); drawIssueTable();
  }));
  $("#issueTable").querySelectorAll("tr[data-id]").forEach((tr) =>
    tr.addEventListener("click", () => (location.hash = `#/issue/${tr.dataset.id}`)));
}

function dimCard(title, rows, dim, crashFree) {
  const total = rows.reduce((s, r) => s + r.events, 0) || 1;
  return `<div class="card"><h2>${title} <span class="muted small">click to filter</span></h2><div class="scroll"><table>
    <thead><tr><th>Name</th><th class="num">Events</th><th class="num">Users</th>${crashFree ? `<th class="num">Crash-free</th>` : ""}</tr></thead><tbody>
    ${rows.slice(0, 15).map((r) => `<tr class="click ${F[dim] === r.name ? "active" : ""}" data-dim="${dim}" data-name="${esc(r.name)}">
      <td>${esc(r.name)}<div class="share"><i style="width:${(r.events / total) * 100}%"></i></div></td>
      <td class="num">${fmt(r.events)}</td><td class="num">${fmt(r.impactedUsers)}${r.totalUsers ? `<span class="muted"> / ${fmt(r.totalUsers)}</span>` : ""}</td>
      ${crashFree ? `<td class="num">${r.totalUsers ? pct(r.crashFreeUsers) : "–"}</td>` : ""}</tr>`).join("")}
    </tbody></table></div></div>`;
}

// ------------------------------------------------------------------ issue
async function renderIssue(id, silent) {
  if (!silent || issue?.issue?.id !== id) {
    view.innerHTML = skeleton("Loading issue, events and breakdowns…");
    selectedEvent = 0;
  }
  const params = { ...filterParams(), id };
  const [d, tr] = await Promise.allSettled([api("/api/issue", params), api("/api/issue/trend", params)]);
  if (d.status === "rejected") throw d.reason;
  issue = d.value;
  issue.trend = tr.status === "fulfilled" ? tr.value : [];
  issue.id = id;
  drawIssue();
}

function frameLink(line, roots) {
  const m = line.match(/package:([\w_]+)\/([^\s:()]+\.dart):(\d+)/);
  if (!m || !roots?.[m[1]]) return esc(line);
  return esc(line).replace(esc(m[0]), `<a href="vscode://file${esc(roots[m[1]])}/${esc(m[2])}:${m[3]}">${esc(m[0])}</a>`);
}
function stackHtml(text, blame, roots) {
  if (!text) return `<span class="muted">No stack trace in this event.</span>`;
  const blameKey = blame?.file && blame?.line ? `${blame.file}:${blame.line}` : null;
  return text.split("\n").map((l) => {
    const cls = blameKey && l.includes(blameKey) ? "app blamed" : isAppCode(l) ? "app" : "";
    return `<span class="${cls}">${frameLink(l, roots)}</span>`;
  }).join("\n");
}

function drawIssue() {
  const d = issue, i = d.issue || {}, ev = d.events[selectedEvent];
  const total = d.versions.reduce((s, v) => s + v.events, 0);
  const users = d.versions.reduce((s, v) => s + v.impactedUsers, 0);
  const listed = overview?.issues?.find((x) => x.id === d.id);
  const allEvents = overview?.issues?.reduce((s, x) => s + x.events, 0);
  const state = i.state || listed?.state;
  view.innerHTML = `
    ${d.warnings?.length ? `<div class="error small">Some breakdowns failed to load (Crashlytics error), they'll retry on the next refresh: ${esc(d.warnings.join(" · "))}</div>` : ""}
    <div class="ih"><div style="min-width:0;flex:1">
      <a class="back" href="#/">← All issues</a>
      <h1>${esc(i.title || listed?.title || d.id)}</h1>
      <div class="t-sub">${esc(i.subtitle || "")}</div>
      <div style="margin-top:6px">${stateBadge(state)}<span class="badge">${esc(i.errorType || "")}</span>
        ${overview?.newRel?.release && String(i.firstSeenVersion) === overview.newRel.release
          ? `<span class="badge crit" title="Crashlytics first saw this issue in ${esc(overview.newRel.release)}: earlier versions never had it">🆕 New in ${esc(overview.newRel.release)}</span>` : ""}
        ${signalBadges(i.signals || [])}<span class="muted small">first seen ${esc(i.firstSeenVersion)} · last seen ${esc(i.lastSeenVersion)} · id <code>${esc(d.id)}</code></span></div>
      ${(i.signals || []).map((s) => `<div class="small muted">${esc(s.description)}</div>`).join("")}
    </div>
    <div class="actions">
      <button class="btn" id="copyMd">Copy as ticket</button>
      ${state !== "CLOSED" ? `<button class="btn" data-state="CLOSED">Close</button>` : ""}
      ${state !== "MUTED" ? `<button class="btn" data-state="MUTED">Mute</button>` : ""}
      ${state !== "OPEN" ? `<button class="btn" data-state="OPEN">Reopen</button>` : ""}
      ${i.uri ? `<a class="btn ghost" href="${esc(i.uri)}" target="_blank" rel="noopener">Firebase ↗</a>` : ""}
    </div></div>

    <div class="grid g-tiles">
      <div class="card tile"><div class="label">Events</div><div class="val">${fmt(listed?.events ?? total)}</div>
        <div class="sub">${allEvents && listed ? pct((listed.events / allEvents) * 100) + " of all listed events" : "in range"}</div></div>
      <div class="card tile"><div class="label">Users affected</div><div class="val">${fmt(listed?.impactedUsers ?? users)}</div>
        <div class="sub">${listed?.events && listed?.impactedUsers ? (listed.events / listed.impactedUsers).toFixed(1) + " events per user" : ""}</div></div>
      <div class="card tile"><div class="label">Versions hit</div><div class="val">${d.versions.length}</div>
        <div class="sub">${esc(d.versions[0]?.name || "")} worst</div></div>
      <div class="card tile"><div class="label">Devices hit</div><div class="val">${d.devices.length}${d.devices.length >= 15 ? "+" : ""}</div>
        <div class="sub">${esc(d.devices[0]?.name || "")} worst</div></div>
      <div class="card tile"><div class="label">Last event</div><div class="val" style="font-size:18px">${dt(d.events[0]?.time)}</div>
        <div class="sub">${esc(d.events[0] ? `${d.events[0].version || ""} · ${d.events[0].device.displayName || ""}` : "")}</div></div>
    </div>

    <div class="grid g-2">
      <div class="card"><h2>Events per day</h2>${barChart(d.trend, "events")}</div>
      <div class="card"><h2>Users affected per day</h2>${barChart(d.trend, "impactedUsers")}</div>
    </div>

    <div class="grid g-2">
      <div class="card"><h2>Blamed code ${d.source ? `<a class="small" href="${esc(d.source.editor)}">Open in VS Code ↗</a>` : ""}</h2>
        ${d.blame?.file ? `<div class="mono small" style="margin-bottom:8px">${esc(d.blame.symbol)} · ${esc(d.blame.file)}:${esc(d.blame.line)}
          <span class="badge">${esc(d.blame.owner || "")}</span></div>` : `<div class="muted">No blamed frame.</div>`}
        ${d.source ? `<div class="src mono">${d.source.lines.map((l, k) => {
          const n = d.source.start + k;
          return `<div class="${n === d.source.line ? "hl" : ""}"><span class="ln">${n}</span>${esc(l)}</div>`;
        }).join("")}</div><div class="small muted" style="margin-top:6px">${d.source.rev
          ? `As shipped in ${esc(d.shipVersion)} · revision <code>${esc(d.source.rev.slice(0, 10))}</code> (its pubspec version bump)`
          : "From your working tree — no pubspec bump found for this version, so lines may not match."}</div>`
          : d.blame?.file ? `<div class="small muted">Source not in a local checkout.</div>` : ""}
        ${blameHtml(d.gitBlame)}
      </div>
      <div class="card"><h2>Stack trace <span class="muted small">event ${selectedEvent + 1} of ${d.events.length}</span></h2>
        <pre class="stack">${stackHtml(ev?.exceptions, d.blame, d.sourceRoots)}</pre>
        ${ev?.threads && ev.threads !== ev.exceptions ? `<details><summary>Threads</summary><pre class="stack">${stackHtml(ev.threads, d.blame, d.sourceRoots)}</pre></details>` : ""}
      </div>
    </div>

    <div class="card" style="margin-bottom:14px" id="aiCard">${aiHtml(d.id)}</div>

    <div class="grid g-2">
      <div class="card" id="diffCard">${diffHtml(d)}</div>
      <div class="card"><h2>Clues <span class="muted small">device, memory &amp; user patterns in the last ${d.events.length} events</span></h2>${cluesHtml(d)}</div>
    </div>

    <div class="grid g-2">
      <div class="card"><h2>Recent events <span class="muted small">click one to inspect</span></h2>
        <div class="events scroll"><table><thead><tr><th>Time</th><th>User</th><th>Device</th><th>OS</th><th>Version</th></tr></thead><tbody>
        ${d.events.map((e, k) => `<tr class="click ${k === selectedEvent ? "active" : ""}" data-ev="${k}">
          <td class="small">${esc(dt(e.time))}</td>
          <td class="small">${esc(e.customKeys?.user_Name || e.user || "–")}</td>
          <td class="small">${esc(e.device.displayName || "")}</td><td class="small">${esc(e.os.displayVersion || "")}</td>
          <td class="small">${esc(e.version || "")}</td></tr>`).join("") || `<tr><td colspan="5" class="muted">No events in range.</td></tr>`}
        </tbody></table></div></div>
      <div class="card"><h2>Event details</h2>${ev ? eventDetails(ev) : `<div class="muted">–</div>`}</div>
    </div>

    <div class="grid g-3">
      <div class="card"><h2>Users hitting it <span class="muted small">from last ${d.events.length} events</span></h2><div class="scroll"><table>
        <thead><tr><th>User</th><th>Company</th><th class="num">Events</th><th>Device</th></tr></thead><tbody>
        ${d.sampleUsers.slice(0, 20).map((u) => `<tr><td>${esc(u.name || "–")}<div class="t-sub">${esc(u.id)}</div></td>
          <td>${esc(u.company || "–")}</td><td class="num">${u.events}</td><td class="small">${esc(u.devices.join(", "))}</td></tr>`).join("") ||
          `<tr><td colspan="4" class="muted">No user keys on events.</td></tr>`}
        </tbody></table></div></div>
      ${dimTable("Versions", d.versions)}
      ${dimTable("Devices", d.devices)}
      ${dimTable("OS versions", d.os)}
      <div class="card"><h2>Variants <span class="muted small">different stack shapes</span></h2><div class="scroll"><table>
        <thead><tr><th>Variant</th><th class="num">Events</th><th class="num">Users</th></tr></thead><tbody>
        ${d.variants.map((v) => `<tr><td class="mono small"><a href="${esc(v.uri)}" target="_blank" rel="noopener">${esc(v.id.slice(0, 12))}…</a></td>
          <td class="num">${fmt(v.events)}</td><td class="num">${fmt(v.impactedUsers)}</td></tr>`).join("")}</tbody></table></div></div>
      <div class="card"><h2>Notes</h2>
        ${d.notes.map((n) => `<div class="note"><div class="small muted">${esc(n.author || "")} · ${esc(dt(n.createTime))}</div>${esc(n.body || n.note || JSON.stringify(n))}</div>`).join("") || `<div class="muted small">No notes yet.</div>`}
        <textarea id="noteText" placeholder="Add a note (saved to Firebase)…" style="margin-top:8px">${esc(noteDrafts[d.id] || "")}</textarea>
        <button class="btn" id="addNote" style="margin-top:6px">Add note</button>
      </div>
    </div>`;

  view.querySelectorAll("[data-ev]").forEach((tr) => tr.addEventListener("click", () => {
    selectedEvent = Number(tr.dataset.ev); drawIssue();
  }));
  view.querySelectorAll("[data-state]").forEach((b) => b.addEventListener("click", () => changeState(b.dataset.state, b)));
  $("#addNote").addEventListener("click", addNote);
  // Keep the draft across the 60s live re-render.
  $("#noteText").addEventListener("input", (e) => { noteDrafts[d.id] = e.target.value; });
  $("#copyMd").addEventListener("click", copyTicket);
  bindIssueExtras(d);
  if (view.classList.contains("anim")) countUp(view);
}

// ---------------------------------------------------------- blame & diff
function blameHtml(b) {
  if (!b) return "";
  return `<div class="blame"><div class="small muted">Last change to the blamed line${b.rev ? " (as of the shipped build)" : ""}</div>
    <div style="margin:4px 0"><b>${esc(b.author)}</b> · ${esc(dt(b.date))} · <code>${esc(b.sha.slice(0, 10))}</code></div>
    <div>${esc(b.summary)}</div>
    ${b.history?.length ? `<details><summary>Recent history of this file (${b.history.length})</summary>
      ${b.history.map((c) => `<div class="commit"><span class="sha">${esc(c.sha)}</span><span class="muted">${esc(c.date)}</span>
        <span>${esc(c.subject)} <span class="muted">— ${esc(c.author)}</span></span></div>`).join("")}</details>` : ""}
  </div>`;
}

const diffState = {}; // issue id -> {loading, data, error, base}
const isLocalFrame = (d) => !!d.blame?.file && Object.keys(d.sourceRoots || {}).some((k) => d.blame.file.startsWith(`package:${k}/`));
function diffHtml(d) {
  const s = diffState[d.id] || {};
  const head = `<h2>Which release broke it? <span class="muted small">commits touching the blamed file</span></h2>`;
  if (!isLocalFrame(d))
    return head + `<div class="muted small">The blamed frame isn't in a local checkout (library or platform code).</div>`;
  if (s.loading) return head + `<div class="muted"><span class="spinner"></span>Reading git history…</div>`;
  if (s.error) return head + `<div class="error">${esc(s.error)}</div>`;
  if (!s.data) return head + `<div class="muted small">Not loaded.</div>`;
  const r = s.data;
  const sel = `<select id="diffBase">${r.versions.filter((v) => v !== r.to).map((v) =>
    `<option ${v === r.base ? "selected" : ""}>${esc(v)}</option>`).join("")}</select>`;
  const row = (c) => `<div class="commit"><span class="sha">${esc(c.sha)}</span><span class="muted">${esc(c.date)}</span>
    <span>${esc(c.subject)} <span class="muted">— ${esc(c.author)}</span></span></div>`;
  return head + `<div class="toolbar small">Changes to <code>${esc(r.file)}</code> from ${sel} → <b>${esc(r.to)}</b></div>
    ${r.baseCommit && !r.baseExact ? `<div class="small muted">Base build isn't an ancestor of ${esc(r.to)}; comparing from their merge-base.</div>` : ""}
    ${!r.baseCommit ? `<div class="small muted">No pubspec bump found for the base; showing the last 15 changes.</div>` : ""}
    ${r.commits.length ? r.commits.map(row).join("")
      : `<div class="badge good" style="margin:6px 0">No changes to this file in this range</div>
         <div class="small muted">So the crash likely comes from a caller, config, data or dependency change.</div>`}
    ${r.releaseCommits?.length ? `<details ${r.commits.length ? "" : "open"}><summary>Everything else in this range (${r.releaseCommitCount} commits in lib/ & pubspec)</summary>
      ${r.releaseCommits.map(row).join("")}${r.releaseCommitCount > r.releaseCommits.length ? `<div class="small muted">…and ${r.releaseCommitCount - r.releaseCommits.length} more</div>` : ""}</details>` : ""}`;
}

async function loadDiff(d, base) {
  const to = d.shipVersion || F.version;
  if (!to) { diffState[d.id] = { error: "Pick a version (or open an event with a version) to compare releases." }; return redrawDiff(d); }
  diffState[d.id] = { loading: true };
  redrawDiff(d);
  try {
    const data = await api("/api/issue/release-diff", { ...filterParams(), file: d.blame.file, to, ...(base ? { base } : {}) });
    diffState[d.id] = { data };
  } catch (e) { diffState[d.id] = { error: e.message }; }
  redrawDiff(d);
}
function redrawDiff(d) {
  const el = $("#diffCard");
  if (!el || issue?.id !== d.id) return;
  el.innerHTML = diffHtml(d);
  $("#diffBase")?.addEventListener("change", (e) => loadDiff(d, e.target.value));
}

// ------------------------------------------------------------------ clues
function cluesHtml(d) {
  const ev = d.events;
  if (!ev.length) return `<div class="muted small">No events to analyse.</div>`;
  const out = [];
  const shareRows = (rows) => { const t = rows.reduce((s, r) => s + r.events, 0) || 1; return rows.map((r) => ({ ...r, share: r.events / t })); };
  // Over-representation vs the whole app (needs the overview's breakdowns).
  const lift = (issueRows, appRows, label, keyFn = (n) => n) => {
    if (!appRows?.length || !issueRows.length) return;
    const app = new Map();
    for (const r of shareRows(appRows)) app.set(keyFn(r.name), (app.get(keyFn(r.name)) || 0) + r.share);
    const iss = new Map();
    for (const r of shareRows(issueRows)) iss.set(keyFn(r.name), (iss.get(keyFn(r.name)) || 0) + r.share);
    const top = [...iss].map(([k, s]) => ({ k, s, a: app.get(k) || 0 })).filter((x) => x.a > 0)
      .map((x) => ({ ...x, lift: x.s / x.a })).sort((a, b) => b.lift - a.lift)[0];
    if (top) out.push([label, `${top.k}: ${pct(top.s * 100)} of this issue vs ${pct(top.a * 100)} of all crashes`,
      top.lift >= 1.5 ? `<span class="badge warn">${top.lift.toFixed(1)}× over-represented</span>` : `<span class="badge">${top.lift.toFixed(1)}×</span>`]);
  };
  lift(d.os, overview?.os, "Operating system");
  lift(d.devices, overview?.devices, "Device brand", (n) => (n.split(" (")[0] || n).toLowerCase());

  const buckets = (vals, edges, labels) => {
    const c = labels.map(() => 0);
    vals.forEach((v) => { let k = edges.findIndex((e) => v < e); c[k < 0 ? labels.length - 1 : k]++; });
    return c;
  };
  const GB = 2 ** 30;
  const ram = ev.map((e) => Number(e.memory.free)).filter((x) => x > 0);
  if (ram.length) {
    const labels = ["<0.5 GB", "0.5–1 GB", "1–2 GB", "≥2 GB"], c = buckets(ram, [0.5 * GB, GB, 2 * GB], labels);
    const med = [...ram].sort((a, b) => a - b)[Math.floor(ram.length / 2)];
    out.push(["Free RAM at crash", `median ${bytes(med)} · ` + labels.map((l, k) => `${l}: ${c[k]}`).join(" · "),
      "", `<div class="buckets">${c.map((n, k) => `<i style="flex:${n || 0.001}" data-tip="${esc(labels[k])}: ${n} events"></i>`).join("")}</div>`]);
  }
  const sto = ev.map((e) => Number(e.storage.free)).filter((x) => x > 0);
  if (sto.length) {
    const med = [...sto].sort((a, b) => a - b)[Math.floor(sto.length / 2)];
    out.push(["Free storage", `median ${bytes(med)} · ${sto.filter((x) => x < GB).length} of ${sto.length} events under 1 GB`, ""]);
  }
  const bg = ev.filter((e) => e.processState && e.processState !== "FOREGROUND").length;
  out.push(["App state", `${ev.length - bg} foreground · ${bg} background`, bg / ev.length > 0.5 ? `<span class="badge warn">mostly background</span>` : ""]);
  const users = d.sampleUsers;
  if (users.length) {
    const topShare = users[0].events / ev.length;
    out.push(["User spread", `${users.length} distinct users; top user = ${pct(topShare * 100)} of events (${esc(users[0].name || users[0].id)})`,
      topShare >= 0.3 ? `<span class="badge warn">concentrated</span>` : `<span class="badge">spread</span>`]);
  }
  const hours = Array(24).fill(0);
  ev.forEach((e) => { if (e.time) hours[new Date(e.time).getHours()]++; });
  const peak = hours.indexOf(Math.max(...hours));
  out.push(["Time of day (local)", `peak ${String(peak).padStart(2, "0")}:00–${String((peak + 1) % 24).padStart(2, "0")}:00 with ${hours[peak]} of ${ev.length} events`, "",
    `<div class="buckets">${hours.map((n, h) => `<i style="flex:1;opacity:${0.15 + 0.85 * (n / (hours[peak] || 1))}" data-tip="${h}:00 — ${n} events"></i>`).join("")}</div>`]);
  const mods = ev.filter((e) => e.os.modificationState && e.os.modificationState !== "UNMODIFIED").length;
  if (mods) out.push(["Rooted / modified OS", `${mods} of ${ev.length} events`, `<span class="badge crit">check device integrity</span>`]);
  if (d.versions.length === 1) out.push(["Versions", `only seen in ${esc(d.versions[0].name)}`, `<span class="badge warn">version-specific</span>`]);
  return out.map(([k, v, badge, extra = ""]) => `<div class="clue"><div class="k">${k}</div><div>${v}</div><div>${badge}</div>${extra}</div>`).join("");
}

// --------------------------------------------------------------- AI draft
const aiState = {}; // issue id -> {loading, data, error}
function aiHtml(id) {
  const s = aiState[id] || {};
  const head = `<h2>AI root-cause draft <span class="muted small">Claude reads the stack, blamed code, breadcrumbs and your repo</span>
    <span style="display:flex;gap:6px"><button class="btn" id="copyFix" title="Copy a ready-to-paste prompt for Claude Code / any AI assistant to fix this issue">📋 Copy fix prompt</button>
    ${s.data ? `<button class="btn ghost" id="aiRun" data-refresh="1">Regenerate</button>` : ""}</span></h2>`;
  if (s.loading) {
    const p = s.progress || {};
    const pctDone = p.limit ? Math.min(100, (p.elapsed / p.limit) * 100) : 0;
    const icon = { Read: "📄", Grep: "🔎", Glob: "🗂️" };
    return head + `<div class="muted"><span class="spinner"></span>Investigating${p.elapsed != null ? ` · ${p.elapsed}s` : ""}${p.stepCount ? ` · ${p.stepCount} steps` : ""} — usually 1–3 minutes.</div>
      <div class="progress"><i style="width:${pctDone}%"></i></div>
      ${(p.steps || []).length ? `<div class="ai-steps">${p.steps.map((st) => `<div class="ai-step"><span class="muted">${st.t}s</span>
        <span>${icon[st.tool] || "•"} ${esc(st.tool)}</span><code>${esc(st.arg)}</code></div>`).join("")}</div>`
        : `<div class="small muted">Starting Claude and reading the crash evidence…</div>`}`;
  }
  if (s.error) return head + `<div class="error">${esc(s.error)}</div>
    ${s.fix ? `<div class="small" style="margin:6px 0 2px">Run this in a terminal (it opens your browser to sign in), then try again:</div>${cmdBox(s.fix)}` : ""}
    <button class="btn" id="aiRun" style="margin-top:8px">Try again</button>`;
  if (s.data) return head + `<div class="md">${markdown(s.data.markdown)}</div>
    <div class="small muted" style="margin-top:8px">Generated ${esc(dt(s.data.at * 1000))} in ${s.data.seconds}s${s.data.turns ? ` · ${s.data.turns} turns` : ""}${s.data.model ? ` · ${esc(s.data.model)}` : ""} · a draft to verify, not a verdict.</div>`;
  return head + `<div class="small muted" style="margin-bottom:8px">Sends the issue summary, stack traces, blamed source and breadcrumbs (user and company IDs stripped) to Claude via your local <code>claude</code> CLI. It can read and search the repo, but not edit or run anything.</div>
    <button class="btn" id="aiRun">Draft root cause</button>`;
}
async function runAi(d, refresh) {
  aiState[d.id] = { loading: true };
  redrawAi(d);
  try {
    let st = await post("/api/issue/analyze", { ...filterParams(), id: d.id, refresh: !!refresh });
    // Background job: poll until it finishes (the server enforces the time limit).
    while (st.status === "running") {
      aiState[d.id] = { loading: true, progress: st };
      redrawAi(d);
      await new Promise((r) => setTimeout(r, 2000));
      st = await api("/api/issue/analyze", { app: F.app, id: d.id });
    }
    if (st.status === "done") aiState[d.id] = { data: st };
    else aiState[d.id] = { error: st.error || "The AI run stopped without an answer.", fix: st.fix };
  } catch (e) { aiState[d.id] = { error: e.message, fix: e.fix }; }
  redrawAi(d);
}
function redrawAi(d) {
  const el = $("#aiCard");
  if (!el || issue?.id !== d.id) return;
  el.innerHTML = aiHtml(d.id);
  $("#aiRun")?.addEventListener("click", (e) => runAi(d, e.target.dataset.refresh));
  $("#copyFix")?.addEventListener("click", (e) => {
    const btn = e.currentTarget;
    navigator.clipboard.writeText(fixPrompt(d))
      .then(() => { btn.textContent = "✓ Copied"; setTimeout(() => (btn.textContent = "📋 Copy fix prompt"), 2000); })
      .catch(() => alert("Clipboard unavailable."));
  });
}

// Prompt to paste into Claude Code (run from the fa_flutter_gt repo) to fix the
// issue. IDs of users/companies and tokens are left out on purpose.
function fixPrompt(d) {
  const i = d.issue || {}, src = d.source, b = d.blame || {}, gb = d.gitBlame;
  const listed = overview?.issues?.find((x) => x.id === d.id);
  const stacks = [...new Set(d.events.map((e) => e.exceptions).filter(Boolean))].slice(0, 3);
  const crumbs = (d.events.find((e) => e.breadcrumbs)?.breadcrumbs || "")
    .replace(/\b(user(?:_?id|_?name)?|company(?:_id)?|bearer|token)\b\s*[:=]\s*[^,}\s]+/gi, "$1: [redacted]").slice(0, 1500);
  const pattern = patternOf(i.subtitle);
  const siblings = (overview?.issues || []).filter((x) => x.id !== d.id && x.state === "OPEN" && patternOf(x.subtitle) === pattern);
  const diff = diffState[d.id]?.data;
  const ai = aiState[d.id]?.data?.markdown;
  const top = (rows) => rows.slice(0, 5).map((r) => `${r.name} (${fmt(r.events)})`).join(", ");
  const rel = b.file ? b.file.replace(/^package:fa_flutter_gt\//, "lib/") : "";
  return [
    `Fix this production crash in fa_flutter_gt (Firebase Crashlytics, app ${$("#appName").textContent}).`,
    "",
    "## Crash",
    `- Issue: ${i.title}`,
    `- Exception: ${i.subtitle}`,
    `- Type: ${i.errorType} · first seen ${i.firstSeenVersion} · last seen ${i.lastSeenVersion}`,
    `- Impact (${F.version || "all versions"}, ${rangeLabel()}): ${fmt(listed?.events ?? d.versions.reduce((s, v) => s + v.events, 0))} events${listed ? `, ${fmt(listed.impactedUsers)} users` : ""}`,
    (i.signals || []).length ? `- Signals: ${(i.signals || []).map((s) => s.description).join(" ")}` : null,
    `- Top versions: ${top(d.versions)}`,
    `- Top devices: ${top(d.devices)} · Top OS: ${top(d.os)}`,
    `- Crashlytics: ${i.uri || ""}`,
    "",
    "## Blamed code",
    b.file ? `\`${b.symbol}\` at \`${rel}:${b.line}\`${src?.rev ? ` (as shipped in ${d.shipVersion}, commit ${src.rev.slice(0, 10)}; the working tree may have moved)` : ""}` : "No app frame blamed.",
    src ? "```dart\n" + src.lines.map((l, k) => `${src.start + k === src.line ? ">>" : "  "} ${src.start + k}: ${l}`).join("\n") + "\n```" : null,
    gb ? `Last change to that line: ${gb.sha.slice(0, 10)} by ${gb.author} on ${gb.date.slice(0, 10)}: "${gb.summary}"` : null,
    diff ? (diff.commits.length
      ? `Commits touching this file between ${diff.base} and ${diff.to}:\n${diff.commits.map((c) => `- ${c.sha} ${c.subject}`).join("\n")}`
      : `No commits touched this file between ${diff.base} and ${diff.to}; the trigger is likely a caller or data change.`) : null,
    "",
    "",
    "## Stack traces (distinct variants)",
    ...stacks.map((s) => "```\n" + s + "\n```"),
    crumbs ? "\n## Breadcrumbs before the crash\n```\n" + crumbs + "\n```" : null,
    siblings.length ? [
      "\n## Same error elsewhere (fix the pattern once)",
      `These open issues throw the same error ("${pattern}"):`,
      ...siblings.slice(0, 12).map((x) => `- ${x.title} (${fmt(x.events)} events)`),
    ].join("\n") : null,
    ai ? "\n## Earlier AI root-cause draft (verify, don't trust blindly)\n" + ai : null,
    "",
    "## What to do",
    "1. Read the blamed file and its callers; confirm the root cause from the code, not just the stack.",
    "2. Fix the root cause with the smallest change, not by swallowing the error. If the same bug shape exists in the sibling issues above, fix those too, preferably with one shared helper.",
    "3. Follow CLAUDE.md conventions: close every Subject in dispose(), no setState for bloc state, AppColors/AppTexts for any UI change, Mockito-only tests.",
    "4. Add or update unit tests that fail before the fix and pass after (test/ mirrors lib/).",
    "5. Run `fvm flutter analyze` and the affected tests, then summarise the cause, the fix, and the files changed.",
  ].filter((l) => l != null).join("\n");
}

// Minimal markdown: headings, fenced code, lists, inline code/bold, paragraphs.
function markdown(src) {
  const blocks = [], lines = esc(src).split("\n");
  let i = 0;
  const inline = (s) => s.replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith("```")) {
      const code = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) code.push(lines[i]);
      i++;
      blocks.push(`<pre><code>${code.join("\n")}</code></pre>`);
    } else if (/^#{1,4} /.test(l)) {
      blocks.push(`<h3>${inline(l.replace(/^#+ /, ""))}</h3>`); i++;
    } else if (/^\s*([-*]|\d+\.) /.test(l)) {
      const items = [];
      for (; i < lines.length && /^\s*([-*]|\d+\.) /.test(lines[i]); i++) items.push(`<li>${inline(lines[i].replace(/^\s*([-*]|\d+\.) /, ""))}</li>`);
      blocks.push(`<ul>${items.join("")}</ul>`);
    } else if (l.trim()) {
      const para = [];
      for (; i < lines.length && lines[i].trim() && !/^(```|#{1,4} |\s*([-*]|\d+\.) )/.test(lines[i]); i++) para.push(lines[i]);
      blocks.push(`<p>${inline(para.join(" "))}</p>`);
    } else i++;
  }
  return blocks.join("");
}

async function resumeAi(d) {
  // Pick up a draft that finished, or is still running, from an earlier visit.
  try {
    const st = await api("/api/issue/analyze", { app: F.app, id: d.id });
    if (st.status === "done") { aiState[d.id] = { data: st }; redrawAi(d); }
    else if (st.status === "running") runAi(d);
  } catch { /* idle: leave the button */ }
}

function bindIssueExtras(d) {
  if (!aiState[d.id]) resumeAi(d);
  redrawAi(d);
  if (!diffState[d.id] && isLocalFrame(d)) loadDiff(d);
  else redrawDiff(d);
}

function eventDetails(e) {
  const keys = e.customKeys && typeof e.customKeys === "object" ? e.customKeys : {};
  const mem = e.memory, sto = e.storage;
  return `<dl class="kv">
    <dt>Time</dt><dd>${esc(dt(e.time))} <span class="muted">(received ${esc(dt(e.received))})</span></dd>
    <dt>Device</dt><dd>${esc(e.device.displayName)} · ${esc(e.device.architecture || "")} · ${esc(e.device.formFactor || "")}</dd>
    <dt>OS</dt><dd>Android ${esc(e.os.displayVersion)} ${e.os.modificationState && e.os.modificationState !== "UNMODIFIED" ? `<span class="badge crit">${esc(e.os.modificationState)}</span>` : ""}</dd>
    <dt>App</dt><dd>${esc(e.version)} · ${esc(e.processState || "")} · ${esc(e.orientation || "")}</dd>
    <dt>RAM</dt><dd>${bytes(mem.used)} used · ${bytes(mem.free)} free</dd>
    <dt>Storage</dt><dd>${bytes(sto.used)} used · ${bytes(sto.free)} free</dd>
    ${Object.entries(keys).map(([k, v]) => `<dt>${esc(k)}</dt><dd class="mono small">${esc(v)}</dd>`).join("")}
  </dl>
  ${e.breadcrumbs ? `<details open><summary>Breadcrumbs</summary><pre class="stack">${esc(e.breadcrumbs)}</pre></details>` : ""}
  ${e.logs ? `<details><summary>Logs</summary><pre class="stack">${esc(e.logs)}</pre></details>` : ""}`;
}

function dimTable(title, rows) {
  const total = rows.reduce((s, r) => s + r.events, 0) || 1;
  return `<div class="card"><h2>${title}</h2><div class="scroll"><table>
    <thead><tr><th>Name</th><th class="num">Events</th><th class="num">Users</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td>${esc(r.name)}<div class="share"><i style="width:${(r.events / total) * 100}%"></i></div></td>
      <td class="num">${fmt(r.events)}</td><td class="num">${fmt(r.impactedUsers)}</td></tr>`).join("") ||
      `<tr><td colspan="3" class="muted">–</td></tr>`}</tbody></table></div></div>`;
}

async function changeState(state, btn) {
  const label = { CLOSED: "close", MUTED: "mute", OPEN: "reopen" }[state];
  if (!confirm(`This will ${label} the issue in Firebase Crashlytics for everyone. Continue?`)) return;
  btn.disabled = true;
  try {
    await post("/api/issue/state", { id: issue.id, state });
    overview = null;
    await renderIssue(issue.id);
  } catch (e) { alert(e.message); btn.disabled = false; }
}

async function addNote() {
  const text = $("#noteText").value.trim();
  if (!text || !confirm("Save this note to the issue in Firebase?")) return;
  $("#addNote").disabled = true;
  try { await post("/api/issue/note", { id: issue.id, note: text }); delete noteDrafts[issue.id]; await renderIssue(issue.id); }
  catch (e) { alert(e.message); $("#addNote").disabled = false; }
}

function copyTicket() {
  const d = issue, i = d.issue || {}, ev = d.events[0];
  const listed = overview?.issues?.find((x) => x.id === d.id);
  const md = [
    `## ${shortTitle(i.title)}`, "", `**${i.subtitle || ""}**`, "",
    `- Type: ${i.errorType} · State: ${i.state}`,
    `- Events: ${fmt(listed?.events)} · Users: ${fmt(listed?.impactedUsers)} (${F.version || "all versions"}, ${rangeLabel()})`,
    `- Seen: ${i.firstSeenVersion} → ${i.lastSeenVersion}`,
    `- Top versions: ${d.versions.slice(0, 3).map((v) => `${v.name} (${fmt(v.events)})`).join(", ")}`,
    `- Top devices: ${d.devices.slice(0, 3).map((v) => `${v.name} (${fmt(v.events)})`).join(", ")}`,
    d.blame?.file ? `- Blamed: \`${d.blame.symbol}\` at \`${d.blame.file}:${d.blame.line}\`` : "",
    `- Crashlytics: ${i.uri || ""}`, "", "```", ev?.exceptions || "", "```",
  ].filter((l) => l !== "").join("\n");
  navigator.clipboard.writeText(md).then(() => { $("#copyMd").textContent = "Copied ✓"; });
}

// ------------------------------------------------------------------ users
// Crashlytics has no per-user query; the server samples the latest 100
// events of the top open issues and indexes them by user.
let usersData = null, usersTimer = null, usersSel = null;
async function renderUsers(silent) {
  if (!silent || !$("#userQ")) {
    view.innerHTML = `<div class="card"><h2>Find a field user <span class="muted small">by user ID, name or company ID</span></h2>
      <div class="toolbar"><input type="search" id="userQ" placeholder="e.g. 13086246, Rambabu, 193054" value="${esc(ui.userQ || "")}"></div>
      <div id="userRes"><div class="loading">Loading…</div></div></div>`;
    let t;
    $("#userQ").addEventListener("input", (e) => {
      ui.userQ = e.target.value; store.set("ui", ui);
      clearTimeout(t); t = setTimeout(() => loadUsers(), 300);
    });
  }
  await loadUsers();
}
async function loadUsers() {
  clearTimeout(usersTimer);
  const r = await api("/api/users", { ...filterParams(), q: ui.userQ || "" });
  if (!$("#userRes")) return;
  usersData = r;
  drawUsers();
  // Keep polling while a build runs; results fill in as each issue's events land.
  if (r.building) usersTimer = setTimeout(loadUsers, 4000);
}
function drawUsers() {
  const r = usersData;
  const pctDone = r.total ? (r.done / r.total) * 100 : 0;
  const status = r.building
    ? `<div class="small muted"><span class="spinner"></span>${r.partial
        ? `Building the user index: ${r.done}/${r.total} issues read, results fill in as they arrive (first build takes a few minutes).`
        : `Refreshing in the background (${r.done}/${r.total}); showing the index from ${esc(dt(r.builtAt * 1000))}.`}</div>
       <div class="progress"><i style="width:${pctDone}%"></i></div>` : "";
  const tr = r.truncated || [];
  const gap = tr.length ? `<div class="badge warn" style="display:block;white-space:normal;padding:8px 10px;margin:8px 0">
      ⚠ ${tr.length} busy issue${tr.length > 1 ? "s" : ""}: the latest 100 events only reach back to
      <b>${esc(dt(tr[0].since))}</b>${tr.length > 1 ? " (or later)" : ""}, so a user's earlier crashes there aren't in this sample.
      To find a specific incident, set <b>Range → Custom range…</b> to a few minutes around it.
      <details style="margin-top:4px"><summary>Which issues</summary>${tr.map((t) => `<div class="small">${esc(shortTitle(t.title))}: since ${esc(dt(t.since))}</div>`).join("")}</details></div>` : "";
  $("#userRes").innerHTML = `${status}${gap}<div class="small muted" style="margin-bottom:8px">Crashes, non-fatals and ANRs · ${esc(rangeLabel())} · ${fmt(r.matches)} users match · sample of
    ${fmt(r.sampledEvents)} events from ${r.sampledIssues} open issues (latest 100 each)${r.builtAt ? ` · built ${esc(dt(r.builtAt * 1000))}` : ""}
    · counts are a sample, not totals</div>
    <div class="scroll"><table><thead><tr><th>User</th><th>Company</th><th class="num">Events</th><th class="num">Issues</th>
      <th>Devices</th><th>Versions</th><th>Last crash</th></tr></thead><tbody>
    ${r.users.map((u) => `<tr class="click ${usersSel === u.id ? "active" : ""}" data-user="${esc(u.id)}">
      <td>${esc(u.name || "–")}<div class="t-sub">${esc(u.id)}</div></td><td>${esc(u.company || "–")}</td>
      <td class="num">${u.events}</td><td class="num">${u.issues.length}</td>
      <td class="small">${esc(u.devices.join(", "))}</td><td class="small">${esc(u.versions.join(", "))}</td>
      <td class="small">${esc(dt(u.recent[0]?.time))}</td></tr>
      ${usersSel === u.id ? `<tr><td colspan="7">${userDetail(u)}</td></tr>` : ""}`).join("") ||
      `<tr><td colspan="7" class="muted">${r.building && !r.sampledEvents ? "Reading the first issues…" : "No user in the sample matches."}</td></tr>`}
    </tbody></table></div>`;
  $("#userRes").querySelectorAll("[data-user]").forEach((tr) => tr.addEventListener("click", () => {
    usersSel = usersSel === tr.dataset.user ? null : tr.dataset.user; drawUsers();
  }));
}
function userDetail(u) {
  return `<div class="grid g-2" style="margin:6px 0">
    <div><div class="small muted" style="margin-bottom:4px">Issues this user hits</div>
      ${u.issues.map((i) => `<div class="commit" style="grid-template-columns:40px 1fr 150px"><b>${i.events}×</b>
        <span><a href="#/issue/${esc(i.id)}">${esc(shortTitle(i.title))}</a>${i.detail ? `<div class="t-sub">${esc(i.detail)}</div>` : ""}</span><span class="muted">${esc(dt(i.last))}</span></div>`).join("")}</div>
    <div><div class="small muted" style="margin-bottom:4px">Recent crashes</div>
      ${u.recent.slice(0, 15).map((e) => `<div class="commit" style="grid-template-columns:80px 1fr 150px">
        <span class="muted">${esc(dt(e.time))}</span><a href="#/issue/${esc(e.issueId)}">${esc(shortTitle(e.title))}</a>
        <span class="small muted">${esc(e.version)} · A${esc(e.os)} · ${bytes(e.memFree)} free</span></div>`).join("")}</div>
  </div>`;
}

// ----------------------------------------------------------------- alerts
// Runs on its own timer, whatever page is open and even when the tab is in the
// background. Compares each check with the last one stored in localStorage.
const alertCfg = Object.assign({ on: false, spike: "" }, store.get("alerts", {}));
let alertTimer = null, alertInfo = {}, unread = 0;
const baseTitle = document.title;

const alertKey = () => "seen." + JSON.stringify([F.app, F.version, F.type, rangeParams()]);

async function alertCheck() {
  if (!alertCfg.on) return;
  try {
    const p = { type: F.type, ...rangeParams(), ...(F.app ? { app: F.app } : {}), ...(F.version ? { version: F.version } : {}) };
    const [ov, nr] = await Promise.all([api("/api/overview", p), api("/api/new-in-release", p).catch(() => null)]);
    const capped = ov.issues.length >= 100; // top-100 list: issues can enter from below
    const cur = {
      counts: Object.fromEntries(ov.issues.map((i) => [i.id, i.events])),
      newRel: (nr?.issues || []).map((i) => i.id),
      regressed: ov.issues.filter((i) => i.signals.some((s) => s.signal === "SIGNAL_REGRESSED")).map((i) => i.id),
    };
    const prev = store.get(alertKey(), null);
    // Every id ever seen for this filter, so an issue dropping out of and back
    // into the top list doesn't alert twice.
    cur.ever = [...new Set([...(prev?.ever || []), ...Object.keys(cur.counts), ...cur.newRel])].slice(-2000);
    if (prev) {
      const byId = new Map([...ov.issues, ...(nr?.issues || [])].map((i) => [i.id, i]));
      const ever = new Set(prev.ever || Object.keys(prev.counts));
      const out = new Map(); // id -> [label, detail]
      for (const id of cur.newRel) if (!prev.newRel.includes(id)) out.set(id, [`🆕 New crash in ${nr.release}`, "never seen in earlier versions"]);
      for (const id of Object.keys(cur.counts)) if (!ever.has(id) && !out.has(id))
        out.set(id, capped ? ["Entered top issues", ""] : ["New crash issue", ""]);
      for (const id of cur.regressed) if (!prev.regressed.includes(id) && !out.has(id)) out.set(id, ["♻️ Regressed", "came back after being closed"]);
      const n = Number(alertCfg.spike);
      if (n > 0) for (const [id, c] of Object.entries(cur.counts)) {
        const gained = c - (prev.counts[id] ?? c);
        if (gained >= n && !out.has(id)) out.set(id, [`📈 +${fmt(gained)} events`, "since the last check"]);
      }
      fireAlerts([...out].map(([id, [label, detail]]) => ({ id, label, detail, issue: byId.get(id) })).filter((a) => a.issue));
    }
    store.set(alertKey(), cur);
    alertInfo = { at: Date.now(), watching: Object.keys(cur.counts).length, baseline: !prev, error: null };
  } catch (e) {
    alertInfo = { ...alertInfo, error: e.message };
  }
  drawAlertPanel();
}

function fireAlerts(list) {
  if (!list.length) return;
  const os = "Notification" in window && Notification.permission === "granted";
  for (const a of list.slice(0, 5)) {
    const title = `${a.label} · ${F.version || "all versions"}`;
    const body = `${shortTitle(a.issue.title)}\n${a.issue.subtitle.replace("io.flutter.plugins.firebase.crashlytics.FlutterError - ", "")}`.slice(0, 220);
    if (os) {
      const n = new Notification(title, { body, tag: a.id + a.label, requireInteraction: false });
      n.onclick = () => { focus(); location.hash = `#/issue/${a.id}`; n.close(); };
    }
    toast(title, `${a.detail ? a.detail + " — " : ""}${body}`, `#/issue/${a.id}`);
  }
  if (list.length > 5) toast(`+${list.length - 5} more alerts`, "Open the overview to see them all.", "#/");
  if (document.hidden) { unread += list.length; document.title = `(${unread}) ${baseTitle}`; }
}

function toast(title, body, href) {
  let box = $("#toasts");
  if (!box) { box = document.createElement("div"); box.id = "toasts"; document.body.append(box); }
  const t = document.createElement("a");
  t.className = "toast";
  t.href = href;
  t.innerHTML = `<b>${esc(title)}</b><span>${esc(body)}</span><button aria-label="Dismiss">✕</button>`;
  t.querySelector("button").addEventListener("click", (e) => { e.preventDefault(); t.remove(); });
  box.prepend(t);
  setTimeout(() => t.remove(), 60_000);
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) { unread = 0; document.title = baseTitle; }
});

function scheduleAlerts() {
  clearInterval(alertTimer);
  if (alertCfg.on) { alertCheck(); alertTimer = setInterval(alertCheck, POLL_MS); }
}

function permissionText() {
  if (!("Notification" in window)) return ["This browser has no desktop notifications; you'll get in-page alerts only.", "warn"];
  const p = Notification.permission;
  if (p === "granted") return ["Desktop notifications allowed. Nothing showing? Check macOS System Settings › Notifications › your browser, and Focus mode.", "good"];
  if (p === "denied") return ["Desktop notifications are blocked for this site (or this browser, e.g. the Claude app pane). Allow them in the browser's site settings (lock icon › Notifications). In-page alerts still work.", "crit"];
  return ["Desktop notifications not yet allowed; turning alerts on will ask.", "warn"];
}

function drawAlertPanel() {
  $("#notify").textContent = alertCfg.on ? "🔔 Alerts on" : "🔕 Alerts off";
  const el = $("#alertPanel");
  if (!el || el.hidden) return;
  const [ptext, pcls] = permissionText();
  const i = alertInfo;
  el.innerHTML = `
    <label class="toggle"><input type="checkbox" id="alOn" ${alertCfg.on ? "checked" : ""}> <b>Alerts on</b></label>
    <div class="small" style="margin:6px 0">Alerts when a check finds: a crash <b>new in the release</b>, a <b>new issue</b>, a <b>regressed</b> issue${Number(alertCfg.spike) > 0 ? `, or an issue gaining ≥ ${fmt(alertCfg.spike)} events` : ""}.
      Checks every minute on any page, even in a background tab, for ${esc(F.version || "all versions")} · ${esc(F.type)} · ${esc(rangeLabel())}.</div>
    <label class="small">Also alert when an issue gains at least
      <input type="number" id="alSpike" min="1" placeholder="off" value="${esc(alertCfg.spike)}" style="width:80px;min-width:0"> events between checks</label>
    <div class="badge ${pcls}" style="white-space:normal;display:block;margin:8px 0;padding:6px 8px">${esc(ptext)}</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap">
      <button class="btn" id="alTest">Send test alert</button>
      ${"Notification" in window && Notification.permission === "default" ? `<button class="btn" id="alAsk">Allow desktop notifications</button>` : ""}
    </div>
    <div class="small muted" style="margin-top:8px">${i.error ? `<span style="color:var(--crit)">Last check failed: ${esc(i.error)}</span>`
      : i.at ? `Last check ${esc(new Date(i.at).toLocaleTimeString())} · watching ${fmt(i.watching)} issues${i.baseline ? " · first check saved as baseline (alerts start from the next one)" : ""}`
      : alertCfg.on ? "First check running…" : "Off."}</div>`;
  $("#alOn").addEventListener("change", async (e) => {
    alertCfg.on = e.target.checked;
    if (alertCfg.on && "Notification" in window && Notification.permission === "default") await Notification.requestPermission();
    store.set("alerts", alertCfg); scheduleAlerts(); drawAlertPanel();
  });
  $("#alSpike").addEventListener("change", (e) => { alertCfg.spike = e.target.value; store.set("alerts", alertCfg); drawAlertPanel(); });
  $("#alTest").addEventListener("click", () => {
    const sample = overview?.issues?.[0] || { id: "", title: "Test issue", subtitle: "This is a test alert." };
    fireAlerts([{ id: sample.id, label: "🔔 Test alert", detail: "if you see this, alerts work", issue: sample }]);
  });
  $("#alAsk")?.addEventListener("click", async () => { await Notification.requestPermission(); drawAlertPanel(); });
}

$("#notify").addEventListener("click", (e) => {
  e.stopPropagation();
  const el = $("#alertPanel");
  el.hidden = !el.hidden;
  drawAlertPanel();
});
document.addEventListener("click", (e) => {
  const el = $("#alertPanel");
  if (el && !el.hidden && !el.contains(e.target)) el.hidden = true;
});

// ------------------------------------------------------------------ setup
// Onboarding page for other developers: live requirement checks drawn on an
// animated connection diagram, plus copyable install steps.
let setupData = null, setupBusy = false;

const FLOW = [ // id, label, sub, x, y (check id drives the colour)
  ["browser", "Your browser", "you are here", 20, 40],
  ["server", "Dashboard server", "", 260, 40],
  ["mcp", "Firebase MCP", "npx firebase-tools mcp", 500, 40],
  ["crashlytics", "Crashlytics API", "", 740, 40],
  ["repo", "fa_flutter_gt repo", "source · blame · diffs", 170, 172],
  ["claude", "Claude CLI", "AI drafts (optional)", 390, 172],
];
const WIRES = [["browser", "server", "M190,67 H260"], ["server", "mcp", "M430,67 H500"],
  ["mcp", "crashlytics", "M670,67 H740"], ["server", "repo", "M330,94 C330,135 255,130 255,172"],
  ["server", "claude", "M360,94 C360,135 475,130 475,172"]];

function nodeState(id) {
  if (id === "browser") return "ok";
  if (!setupData) return "wait";
  if (id === "server") return "ok";
  const c = setupData.checks.find((x) => x.id === id);
  return c ? (c.ok ? "ok" : "bad") : "wait";
}

function flowSvg() {
  const sub = { server: setupData ? `localhost:${setupData.port}` : "localhost", crashlytics: setupData?.project || "project" };
  return `<svg class="flow" viewBox="0 0 920 240" role="img" aria-label="Connection diagram">
    ${WIRES.map(([a, b, d], k) => {
      const sa = nodeState(a), sb = nodeState(b);
      const cls = sa === "ok" && sb === "ok" ? "live" : sb === "bad" ? "bad" : "";
      return `<path id="w${k}" class="wire ${cls}" d="${d}"/>` + (cls === "live"
        ? `<circle class="packet" r="4"><animateMotion dur="${1.6 + k * 0.25}s" repeatCount="indefinite"><mpath href="#w${k}"/></animateMotion></circle>` : "");
    }).join("")}
    ${FLOW.map(([id, label, s, x, y]) => `<g class="node ${nodeState(id)}" transform="translate(${x},${y})">
      <rect width="170" height="54" rx="12"/>
      <text x="14" y="23">${nodeState(id) === "ok" ? "✓ " : nodeState(id) === "bad" ? "✕ " : ""}${esc(label)}</text>
      <text class="sub" x="14" y="41">${esc(sub[id] || s)}</text></g>`).join("")}
  </svg>`;
}

const ICON_OK = `<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;
const ICON_BAD = `<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg>`;
const cmdBox = (cmd) => `<div class="cmd"><code>${esc(cmd)}</code><button class="btn" data-copy="${esc(cmd)}">Copy</button></div>`;

function checksHtml() {
  if (!setupData) return [1, 2, 3, 4, 5, 6].map(() => `<div class="check"><div class="ic"><span class="spinner" style="margin:0"></span></div>
    <div><div class="skel" style="height:14px;width:45%"></div><div class="skel" style="height:11px;width:70%;margin-top:6px"></div></div></div>`).join("");
  return setupData.checks.map((c) => `<div class="check ${c.ok ? "ok" : "bad"} ${c.optional ? "opt" : ""}">
    <div class="ic">${c.ok ? ICON_OK : ICON_BAD}</div>
    <div><div class="lbl">${esc(c.label)} ${c.optional ? `<span class="badge">optional</span>` : ""}</div>
      <div class="small muted">${esc(c.detail || "")}</div>
      ${!c.ok && c.fix ? cmdBox(c.fix) : ""}</div></div>`).join("");
}

function readyHtml() {
  const req = setupData ? setupData.checks.filter((c) => !c.optional) : [];
  const done = req.filter((c) => c.ok).length, total = req.length || 4;
  const C = 2 * Math.PI * 24, all = setupData && done === total;
  return `<div class="ready"><svg class="ring" viewBox="0 0 56 56"><circle class="bg" cx="28" cy="28" r="24"/>
      <circle class="fg" cx="28" cy="28" r="24" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - done / total)}"/></svg>
    <div><div style="font-weight:700;font-size:16px">${setupData ? `${done} of ${total} required checks pass` : "Checking your setup…"}</div>
      <div class="small muted">${all ? "You're connected. Optional items add source, blame and AI drafts." : setupData ? "Fix the red items below, then re-check." : "Starting the Firebase MCP can take ~20s the first time."}</div></div>
    <span style="flex:1"></span>
    <a class="btn" href="#/welcome">✨ Setup wizard</a>
    <button class="btn" id="recheck" ${setupBusy ? "disabled" : ""}>${setupBusy ? `<span class="spinner"></span>Checking…` : "↻ Re-check"}</button>
    ${all ? `<a class="cta" href="#/">Open dashboard →</a>` : ""}</div>`;
}

function drawSetup() {
  if (!$("#setupFlow")) return;
  $("#setupFlow").innerHTML = flowSvg();
  $("#setupReady").innerHTML = readyHtml();
  $("#setupChecks").innerHTML = checksHtml();
  $("#recheck")?.addEventListener("click", () => runSetup());
}

async function runSetup() {
  setupBusy = true; setupData = null; drawSetup();
  try {
    setupData = await api("/api/setup");
    if (setupData.checks.filter((c) => !c.optional).every((c) => c.ok)) store.set("setupDone", true);
  } catch (e) {
    setupData = { checks: [{ id: "server", label: "Dashboard server", ok: false, detail: e.message,
      fix: "cd crashlytics-dashboard && ./start.sh" }], project: "", port: location.port };
  }
  setupBusy = false; drawSetup();
}

function renderSetup(silent) {
  if (silent && $("#setupFlow")) return; // live refresh: don't re-run checks every minute
  const project = setupData?.project || "general-trade---hccb";
  const mcpJson = JSON.stringify({ mcpServers: { firebase: { command: "npx", args: ["-y", "firebase-tools@latest", "mcp", "--only", "crashlytics"] } } }, null, 2);
  view.innerHTML = `
    <section class="hero">
      <div class="orb" style="width:220px;height:220px;background:var(--accent);right:-40px;top:-60px"></div>
      <div class="orb" style="width:180px;height:180px;background:var(--good);left:30%;bottom:-90px;animation-delay:-4s"></div>
      <h1>Connect to Crashlytics Live</h1>
      <p>Everything runs on your machine with <b>your own</b> Google sign-in. The dashboard talks to Crashlytics through the Firebase MCP server, and reads your local <code>fa_flutter_gt</code> checkout for source, blame and release diffs. Nothing is uploaded or shared.</p>
      <div id="setupReady"></div>
    </section>

    <div class="card" style="margin-bottom:14px"><h2>How it connects <span class="muted small">live status of each link</span></h2>
      <div id="setupFlow" class="scroll"></div></div>

    <div class="grid g-2">
      <div class="card"><h2>Your checks</h2><div id="setupChecks"></div></div>
      <div class="card"><h2>New developer setup <span class="muted small">≈ 5 minutes</span></h2>
        <div class="steps">
          <div class="step"><h3>Install the tools</h3><p>Node.js 20+ runs the Firebase MCP; <code>uv</code> runs the dashboard server (it installs its own Python deps).</p>
            ${cmdBox("brew install node uv")}</div>
          <div class="step"><h3>Sign in to Firebase</h3><p>Use your work Google account. The MCP reuses this login.</p>
            ${cmdBox("npx -y firebase-tools@latest login")}</div>
          <div class="step"><h3>Get Crashlytics access</h3><p>Ask a Firebase admin to add your Google account to <code>${esc(project)}</code> with at least the <b>Firebase Crashlytics Viewer</b> role (Owner/Editor also work).</p></div>
          <div class="step"><h3>Start the dashboard</h3><p>From the <code>crashlytics-dashboard</code> folder. The setup wizard asks for your <code>fa_flutter_gt</code> path and remembers it.</p>
            ${cmdBox("./start.sh")}</div>
          <div class="step"><h3>Optional: AI root-cause drafts</h3><p>Install Claude Code and sign in once; the dashboard calls it read-only.</p>
            ${cmdBox("npm install -g @anthropic-ai/claude-code && claude")}</div>
          <div class="step"><h3>Optional: Crashlytics in your own Claude Code</h3><p>Same MCP server, available in any Claude Code session:</p>
            ${cmdBox("claude mcp add firebase -- npx -y firebase-tools@latest mcp --only crashlytics")}
            <details><summary>…or add it to a project's <code>.mcp.json</code></summary><div class="cmd"><code>${esc(mcpJson)}</code><button class="btn" data-copy="${esc(mcpJson)}">Copy</button></div></details></div>
        </div></div>
    </div>`;
  drawSetup();
  if (!setupData && !setupBusy) runSetup();
}

document.addEventListener("click", (e) => {
  const b = e.target.closest?.("[data-copy]");
  if (!b) return;
  navigator.clipboard.writeText(b.dataset.copy).then(() => {
    const t = b.textContent; b.textContent = "✓ Copied"; setTimeout(() => (b.textContent = t), 1500);
  });
});

// Skeleton shown while the first Crashlytics fetch is in flight.
function skeleton(msg) {
  const box = (h) => `<div class="skel" style="height:${h}px"></div>`;
  return `<div class="skel-grid g-tiles grid" style="margin-bottom:14px">${box(92).repeat(6)}</div>
    <div class="grid g-2">${box(200)}${box(200)}</div>${box(320)}<div class="skel-msg">${esc(msg)}</div>`;
}

// Count KPI numbers up from 0 on a full (non-live) render.
function countUp(root) {
  root.querySelectorAll(".tile .val").forEach((el) => {
    const m = el.textContent.match(/^([\d,]+(?:\.\d+)?)(%?)$/);
    if (!m) return;
    const end = parseFloat(m[1].replace(/,/g, "")), dec = (m[1].split(".")[1] || "").length, t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / 800), v = end * (1 - Math.pow(1 - k, 3));
      el.textContent = (dec ? v.toFixed(dec) : Math.round(v).toLocaleString()) + m[2];
      if (k < 1) requestAnimationFrame(step);
    };
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) requestAnimationFrame(step);
  });
}

// ----------------------------------------------------------------- router
let routing = null;
async function route(silent = false) {
  const m = location.hash.match(/^#\/issue\/([0-9a-f]+)/);
  const usersPage = /^#\/users/.test(location.hash);
  const setupPage = /^#\/setup/.test(location.hash);
  const welcomePage = /^#\/welcome/.test(location.hash);
  // Until setup is finished, the wizard is the only page: no tabs, no back door.
  if (!welcomePage && !store.get("setupDone", false)) return location.replace("#/welcome");
  document.body.classList.toggle("wizard-mode", welcomePage);
  document.querySelectorAll(".tabs a").forEach((a) => a.classList.toggle("on",
    a.dataset.tab === (setupPage ? "setup" : usersPage ? "users" : m || welcomePage ? "" : "overview")));
  view.classList.toggle("anim", !silent);
  document.querySelector(".filters").hidden = setupPage || welcomePage;
  const run = (async () => {
    setStatus(silent ? "Refreshing…" : "Loading…", lastOk ? "on" : "");
    try {
      if (welcomePage) {
        if (!silent) renderWelcome();
      } else if (setupPage) {
        renderSetup(silent);
      } else if (m) {
        if (!overview && !silent) api("/api/overview", filterParams()).then((o) => { overview = o; }).catch(() => {});
        await renderIssue(m[1], silent);
      } else if (usersPage) {
        await renderUsers(silent);
      } else {
        await renderOverview(silent);
      }
      lastOk = Date.now();
      setStatus(`Updated ${new Date().toLocaleTimeString()}`, $("#live").checked ? "on" : "");
    } catch (e) {
      setStatus("Fetch failed", "err");
      if (!silent || !view.innerHTML.includes("card")) view.innerHTML = `<div class="error">${esc(e.message)}</div>
        <div class="card"><h2>Can't reach Crashlytics</h2><p class="small">Usually a missing Firebase sign-in or project access.</p>
        <a class="cta" href="#/setup">Run setup checks →</a></div>`;
      else view.insertAdjacentHTML("afterbegin", `<div class="error">Refresh failed: ${esc(e.message)}</div>`);
    }
  })();
  routing = run;
  return run;
}

function schedulePoll() {
  clearInterval(pollTimer);
  if ($("#live").checked) pollTimer = setInterval(() => { if (!document.hidden) route(true); }, POLL_MS);
}
$("#live").checked = store.get("live", true);
$("#live").addEventListener("change", (e) => { store.set("live", e.target.checked); schedulePoll(); setStatus($("#status").textContent, e.target.checked ? "on" : ""); });
$("#refresh").addEventListener("click", () => route(true));
addEventListener("hashchange", () => { scrollTo(0, 0); route(); });

(async () => {
  syncFilterInputs();
  drawAlertPanel();
  if (!store.get("setupDone", false) && (!location.hash || location.hash === "#/")) location.replace("#/welcome");
  await loadApps();
  store.set("filters", F);
  await route();
  schedulePoll();
  scheduleAlerts();
})();
