# /// script
# requires-python = ">=3.10"
# dependencies = ["pyyaml"]
# ///
"""Crashlytics dashboard backend.

Talks to Crashlytics through the Firebase MCP server (`firebase-tools mcp`),
authenticated by your `firebase login`, and serves a JSON API + static SPA.

    uv run server.py [--project general-trade---hccb] [--port 8787]
"""
import argparse, json, os, queue, re, shutil, subprocess, threading, time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import yaml

# libyaml's C parser is ~10x faster on 100-event responses.
_Base = getattr(yaml, "CSafeLoader", yaml.SafeLoader)


class _Loader(_Base):
    """Keeps numbers/dates as strings: `firstSeenVersion: 5.10` must not become
    5.1, and unquoted timestamps must stay ISO strings. Metrics are cast later."""


_DROP = {"tag:yaml.org,2002:float", "tag:yaml.org,2002:int", "tag:yaml.org,2002:timestamp"}
_Loader.yaml_implicit_resolvers = {
    ch: [(tag, rx) for tag, rx in rs if tag not in _DROP]
    for ch, rs in _Base.yaml_implicit_resolvers.items()}


def yload(text):
    return yaml.load(text, Loader=_Loader)

ROOT = Path(__file__).parent
STATIC = ROOT / "static"
# Local checkouts used to show source for `package:<name>/...` frames.
# Overridden by --repo / FA_REPO in main().
SOURCE_ROOTS = {"fa_flutter_gt": Path.home() / "office/fa_flutter_gt/lib"}
AI_TIMEOUT = 480  # s hard stop for one `claude -p` root-cause run
# Sonnet at medium effort: a focused triage, not an open-ended repo tour.
AI_MODEL = os.environ.get("CD_AI_MODEL", "sonnet")
AI_EFFORT = os.environ.get("CD_AI_EFFORT", "medium")
USER_INDEX_ISSUES = 40  # issues sampled (100 latest events each) for user search
REDACT_KEYS = re.compile(r"bearer|token|auth|password|secret", re.I)
# Free text that may look like YAML (stack traces, logs) — never re-parse.
TEXT_FIELDS = {"exceptions", "threads", "breadcrumbs", "logs", "title",
               "subtitle", "description", "body"}
POOL_SIZE = 6
INDEX_WORKERS = 3  # user-index share of the pool, so pages stay responsive
OVERVIEW_TTL = 120  # s; client polls every 60s, Crashlytics lags ~minutes anyway

args = None


# ---------------------------------------------------------------- MCP client

class Mcp:
    """One `firebase mcp` stdio process. npx startup costs ~15s, so reuse it."""

    def __init__(self):
        self.proc, self.next_id, self.gen = None, 0, -1

    def _rpc(self, method, params=None, notify=False):
        msg = {"jsonrpc": "2.0", "method": method, "params": params or {}}
        if not notify:
            self.next_id += 1
            msg["id"] = self.next_id
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()
        if notify:
            return None
        for line in self.proc.stdout:
            try:
                m = json.loads(line)
            except ValueError:
                continue
            if m.get("id") == self.next_id:
                if "error" in m:
                    raise RuntimeError(m["error"].get("message", m["error"]))
                return m["result"]
        raise RuntimeError("firebase mcp exited")

    def _ensure(self):
        if self.proc and self.proc.poll() is None and self.gen == MCP_GEN:
            return
        with _spawn_lock:  # one at a time: parallel first-run npx installs corrupt the cache
            self._start()

    def _start(self):
        if self.proc and self.proc.poll() is None:
            self.proc.kill()  # stale project/credentials from before a config change
        self.gen = MCP_GEN
        self.proc = subprocess.Popen(
            ["npx", "-y", "firebase-tools@latest", "mcp", "--only", "crashlytics"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True)
        self._rpc("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                                 "clientInfo": {"name": "crash-dash", "version": "1"}})
        self._rpc("notifications/initialized", notify=True)
        try:
            self._call("firebase_update_environment", active_project=args.project)
        except RuntimeError:
            pass  # signed out or no access yet; sign-in restarts the pool, which retries this

    def _call(self, tool, **a):
        res = self._rpc("tools/call", {"name": tool, "arguments": a})
        text = "".join(c.get("text", "") for c in res.get("content", []))
        if res.get("isError"):
            raise RuntimeError(text.strip())
        return text

    def call(self, tool, **a):
        try:
            self._ensure()
            return self._call(tool, **a)
        except (BrokenPipeError, RuntimeError) as e:
            if "exited" in str(e) or isinstance(e, BrokenPipeError):
                self.proc = None  # restart on next call
            raise


pool = queue.Queue()
_spawn_lock = threading.Lock()
MCP_GEN = 0  # bumped on project/app/sign-in change; pooled processes restart lazily


def restart_mcps():
    global MCP_GEN
    MCP_GEN += 1


def mcp(tool, **a):
    m = pool.get()
    try:
        return m.call(tool, **a)
    finally:
        pool.put(m)


def parse(text):
    """MCP replies are YAML whose nested fields are often YAML strings again."""
    def deep(v, key=None):
        if isinstance(v, str) and key not in TEXT_FIELDS and "\n" in v and ":" in v:
            try:
                p = yload(v)
                if isinstance(p, (dict, list)):
                    return deep(p)
                if isinstance(p, str):
                    return p.strip()
            except yaml.YAMLError:
                pass
        if isinstance(v, str):
            return v.strip()
        if isinstance(v, dict):
            return {k: deep(x, k) for k, x in v.items()}
        if isinstance(v, list):
            return [deep(x) for x in v]
        return v
    try:
        return deep(yload(text))
    except yaml.YAMLError:
        return text


# ------------------------------------------------------------------- caching

_cache, _cache_lock = {}, threading.Lock()


def cached(key, ttl, fn):
    now = time.time()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and (ttl is None or now - hit[0] < ttl):
            return hit[1]
    val = fn()
    with _cache_lock:
        _cache[key] = (now, val)
    return val


# ---------------------------------------------------------------- reports

def metrics(g):
    # Proto JSON drops zero fields: a missing crash-free % means 0.
    m = (g.get("metrics") or [{}])[0]
    if not m:
        return {}
    out = {"crashFreeUsers": float(m.get("crashFreeUsersPercentage", 0) or 0),
           "crashFreeSessions": float(m.get("crashFreeSessionsPercentage", 0) or 0)}
    for k in ("eventsCount", "impactedUsersCount", "sessionsCount",
              "totalUsersCount", "totalSessionsCount"):
        out[k.replace("Count", "")] = int(m.get(k, 0) or 0)
    return out


def window(days):
    now = datetime.now(timezone.utc)
    start = (now - timedelta(days=days - 1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return {"intervalStartTime": start.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "intervalEndTime": now.strftime("%Y-%m-%dT%H:%M:%SZ")}


def build_filter(q, with_window=True):
    f = {"issueErrorTypes": [q["type"]]} if q.get("type", "ALL") != "ALL" else {}
    if q.get("version"):
        f["versionDisplayNames"] = [q["version"]]
    if q.get("device"):
        f["deviceDisplayNames"] = [q["device"]]
    if q.get("os"):
        f["operatingSystemDisplayNames"] = [q["os"]]
    if q.get("signal"):
        f["issueSignals"] = [q["signal"]]
    if with_window:
        f.update(window(int(q.get("days", 7))))
    return f


def report(app, name, flt, page=50):
    doc = parse(mcp("crashlytics_get_report", appId=app, report=name,
                    filter=flt, pageSize=page))
    return doc.get("groups") or [] if isinstance(doc, dict) else []


def dim_rows(groups, key):
    # topVersions also lists versions with only sessions; keep ones with events.
    rows = [{"name": (g.get(key) or {}).get("displayName", "?"), **metrics(g)}
            for g in groups]
    return [r for r in rows if r.get("events")]


def issue_row(g):
    i = g["issue"]
    return {"id": i["id"], "title": i.get("title", ""), "subtitle": i.get("subtitle", ""),
            "errorType": i.get("errorType"), "state": i.get("state"),
            "firstSeen": i.get("firstSeenVersion"), "lastSeen": i.get("lastSeenVersion"),
            "signals": [{"signal": s.get("signal"), "description": s.get("description")}
                        for s in i.get("signals") or []],
            "uri": i.get("uri"), "sampleEvent": i.get("sampleEvent"), **metrics(g)}


def parallel(fns, workers=POOL_SIZE, on_done=None):
    with ThreadPoolExecutor(workers) as ex:
        futs = {k: ex.submit(f) for k, f in fns.items()}
        if on_done:
            for f in futs.values():
                f.add_done_callback(lambda _: on_done())
        return {k: f.result() for k, f in futs.items()}


# Per-filter memory of issue event counts, so the UI can show live deltas.
_seen, _seen_lock = {}, threading.Lock()


def overview(q):
    app, flt = q["app"], build_filter(q)
    key = json.dumps([app, flt.get("issueErrorTypes"), q.get("version"), q.get("device"),
                      q.get("os"), q.get("signal"), q.get("days")])

    def fetch():
        # Each breakdown drops its own dimension's filter (the API rejects
        # grouping by OS while filtering by OS); the UI highlights the pick.
        def without(k):
            return {x: v for x, v in flt.items() if x != k}
        def soft(f):
            # A transient Crashlytics 500 on a breakdown shouldn't fail the overview.
            def run():
                try:
                    return f()
                except Exception:
                    return []
            return run
        r = parallel({
            "issues": lambda: report(app, "topIssues", flt, 100),
            "versions": soft(lambda: report(app, "topVersions", without("versionDisplayNames"), 50)),
            "devices": soft(lambda: report(app, "topAndroidDevices", without("deviceDisplayNames"), 25)),
            "os": soft(lambda: report(app, "topOperatingSystems", without("operatingSystemDisplayNames"), 25)),
        })
        issues = [issue_row(g) for g in r["issues"]]
        now = time.time()
        with _seen_lock:
            prev = _seen.get(key)
            cur = {i["id"]: i["events"] for i in issues}
            for i in issues:
                i["isNew"] = bool(prev) and i["id"] not in prev["counts"]
                i["delta"] = i["events"] - prev["counts"][i["id"]] if prev and i["id"] in prev["counts"] else None
            _seen[key] = {"counts": cur, "at": now}
        versions = dim_rows(r["versions"], "version")
        return {"issues": issues, "versions": versions,
                "devices": dim_rows(r["devices"], "device"),
                "os": dim_rows(r["os"], "operatingSystem"),
                "kpi": next((v for v in versions if v["name"] == q.get("version")), None),
                "deltaSince": prev["at"] if prev else None,
                "fetchedAt": now}

    return cached(("overview", key), OVERVIEW_TTL, fetch)


def daily(app, base_flt, days, name="topVersions", pick=None):
    """One report call per UTC day. Past days never change, so cache them forever."""
    today = datetime.now(timezone.utc).date()
    out = {}

    def one(d):
        s = f"{d}T00:00:00Z"
        e = f"{d}T23:59:59Z" if d < today else datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        flt = {**base_flt, "intervalStartTime": s, "intervalEndTime": e}
        ttl = None if d < today else OVERVIEW_TTL
        groups = cached(("day", app, name, json.dumps(flt if d < today else base_flt, sort_keys=True), str(d)),
                        ttl, lambda: report(app, name, flt, 50))
        return pick(groups) if pick else groups

    dates = [today - timedelta(days=i) for i in range(days - 1, -1, -1)]
    with ThreadPoolExecutor(POOL_SIZE) as ex:
        for d, v in zip(dates, ex.map(one, dates)):
            out[str(d)] = v
    return [{"date": d, **v} for d, v in out.items()]


def trend(q, extra=None):
    app, flt = q["app"], {**build_filter(q, with_window=False), **(extra or {})}
    days = min(int(q.get("days", 7)), 30)
    version = q.get("version")

    def pick(groups):
        rows = [metrics(g) for g in groups
                if not version or g["version"]["displayName"] == version]
        if version:
            return rows[0] if rows else {"events": 0, "impactedUsers": 0}
        # Crash-free % does not sum across versions; report counts only.
        return {"events": sum(r["events"] for r in rows),
                "impactedUsers": sum(r["impactedUsers"] for r in rows)}

    vflt = {k: v for k, v in flt.items() if k != "versionDisplayNames"}
    return daily(app, vflt, days, "topVersions", pick)


# --------------------------------------------------------------------- git

def git(repo, *a, timeout=20):
    r = subprocess.run(["git", "-C", str(repo), *a], capture_output=True,
                       text=True, timeout=timeout)
    return r.stdout if r.returncode == 0 else ""


def resolve_frame(file):
    """`package:fa_flutter_gt/x.dart` → (repo dir, 'lib/x.dart', absolute path)."""
    m = re.match(r"package:([\w_]+)/(.+\.dart)$", file or "")
    if not m or m.group(1) not in SOURCE_ROOTS:
        return None
    lib = SOURCE_ROOTS[m.group(1)].resolve()
    path = (lib / m.group(2)).resolve()
    if lib not in path.parents:
        return None
    return lib.parent, f"lib/{m.group(2)}", path


def version_commits(repo, display):
    """'5.7.1 (601)' → commits (oldest first) whose pubspec has `version: 5.7.1+601`.
    -G also matches the commit that removes the line, so confirm it's present."""
    m = re.match(r"([\w.\-]+) \((\d+)\)$", display or "")
    if not m:
        return []
    pat = rf"^version: {re.escape(m.group(1))}\+0*{m.group(2)}$"

    def find():
        shas = git(repo, "log", "--all", "--reverse", "--format=%H", "-G", pat, "--", "pubspec.yaml").split()
        return [c for c in shas if re.search(pat, git(repo, "show", f"{c}:pubspec.yaml"), re.M)]
    return cached(("vcommits", str(repo), display), None, find)


def version_commit(repo, display):
    c = version_commits(repo, display)
    return c[0] if c else None


def base_commit(repo, display, to_c):
    """Newest bump of `display` that is an ancestor of to_c; else the merge-base."""
    cands = version_commits(repo, display)
    anc = [c for c in cands if subprocess.run(
        ["git", "-C", str(repo), "merge-base", "--is-ancestor", c, to_c]).returncode == 0]
    if anc:
        return anc[-1], True
    mb = git(repo, "merge-base", cands[0], to_c).strip() if cands else ""
    return mb or None, False


def release_of(display):
    """'5.7.1 (601)' → '5.7.1' (Crashlytics' firstSeenVersion has no build)."""
    return (display or "").split(" (")[0].strip()


def new_in_release(q):
    """Issues whose first-ever sighting (across all versions, per Crashlytics)
    is this release, i.e. crashes the previous versions never had."""
    app = q["app"]
    flt = build_filter({**q, "version": ""})
    flt.pop("issueSignals", None)
    flt.pop("deviceDisplayNames", None)
    flt.pop("operatingSystemDisplayNames", None)

    def fetch():
        versions = [r["name"] for r in dim_rows(report(app, "topVersions", flt, 50), "version")]
        version = q.get("version") or max((v for v in versions if short_ver(v)), key=short_ver, default=None)
        if not version:
            return {"version": None, "issues": [], "regressed": []}
        rel = release_of(version)
        rows = [issue_row(g) for g in report(app, "topIssues", {**flt, "versionDisplayNames": [version]}, 100)]
        new = [r for r in rows if str(r["firstSeen"]) == rel]
        regressed = [r for r in rows if r not in new and any(
            s["signal"] == "SIGNAL_REGRESSED" for s in r["signals"])]
        total = sum(r["events"] for r in rows)
        return {"version": version, "release": rel, "previous": previous_version(version, versions),
                "issues": new, "regressed": regressed, "versionIssues": len(rows),
                "versionEvents": total, "fetchedAt": time.time()}

    return cached(("newrel", json.dumps([app, flt.get("issueErrorTypes"), q.get("version"), q.get("days")])),
                  OVERVIEW_TTL, fetch)


def short_ver(v):
    m = re.match(r"(\d+(?:\.\d+)*)", v or "")
    return tuple(int(x) for x in m.group(1).split(".")) if m else ()


def previous_version(display, versions):
    """Closest lower version among the ones Crashlytics knows about."""
    cur = short_ver(display)
    lower = [v for v in versions if short_ver(v) and short_ver(v) < cur]
    return max(lower, key=short_ver) if lower else None


def source_snippet(file, line, rev=None, ctx=8):
    hit = resolve_frame(file)
    if not hit or not str(line or "").isdigit():
        return None
    repo, rel, path = hit
    text = git(repo, "show", f"{rev}:{rel}") if rev else ""
    if not text and path.is_file():
        rev, text = None, path.read_text(errors="replace")
    if not text:
        return None
    lines, n = text.splitlines(), int(line)
    lo, hi = max(1, n - ctx), min(len(lines), n + ctx)
    return {"path": str(path), "line": n, "start": lo, "rev": rev,
            "lines": lines[lo - 1:hi], "editor": f"vscode://file{path}:{n}"}


def blame_info(file, line, rev):
    hit = resolve_frame(file)
    if not hit or not str(line or "").isdigit():
        return None
    repo, rel, _ = hit
    out = git(repo, "blame", "--porcelain", "-L", f"{line},{line}", *([rev] if rev else []), "--", rel)
    if not out:
        return None
    sha = out.split()[0]
    f = dict(l.split(" ", 1) for l in out.splitlines()[1:] if " " in l and not l.startswith("\t"))
    return {"sha": sha, "author": f.get("author"), "email": f.get("author-mail", "").strip("<>"),
            "date": datetime.fromtimestamp(int(f.get("author-time", 0)), timezone.utc).isoformat(),
            "summary": (f.get("summary") or "").strip(), "rev": rev,
            "history": [dict(zip(("sha", "date", "author", "subject"), l.split("\x1f")))
                        for l in git(repo, "log", "-8", "--date=short", "--format=%h\x1f%ad\x1f%an\x1f%s",
                                     *([rev] if rev else []), "--", rel).splitlines()]}


def release_diff(q):
    """Commits touching the blamed file between the base version and this one."""
    hit = resolve_frame(q.get("file"))
    if not hit:
        raise ValueError("blamed frame is not in a local checkout")
    repo, rel, _ = hit
    versions = [v["name"] for v in overview({**q, "version": "", "device": "", "os": "", "signal": ""})["versions"]]
    to_v = q.get("to")
    base_v = q.get("base") or previous_version(to_v, versions)
    to_c = version_commit(repo, to_v)
    if not to_c:
        raise ValueError(f"no pubspec bump found for {to_v}")
    base_c, exact = base_commit(repo, base_v, to_c) if base_v else (None, False)
    rng = [f"{base_c}..{to_c}"] if base_c else ["-15", to_c]
    commits = [dict(zip(("sha", "date", "author", "subject"), l.split("\x1f")))
               for l in git(repo, "log", "--date=short", "--format=%h\x1f%ad\x1f%an\x1f%s",
                            *rng, "--", rel).splitlines()]
    for c in commits:
        c["stat"] = git(repo, "show", "--format=", "--stat=80", c["sha"], "--", rel).strip()
    # Everything else that shipped in the range: the cause may be a caller,
    # config or dependency change rather than the blamed file.
    others = [dict(zip(("sha", "date", "author", "subject"), l.split("\x1f")))
              for l in git(repo, "log", "--no-merges", "--date=short",
                           "--format=%h\x1f%ad\x1f%an\x1f%s", *rng, "--", "lib", "pubspec.yaml",
                           "pubspec.lock").splitlines()] if base_c else []
    return {"file": rel, "to": to_v, "toCommit": to_c, "base": base_v, "baseCommit": base_c, "baseExact": exact,
            "versions": sorted(versions, key=short_ver, reverse=True), "commits": commits,
            "releaseCommits": others[:40], "releaseCommitCount": len(others)}


def clean_event(e):
    keys = e.get("customKeys") or {}
    if isinstance(keys, dict):
        keys = {k: ("•••redacted•••" if REDACT_KEYS.search(k) else v) for k, v in keys.items()}
    blame = e.get("blameFrame") or {}
    return {
        "name": e.get("name"), "time": e.get("eventTime"), "received": e.get("receivedTime"),
        "device": e.get("device") or {}, "os": e.get("operatingSystem") or {},
        "version": (e.get("version") or {}).get("displayName"),
        "user": (e.get("user") or {}).get("id"), "customKeys": keys,
        "memory": e.get("memory") or {}, "storage": e.get("storage") or {},
        "processState": e.get("processState"), "orientation": e.get("deviceOrientation"),
        "variant": (e.get("issueVariant") or {}).get("id"),
        "blame": blame, "exceptions": e.get("exceptions") or "",
        "threads": e.get("threads") or "", "breadcrumbs": e.get("breadcrumbs") or "",
        "logs": e.get("logs") or "",
    }


def issue_detail(q):
    app, iid = q["app"], q["id"]
    flt = {**build_filter(q), "issueId": iid}
    flt.pop("issueSignals", None)

    def fetch():
        warnings = []

        def soft(name, f):
            # Crashlytics 500s now and then; one breakdown failing shouldn't sink the page.
            def run():
                try:
                    return f()
                except Exception as e:
                    warnings.append(f"{name}: {str(e)[-160:]}")
                    return []
            return run
        r = parallel({
            "issue": lambda: parse(mcp("crashlytics_get_issue", appId=app, issueId=iid)),
            "events": lambda: parse(mcp("crashlytics_list_events", appId=app, filter=flt, pageSize=50)),
            "variants": soft("variants", lambda: report(app, "topVariants", flt, 20)),
            "versions": soft("versions", lambda: report(app, "topVersions", {k: v for k, v in flt.items() if k != "versionDisplayNames"}, 20)),
            "devices": soft("devices", lambda: report(app, "topAndroidDevices", {k: v for k, v in flt.items() if k != "deviceDisplayNames"}, 15)),
            "os": soft("os", lambda: report(app, "topOperatingSystems", {k: v for k, v in flt.items() if k != "operatingSystemDisplayNames"}, 15)),
            "notes": soft("notes", lambda: parse(mcp("crashlytics_list_notes", appId=app, issueId=iid, pageSize=50))),
        })
        events = [clean_event(e) for e in (r["events"] if isinstance(r["events"], list) else [])]
        users, companies = {}, {}
        for e in events:
            k = e["customKeys"] if isinstance(e["customKeys"], dict) else {}
            uid = e["user"] or k.get("user_id")
            if uid:
                u = users.setdefault(uid, {"id": uid, "name": k.get("user_Name") or k.get("user_name"),
                                           "company": k.get("company_id"), "events": 0,
                                           "devices": set(), "last": e["time"]})
                u["events"] += 1
                u["devices"].add(e["device"].get("displayName"))
            if k.get("company_id"):
                companies[k["company_id"]] = companies.get(k["company_id"], 0) + 1
        for u in users.values():
            u["devices"] = sorted(d for d in u["devices"] if d)
        blame = next((e["blame"] for e in events if e["blame"]), {})
        # Read source/blame at the version the sampled event shipped in, so
        # line numbers match the stack trace rather than today's branch.
        ship_v = next((e["version"] for e in events if e["blame"]), None)
        hit = resolve_frame(blame.get("file"))
        rev = version_commit(hit[0], ship_v) if hit else None
        variants = [{"id": g["variant"]["id"], "sampleEvent": g["variant"].get("sampleEvent"),
                     "uri": g["variant"].get("uri"), **metrics(g)} for g in r["variants"]]
        return {
            "issue": r["issue"] if isinstance(r["issue"], dict) else {},
            "events": events, "variants": variants,
            "versions": dim_rows(r["versions"], "version"),
            "devices": dim_rows(r["devices"], "device"),
            "os": dim_rows(r["os"], "operatingSystem"),
            "notes": r["notes"] if isinstance(r["notes"], list) else [],
            "sampleUsers": sorted(users.values(), key=lambda u: -u["events"]),
            "sampleCompanies": sorted(({"id": c, "events": n} for c, n in companies.items()),
                                      key=lambda c: -c["events"]),
            "blame": blame,
            "source": source_snippet(blame.get("file"), blame.get("line"), rev),
            "gitBlame": blame_info(blame.get("file"), blame.get("line"), rev),
            "warnings": warnings,
            "shipVersion": ship_v,
            "sourceRoots": {k: str(v) for k, v in SOURCE_ROOTS.items() if v.is_dir()},
        }

    return cached(("issue", json.dumps([app, flt], sort_keys=True)), OVERVIEW_TTL, fetch)


def issue_trend(q):
    # topIssues rejects an issue filter; topVersions accepts it.
    return trend({k: v for k, v in q.items() if k != "signal"}, {"issueId": q["id"]})


# ---------------------------------------------------------------- AI draft

class NeedsUserAction(Exception):
    """An error the user fixes themselves; `fix` is the command to run."""

    def __init__(self, message, fix):
        super().__init__(message)
        self.fix = fix


CLAUDE_LOGIN = "claude auth login"


def claude_auth():
    """`claude auth status` → (logged_in, method). Cheap: no model request."""
    if not shutil.which("claude"):
        return False, "not installed"
    try:
        r = subprocess.run(["claude", "auth", "status", "--json"], capture_output=True, text=True, timeout=20)
        st = json.loads(r.stdout or "{}")
        return bool(st.get("loggedIn")), st.get("authMethod") or "none"
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return False, "unknown"


_ai_locks_guard = threading.Lock()
PII = re.compile(r"\b(user(?:_?id|_?name)?|company(?:_id)?|bearer|token)\b\s*[:=]\s*[^,}\s]+", re.I)


def ai_prompt(d, ship_v, src=None):
    i, src = d["issue"], src or d["source"]
    stacks = list(dict.fromkeys(e["exceptions"] for e in d["events"] if e["exceptions"]))[:3]
    crumbs = PII.sub(r"\1: [redacted]", d["events"][0]["breadcrumbs"]) if d["events"] else ""
    top = lambda rows: ", ".join(f"{r['name']} ({r['events']})" for r in rows[:5])
    blame = d.get("gitBlame") or {}
    return f"""You are helping a Flutter developer triage a Firebase Crashlytics issue in this repo (fa_flutter_gt, BLoC + rxdart, offline-first, Realm).
The key evidence is below (stack, blamed source with wide context, breadcrumbs). Budget: at most ~8 Read/Grep/Glob calls.
Read only what you need (e.g. the blamed file's dispose()/close, the callers in the stack), and grep once for the same pattern elsewhere.
Then answer in concise GitHub markdown with exactly these sections:
## Likely root cause
## Evidence
## Suggested fix
(a minimal Dart patch for the blamed code)
## Same pattern elsewhere
(other files with the same bug shape, from grep; max 8)
## Confidence
(low/medium/high + what would confirm it)

Note: the working tree may be newer than the shipped build {ship_v}; the snippet below is from the shipped revision {src and src.get('rev') or 'working tree'}.

Issue: {i.get('title')}
Exception: {i.get('subtitle')}
Type: {i.get('errorType')} · first seen {i.get('firstSeenVersion')} · last seen {i.get('lastSeenVersion')}
Signals: {'; '.join(s.get('description', '') for s in i.get('signals') or [])}
Top versions: {top(d['versions'])}
Top devices: {top(d['devices'])}
Top OS: {top(d['os'])}
Blamed frame: {d['blame'].get('symbol')} at {d['blame'].get('file')}:{d['blame'].get('line')}
Last change to that line: {blame.get('sha', '')[:10]} {blame.get('date', '')[:10]} "{blame.get('summary', '')}"

Blamed source (line {src['line'] if src else '?'} marked >>):
{chr(10).join(('>> ' if src['start'] + k == src['line'] else '   ') + f"{src['start'] + k}: {l}" for k, l in enumerate(src['lines'])) if src else 'n/a'}

Stack traces (distinct variants):
{(chr(10) + '---' + chr(10)).join(stacks) or 'n/a'}

Breadcrumbs before the crash:
{crumbs[:3000] or 'n/a'}
"""


_ai_jobs = {}  # key -> {"status", "steps", "started", "error", "fix", "proc"}
CLAUDE_FLAGS = [
    "-p", "--output-format", "stream-json", "--verbose", "--model", AI_MODEL, "--effort", AI_EFFORT,
    # Skip the user's MCP servers and hooks: they add startup time and aren't needed here.
    "--strict-mcp-config", "--settings", '{"disableAllHooks": true}', "--no-session-persistence",
    "--allowedTools", "Read", "Grep", "Glob",
    "--disallowedTools", "Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Task"]


def _step(tool_use, root):
    a = tool_use.get("input") or {}
    arg = a.get("file_path") or a.get("pattern") or a.get("path") or ""
    return {"tool": tool_use.get("name"), "arg": str(arg).replace(str(root) + "/", "")[:120]}


def _ai_worker(key, q):
    job = _ai_jobs[key]
    try:
        d = issue_detail(q)
        hit = resolve_frame(d["blame"].get("file"))
        cwd = hit[0] if hit else next(iter(SOURCE_ROOTS.values())).parent
        wide = source_snippet(d["blame"].get("file"), d["blame"].get("line"),
                              (d.get("source") or {}).get("rev"), ctx=40)
        prompt = ai_prompt(d, d.get("shipVersion"), wide)
        proc = job["proc"] = subprocess.Popen(["claude", *CLAUDE_FLAGS], cwd=cwd, text=True,
                                              stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        killer = threading.Timer(AI_TIMEOUT, proc.kill)
        killer.start()
        proc.stdin.write(prompt)
        proc.stdin.close()
        result, raw = None, []
        for line in proc.stdout:
            try:
                m = json.loads(line)
            except ValueError:
                raw.append(line)
                continue
            if m.get("type") == "assistant":
                for c in m.get("message", {}).get("content", []):
                    if c.get("type") == "tool_use":
                        job["steps"].append({**_step(c, cwd), "t": round(time.time() - job["started"])})
            elif m.get("type") == "result":
                result = m
        proc.wait()
        killer.cancel()
        text = (result or {}).get("result") or "".join(raw)
        if re.search(r"failed to authenticate|oauth|not logged in|invalid api key", text[:300], re.I):
            raise NeedsUserAction(f"Claude CLI sign-in failed: {text[:200]}", CLAUDE_LOGIN)
        if result is None and proc.returncode in (-9, 137):
            raise RuntimeError(f"Stopped after {AI_TIMEOUT}s without an answer. Try again, or use 📋 Copy fix prompt in Claude Code.")
        if not result or result.get("is_error") or not text.strip():
            raise RuntimeError((text or "claude returned no answer").strip()[:500])
        with _cache_lock:
            _cache[key] = (time.time(), {"markdown": text.strip(), "at": time.time(),
                                         "seconds": round(time.time() - job["started"]),
                                         "turns": result.get("num_turns"), "model": AI_MODEL})
        job["status"] = "done"
    except NeedsUserAction as e:
        job.update(status="error", error=str(e), fix=e.fix)
    except Exception as e:
        job.update(status="error", error=str(e)[:500], fix=None)


def _ai_status(key):
    with _cache_lock:
        hit = _cache.get(key)
    if hit and time.time() - hit[0] < 6 * 3600:
        return {"status": "done", **hit[1]}
    job = _ai_jobs.get(key)
    if not job:
        return {"status": "idle"}
    return {"status": job["status"], "steps": job["steps"][-12:], "stepCount": len(job["steps"]),
            "elapsed": round(time.time() - job["started"]), "limit": AI_TIMEOUT,
            "error": job.get("error"), "fix": job.get("fix")}


def analyze(body):
    """Starts (or reports) a background `claude -p` run; the UI polls analyze_status."""
    q = {k: str(v) for k, v in body.items() if v is not None}
    key = ("ai", q["app"], q["id"])
    with _ai_locks_guard:
        if body.get("refresh"):
            with _cache_lock:
                _cache.pop(key, None)
        st = _ai_status(key)
        if st["status"] in ("done", "running"):
            return st
        if not shutil.which("claude"):
            raise NeedsUserAction("Claude CLI isn't installed.",
                                  "npm install -g @anthropic-ai/claude-code && claude auth login")
        if not claude_auth()[0]:
            raise NeedsUserAction("Claude CLI isn't signed in (or its session expired).", CLAUDE_LOGIN)
        _ai_jobs[key] = {"status": "running", "steps": [], "started": time.time(), "proc": None}
        threading.Thread(target=_ai_worker, args=(key, q), daemon=True).start()
        return _ai_status(key)


def analyze_status(q):
    return _ai_status(("ai", q["app"], q["id"]))


# -------------------------------------------------------------- user index

_building, _building_lock, _build_errors, _progress = {}, threading.Lock(), {}, {}

def user_index(q):
    """Who is crashing: samples the latest 100 events of the top open issues.
    Crashlytics has no per-user query, so this is a sample, not a full count."""
    base = build_filter(q)
    base.pop("issueSignals", None)
    key = ("users", json.dumps([q["app"], base.get("issueErrorTypes"), q.get("version"), q.get("days")]))

    def build():
        issues = [i for i in overview(q)["issues"] if i["state"] == "OPEN"][:USER_INDEX_ISSUES]
        prog = _progress[key] = {"done": 0, "total": len(issues)}

        def tick():
            prog["done"] += 1
        fetched = parallel({i["id"]: (lambda iid=i["id"]: parse(mcp(
            "crashlytics_list_events", appId=q["app"], filter={**base, "issueId": iid}, pageSize=100)))
            for i in issues}, INDEX_WORKERS, tick)
        titles = {i["id"]: i["title"] for i in issues}
        users, n = {}, 0
        for iid, evs in fetched.items():
            for raw in evs if isinstance(evs, list) else []:
                e, n = clean_event(raw), n + 1
                k = e["customKeys"] if isinstance(e["customKeys"], dict) else {}
                uid = e["user"] or k.get("user_id")
                if not uid:
                    continue
                u = users.setdefault(uid, {"id": uid, "name": k.get("user_Name") or k.get("user_name"),
                                           "company": k.get("company_id"), "events": 0, "issues": {},
                                           "devices": set(), "versions": set(), "recent": []})
                u["events"] += 1
                u["devices"].add(e["device"].get("displayName"))
                u["versions"].add(e["version"])
                it = u["issues"].setdefault(iid, {"id": iid, "title": titles[iid], "events": 0, "last": ""})
                it["events"] += 1
                it["last"] = max(it["last"], e["time"] or "")
                u["recent"].append({"time": e["time"], "issueId": iid, "title": titles[iid],
                                    "version": e["version"], "device": e["device"].get("displayName"),
                                    "os": e["os"].get("displayVersion"), "memFree": e["memory"].get("free")})
        for u in users.values():
            u["devices"] = sorted(x for x in u["devices"] if x)
            u["versions"] = sorted((x for x in u["versions"] if x), key=short_ver, reverse=True)
            u["issues"] = sorted(u["issues"].values(), key=lambda x: -x["events"])
            u["recent"] = sorted(u["recent"], key=lambda x: x["time"] or "", reverse=True)[:30]
        return {"users": sorted(users.values(), key=lambda u: -u["events"]),
                "sampledIssues": len(issues), "sampledEvents": n, "builtAt": time.time()}

    with _cache_lock:
        hit = _cache.get(key)
    if not hit and key in _build_errors:
        raise RuntimeError(_build_errors.pop(key))  # report once; next poll retries
    if not hit or time.time() - hit[0] > 600:
        # Building takes a minute or more; do it off-request and let the UI poll.
        with _building_lock:
            if key not in _building:
                def work():
                    try:
                        cached(key, 0, build)
                    except Exception as e:
                        _build_errors[key] = str(e)[:500]
                    finally:
                        _building.pop(key, None)
                _building[key] = threading.Thread(target=work, daemon=True)
                _building[key].start()
        if not hit:
            return {"building": True, **_progress.get(key, {"done": 0, "total": USER_INDEX_ISSUES})}
    idx = hit[1]
    term = (q.get("q") or "").strip().lower()
    hits = [u for u in idx["users"] if not term or term in
            f"{u['id']} {u['name'] or ''} {u['company'] or ''}".lower()]
    return {**idx, "users": hits[:50], "matches": len(hits)}


# ------------------------------------------------------------------- setup

def _cmd_version(*cmd):
    if not shutil.which(cmd[0]):
        return None
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        return (r.stdout or r.stderr).strip().splitlines()[0] if r.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired, IndexError):
        return None


def setup(q):
    """Requirement checks for the Setup page. Each: ok / detail / fix."""
    def check_node():
        v = _cmd_version("node", "--version")
        major = int(re.sub(r"\D", "", v.split(".")[0]) or 0) if v else 0
        return {"ok": major >= 20, "detail": f"Node {v}" if v else "node not found",
                "fix": "brew install node  # Node 20+ runs the Firebase MCP via npx"}

    def check_git():
        v = _cmd_version("git", "--version")
        return {"ok": bool(v), "detail": v or "git not found", "fix": "xcode-select --install"}

    def check_mcp():
        env = mcp("firebase_get_environment")
        user = re.search(r"Authenticated User:\s*(.+)", env)
        proj = re.search(r"Active Project ID:\s*(.+)", env)
        user = user.group(1).strip() if user else ""
        signed_in = bool(user) and "<" not in user
        return {"ok": signed_in, "detail": f"Signed in as {user} · project {proj.group(1).strip() if proj else '?'}"
                if signed_in else "Firebase MCP is running but no Google account is signed in",
                "fix": "npx -y firebase-tools@latest login", "user": user if signed_in else None}

    def check_crashlytics():
        access_fix = f"Ask a Firebase admin to give your Google account at least 'Firebase Crashlytics Viewer' on {args.project}"
        err = None
        for attempt in range(2):  # Crashlytics returns sporadic 500s; retry once
            try:
                rows = report(args.app, "topVersions", {}, 1)
                return {"ok": True, "detail": f"Crashlytics reachable for app {args.app}"
                        + (f" · latest data from {rows[0]['version']['displayName']}" if rows else "")}
            except Exception as e:
                err = str(e)
                time.sleep(1.5)
        denied = re.search(r"403|PERMISSION_DENIED|permission|not authorized|404", err, re.I)
        return {"ok": False, "detail": err[-250:] if denied else
                "Crashlytics returned a temporary server error twice; press Re-check in a minute",
                "fix": access_fix if denied else None}

    def check_repo():
        lib = next(iter(SOURCE_ROOTS.values()))
        repo = lib.parent
        ok = lib.is_dir() and bool(git(repo, "rev-parse", "--git-dir"))
        branch = git(repo, "branch", "--show-current").strip() if ok else ""
        return {"ok": ok, "detail": f"{repo} · branch {branch or '?'}" if ok else f"No git checkout at {repo}",
                "fix": "uv run server.py --repo /path/to/fa_flutter_gt   # or export FA_REPO=/path/to/fa_flutter_gt"}

    def check_claude():
        v = _cmd_version("claude", "--version")
        if not v:
            return {"ok": False, "detail": "claude CLI not found",
                    "fix": "npm install -g @anthropic-ai/claude-code && claude auth login"}
        logged_in, method = claude_auth()
        return {"ok": logged_in, "detail": f"{v} · signed in ({method})" if logged_in
                else f"{v} · installed but not signed in (or the session expired)", "fix": CLAUDE_LOGIN}

    checks = [("node", "Node.js 20+", check_node, False), ("git", "Git", check_git, False),
              ("mcp", "Firebase MCP + Google sign-in", check_mcp, False),
              ("crashlytics", "Crashlytics access", check_crashlytics, False),
              ("repo", "fa_flutter_gt checkout (source, blame, release diff)", check_repo, True),
              ("claude", "Claude CLI (AI root-cause drafts)", check_claude, True)]

    def safe(fn):
        def run():
            try:
                return fn()
            except Exception as e:
                return {"ok": False, "detail": str(e)[-300:]}
        return run
    only = set(filter(None, (q.get("only") or "").split(",")))
    checks = [c for c in checks if not only or c[0] in only]
    res = parallel({cid: safe(fn) for cid, _, fn, _ in checks})
    # Crashlytics can't work without a signed-in MCP; don't report two failures for one cause.
    if "mcp" in res and "crashlytics" in res and not res["mcp"]["ok"]:
        res["crashlytics"] = {"ok": False, "detail": "Waiting for Firebase sign-in", "fix": res["crashlytics"].get("fix")}
    return {"checks": [{"id": cid, "label": label, "optional": opt, **res[cid]} for cid, label, _, opt in checks],
            "project": args.project, "app": args.app, "port": args.port,
            "repo": str(next(iter(SOURCE_ROOTS.values())).parent), "python": _cmd_version("python3", "--version")}


# ------------------------------------------------------- per-developer config

CONFIG_FILE = ROOT / "config.local.json"  # gitignored; written by the setup wizard


def load_config():
    try:
        return json.loads(CONFIG_FILE.read_text())
    except (OSError, ValueError):
        return {}


def current_config(_q=None):
    return {"project": args.project, "app": args.app, "repo": str(next(iter(SOURCE_ROOTS.values())).parent),
            "saved": CONFIG_FILE.exists()}


def save_config(body):
    """Validates and applies project / app / repo from the wizard, then persists them."""
    cfg = load_config()
    if "repo" in body:
        repo = Path(str(body["repo"])).expanduser()
        if not (repo / "lib").is_dir() or not git(repo, "rev-parse", "--git-dir"):
            raise NeedsUserAction(f"{repo} isn't a git checkout of fa_flutter_gt (no lib/ or .git).",
                                  "git clone git@github.com:FieldAssist/fa_flutter_gt.git")
        SOURCE_ROOTS["fa_flutter_gt"] = repo / "lib"
        cfg["repo"] = str(repo)
    if body.get("project") and body["project"] != args.project:
        args.project, cfg["project"] = body["project"], body["project"]
        if not body.get("app"):
            args.app = None  # an app id belongs to one project; pick again
            cfg.pop("app", None)
        restart_mcps()
    if body.get("app"):
        args.app, cfg["app"] = body["app"], body["app"]
    with _cache_lock:
        _cache.clear()  # every cached report was for the old selection
    CONFIG_FILE.write_text(json.dumps(cfg, indent=2) + "\n")
    return current_config()


def projects(_q):
    def fetch():
        text = mcp("firebase_list_projects", page_size=100)
        doc = parse(text[text.find("projects:"):]) if "projects:" in text else {}
        return [{"projectId": p.get("projectId"), "name": p.get("displayName") or p.get("projectId")}
                for p in (doc or {}).get("projects") or [] if isinstance(p, dict)]
    return cached(("projects",), 600, fetch)


# Sign-in keeps its own process: the auth code must reach the MCP that issued the URL.
_login = {"mcp": None, "lock": threading.Lock()}


def firebase_login(body):
    with _login["lock"]:
        m = _login["mcp"] or Mcp()
        _login["mcp"] = m
        m._ensure()
        a = {}
        if body.get("authCode"):
            a["authCode"] = str(body["authCode"]).strip()
        if body.get("reauth"):
            a["reauth"] = True
        res = m._rpc("tools/call", {"name": "firebase_login", "arguments": a})
        text = "".join(c.get("text", "") for c in res.get("content", []))
        if res.get("isError"):
            raise RuntimeError(text.strip()[:400] or "sign-in failed")
    who = re.search(r"(?:logged in as|Successfully logged in as|signed in as)\s+([^\s,]+@[^\s,]+)", text, re.I)
    if who and not body.get("reauth"):
        if body.get("authCode"):
            restart_mcps()  # pick up the new credentials everywhere
            with _cache_lock:
                _cache.clear()
        return {"status": "signed_in", "email": who.group(1).rstrip(".")}
    if body.get("authCode"):
        # Unknown success wording: ask for status once (no params = status check).
        r = firebase_login({})
        if r["status"] == "signed_in":
            restart_mcps()
            with _cache_lock:
                _cache.clear()
        return r
    url = re.search(r"https://\S+", text)
    # e.g. "Your session ID is: 020DD" (short; must not match later prose like "displayed")
    sid = re.search(r"session\s*id(?:\s+is)?\s*:\s*([A-Za-z0-9_-]{3,})", text, re.I)
    if url:
        return {"status": "pending", "uri": url.group(0).rstrip(").,`'\""), "sessionId": sid.group(1) if sid else None}
    raise RuntimeError(text.strip()[:400] or "unexpected sign-in response")


def apps(_q):
    def fetch():
        doc = parse(mcp("firebase_list_apps", platform="android"))
        return [{"appId": a["appId"], "name": a.get("displayName"), "package": a.get("packageName")}
                for a in doc or [] if isinstance(a, dict)]
    return cached(("apps", args.project), 3600, fetch)


def invalidate(prefix):
    with _cache_lock:
        for k in [k for k in _cache if k[0] in prefix]:
            del _cache[k]


def set_state(body):
    if body.get("state") not in ("OPEN", "CLOSED", "MUTED"):
        raise ValueError("bad state")
    out = mcp("crashlytics_update_issue", appId=body["app"], issueId=body["id"], state=body["state"])
    invalidate(("issue", "overview"))
    return {"ok": True, "result": out}


def add_note(body):
    note = (body.get("note") or "").strip()
    if not note:
        raise ValueError("empty note")
    out = mcp("crashlytics_create_note", appId=body["app"], issueId=body["id"], note=note)
    invalidate(("issue",))
    return {"ok": True, "result": out}


GET = {"/api/apps": apps, "/api/setup": setup, "/api/config": current_config, "/api/projects": projects, "/api/overview": overview, "/api/trend": trend,
       "/api/new-in-release": new_in_release,
       "/api/issue": issue_detail, "/api/issue/trend": issue_trend,
       "/api/issue/release-diff": release_diff, "/api/users": user_index,
       "/api/issue/analyze": analyze_status}
POST = {"/api/issue/state": set_state, "/api/issue/note": add_note,
        "/api/config": save_config, "/api/firebase/login": firebase_login,
        "/api/issue/analyze": analyze}
TYPES = {".html": "text/html", ".js": "text/javascript", ".css": "text/css"}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body, default=str).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype + "; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _api(self, fn, arg):
        try:
            self._send(200, fn(arg))
        except NeedsUserAction as e:
            self._send(424, {"error": str(e), "fix": e.fix})
        except Exception as e:
            self._send(502, {"error": str(e)[:800]})

    def _local(self):
        # Blocks DNS rebinding (foreign Host) and cross-site requests (foreign Origin).
        ok = {f"localhost:{args.port}", f"127.0.0.1:{args.port}"}
        origin = self.headers.get("Origin")
        if self.headers.get("Host") not in ok or (origin and urlparse(origin).netloc not in ok):
            self._send(403, {"error": "forbidden"})
            return False
        return True

    def do_GET(self):
        if not self._local():
            return
        u = urlparse(self.path)
        if u.path in GET:
            q = {k: v[0] for k, v in parse_qs(u.query).items()}
            q.setdefault("app", args.app)
            return self._api(GET[u.path], q)
        name = "index.html" if u.path == "/" else u.path.lstrip("/")
        f = (STATIC / name).resolve()
        if STATIC.resolve() in f.parents and f.is_file():
            return self._send(200, f.read_bytes(), TYPES.get(f.suffix, "text/plain"))
        self._send(404, {"error": "not found"})

    def do_POST(self):
        u = urlparse(self.path)
        if not self._local():
            return
        if u.path not in POST:
            return self._send(404, {"error": "not found"})
        # JSON-only: a cross-site form/text POST can't send this without a CORS preflight.
        if not (self.headers.get("Content-Type") or "").startswith("application/json"):
            return self._send(415, {"error": "Content-Type must be application/json"})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        except ValueError:
            return self._send(400, {"error": "invalid JSON"})
        body.setdefault("app", args.app)
        self._api(POST[u.path], body)

    def log_message(self, *_):
        pass


def main():
    global args
    ap = argparse.ArgumentParser()
    # Precedence: CLI flag > config.local.json (setup wizard) > default.
    cfg = load_config()
    ap.add_argument("--project", default=cfg.get("project", "general-trade---hccb"))
    ap.add_argument("--app", default=cfg.get("app", "1:573624408501:android:85563383bb0ae69c8a61fc"),
                    help="Firebase app id (default: HCCB GT CokeBuddy - Playstore)")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--repo", default=os.environ.get("FA_REPO") or cfg.get("repo") or str(Path.home() / "office/fa_flutter_gt"),
                    help="local fa_flutter_gt checkout, for source, blame and release diffs")
    args = ap.parse_args()
    SOURCE_ROOTS["fa_flutter_gt"] = Path(args.repo).expanduser() / "lib"
    for _ in range(POOL_SIZE):
        pool.put(Mcp())
    print(f"Crashlytics dashboard → http://localhost:{args.port}")
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
