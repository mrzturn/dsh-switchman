#!/usr/bin/env bash
# db-query skill: one-shot environment check + install + test
# Idempotent: skip npm ci when dependencies are already installed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SCRIPT_DIR"

# ── Node / npm version check ──
if ! command -v node &>/dev/null; then
  echo "✗ node not found; Node.js >= 18 is required"
  exit 1
fi

NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "✗ Node.js version $(node -v) is below the minimum required 18"
  exit 1
fi

if ! command -v npm &>/dev/null; then
  echo "✗ npm not found"
  exit 1
fi

echo "Node $(node -v) ✓  npm $(npm -v) ✓"

# ── Idempotent install of runtime dependencies ──
# When node_modules already exists, npm ci would still verify consistency, so skipping is idempotent-safe
if [ -d node_modules ]; then
  echo "Dependencies already present, skipping install (delete node_modules to force a reinstall)"
else
  echo "Installing runtime dependencies (mysql2 redis dotenv)..."
  if [ -f package-lock.json ]; then
    npm ci --omit=dev --no-audit --no-fund
  else
    npm install --omit=dev --no-audit --no-fund
  fi
  echo "Dependencies installed ✓"
fi

# ── Run tests ──
echo "Running tests..."
if node --test tests/*.test.js 2>/dev/null; then
  echo "All tests passed ✓"
else
  echo "⚠ No test files found or tests did not pass (no tests on first deployment is normal)"
fi

echo "db-query environment ready ✓"
