#!/usr/bin/env bash
# Always serves this project folder (avoids 404s when the shell cwd is wrong).
set -euo pipefail
cd "$(dirname "$0")"
PORT="${1:-8765}"
echo "Open: http://127.0.0.1:${PORT}/"
echo "Press Ctrl+C to stop."
exec python3 -m http.server "${PORT}" --bind 127.0.0.1
