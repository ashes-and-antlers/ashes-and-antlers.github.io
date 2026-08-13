#!/usr/bin/env bash
#
# Ashes and Antlers — clean dev-stack runner
#
# Starts the local PostgreSQL container, applies migrations, then boots the
# API (tsx watch) and the web dev server (Vite) on their canonical ports.
#
# This exists because plain `pnpm run dev` can fail silently:
#   - Freebuff shells export PORT=<harness port>; the API inherits it and
#     dies with EADDRINUSE while Vite keeps answering with proxy 500s.
#   - Stale tsx/vite processes from previous runs can hold :3001/:5173.
#
# Usage:
#   ./scripts/dev.sh            start (or reuse) everything cleanly
#   ./scripts/dev.sh --clean    wipe the local database volume first (fresh world)
#   ./scripts/dev.sh --stop     stop the stack and exit
#
# Ctrl-C stops the API + Vite (children are killed on exit).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

API_PORT="${API_PORT:-3001}"
WEB_PORT="${WEB_PORT:-5173}"
MODE="start"

for arg in "$@"; do
  case "$arg" in
    --clean) MODE="clean" ;;
    --stop) MODE="stop" ;;
    -h | --help)
      grep -E '^#   ' "$0" | sed 's/^#   //'
      exit 0
      ;;
    *) echo "unknown argument: $arg (see --help)" >&2 && exit 2 ;;
  esac
done

# ---------------------------------------------------------------------------
# --stop: shut down what we (or a previous run) started, then exit.
# ---------------------------------------------------------------------------
if [[ "$MODE" == "stop" ]]; then
  echo "[dev] stopping dev stack…"
  # Kill the pnpm parents first so their children are reaped, then any strays.
  pkill -f "pnpm --filter @ashes/api dev" 2>/dev/null || true
  pkill -f "pnpm --filter @ashes/web dev" 2>/dev/null || true
  pkill -f "tsx watch src/server.ts" 2>/dev/null || true
  pkill -f "node .*vite" 2>/dev/null || true
  docker compose down
  echo "[dev] stopped."
  exit 0
fi

# ---------------------------------------------------------------------------
# Ports: refuse to run over an unknown listener, kill obvious stale ones.
# ---------------------------------------------------------------------------
check_port() {
  local port="$1" what="$2"
  if ss -tln 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${port}\$"; then
    # Kill only processes that look like this project's servers.
    pkill -f "src/server.ts" 2>/dev/null || true
    pkill -f "vite" 2>/dev/null || true
    sleep 1
    if ss -tln 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${port}\$"; then
      echo "[dev] error: port ${port} (${what}) is still in use by another process." >&2
      echo "[dev] free it first, e.g. 'lsof -i :${port}', then re-run." >&2
      exit 1
    fi
    echo "[dev] cleared stale process on :${port}"
  fi
}

# ---------------------------------------------------------------------------
# --clean: wipe the local database volume (fresh world, no accounts).
# ---------------------------------------------------------------------------
if [[ "$MODE" == "clean" ]]; then
  echo "[dev] wiping local database volume (fresh world)…"
  docker compose down -v
fi

# ---------------------------------------------------------------------------
# PostgreSQL: start it and wait until it accepts connections.
# ---------------------------------------------------------------------------
echo "[dev] starting PostgreSQL…"
docker compose up -d
for _ in $(seq 1 30); do
  if docker exec ashes-postgres pg_isready -U ashes -d ashes >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if ! docker exec ashes-postgres pg_isready -U ashes -d ashes >/dev/null 2>&1; then
  echo "[dev] error: PostgreSQL did not become ready in time." >&2
  exit 1
fi
echo "[dev] PostgreSQL ready."

# ---------------------------------------------------------------------------
# Migrations (also run at API boot; harmless to apply twice).
# ---------------------------------------------------------------------------
echo "[dev] applying database migrations…"
pnpm db:migrate

# ---------------------------------------------------------------------------
# Run the stack. The API must never inherit the shell's PORT (Freebuff
# exports its own); pin the canonical ports explicitly.
# ---------------------------------------------------------------------------
trap 'echo; echo "[dev] stopping dev stack…"; pkill -f "tsx watch src/server.ts" 2>/dev/null || true; pkill -f "vite" 2>/dev/null || true; echo "[dev] stopped."' INT TERM

echo "[dev] starting API on :${API_PORT} and web on :${WEB_PORT} (Ctrl-C to stop)…"
# The web app ignores PORT; the API must NOT inherit the shell's harness PORT.
env -u PORT PORT="${API_PORT}" pnpm --parallel --filter @ashes/api --filter @ashes/web dev
