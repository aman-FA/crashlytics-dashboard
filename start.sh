#!/usr/bin/env bash
# One-command start for Crashlytics Live. Usage: ./start.sh [--repo /path/to/fa_flutter_gt] [--port 8787]
set -euo pipefail
cd "$(dirname "$0")"
command -v uv >/dev/null || { echo "uv is required: brew install uv"; exit 1; }
command -v npx >/dev/null || { echo "Node.js 20+ is required: brew install node"; exit 1; }
port=8787
for ((i = 1; i <= $#; i++)); do [[ "${!i}" == "--port" ]] && { j=$((i + 1)); port="${!j}"; }; done
( sleep 2; open "http://localhost:${port}/" 2>/dev/null || true ) &
exec uv run server.py "$@"
