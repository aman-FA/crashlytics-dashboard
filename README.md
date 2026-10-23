# Crashlytics Live

Local dashboard for the HCCB Firebase project's Crashlytics data, so you can triage without opening the console.

## Quick start (for any developer)

```bash
git clone <this repo> && cd crashlytics-dashboard
brew install node uv      # Node 20+ runs the Firebase MCP, uv runs the server
./start.sh                # opens http://localhost:8787
```

On first open, an animated **setup wizard** walks you through everything in about 3 minutes:

1. **Tools**: checks Node and Git.
2. **Firebase**: *Sign in with Google* right in the page (through the Firebase MCP), or `npx -y firebase-tools@latest login`.
3. **Project & app**: pick from the Firebase projects your account can see. The wizard checks Crashlytics access, and if you
   don't have it, gives you a ready message to send a Firebase admin (you need *Firebase Crashlytics Viewer*).
4. **Code**: point at your `fa_flutter_gt` checkout (for blamed source, git blame and release diffs).
5. **AI** (optional): Claude Code sign-in for root-cause drafts (`claude auth login`).

Your choices are saved in `config.local.json`, which git ignores. Re-run the wizard any time from **Setup → ✨ Setup wizard**.
The **Setup** page also shows a live connection diagram and diagnostics.

Everything runs on your own machine with your own sign-in; nothing is uploaded or shared.
CLI flags (`--project`, `--app`, `--repo`/`FA_REPO`, `--port`) override the saved config.

**Use the same MCP in your own Claude Code:**
`claude mcp add firebase -- npx -y firebase-tools@latest mcp --only crashlytics`

## Features

- **Filters**: app, version, crashes / non-fatals / ANRs, time range, signal (fresh, regressed, early, repetitive), and device or OS (click a row in the breakdown tables).
- **Overview**: crash-free users and sessions, events, open issues, the top issue's share, and the share of events that blame `fa_flutter_gt` frames.
- **Daily trends**: events per day and crash-free users per day.
- **Issue list**: search, sort by events, users, Δ or crash-free rate, filter by state (open, closed, muted) and by app code vs libraries.
- **Live updates**: polls every 60s. Shows **NEW** issues and a Δ of new events per issue since the last poll, with optional desktop alerts.
- **Issue page**:
  - Blamed frame, with source from your local `fa_flutter_gt` checkout and the line highlighted.
  - VS Code links on every app stack frame.
  - Daily events and users for the issue, plus its recent events. For each event: device, OS, RAM, storage, custom keys and breadcrumbs.
  - Users and companies hitting the issue, and breakdowns by version, device, OS and variant.
  - Notes, Close / Mute / Reopen (written to Firebase after a confirm), and "Copy as ticket" (markdown).

### Developer tools

- **Git blame at the shipped build**: each Crashlytics version (`5.7.1 (601)`) is mapped to the commit that set `version: 5.7.1+601` in `pubspec.yaml`. The blamed source, line numbers and blame come from that revision, not your current branch.
- **Which release broke it**: commits touching the blamed file between the previous version and this one, with a selectable baseline. If none touched it, it lists everything else in the release.
- **AI root-cause draft**: runs your local `claude` CLI in the repo with read-only tools (Read/Grep/Glob). User and company IDs are stripped from what it receives. Results are cached for 6 hours per issue.
- **Bug patterns**: open issues grouped by their normalized error message, so one fix covers them all.
- **Clues**: OS and device-brand over-representation vs all crashes, free RAM and storage at crash, foreground vs background, how concentrated users are, time of day, rooted devices.
- **Users page** (`#/users`): search by user ID, name or company ID. Built in the background from the latest 100 events of the top 40 open issues, so the counts are a sample.

Local API requests must come from `localhost` / `127.0.0.1` (Host and Origin are checked), and POSTs must be JSON, so other websites can't call the API.

Custom keys whose names match `bearer|token|auth|password|secret` are redacted on the server.
Cache: 2 min for live data. Past days in the trends are cached for good, since they don't change.
