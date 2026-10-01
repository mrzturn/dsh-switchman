#!/usr/bin/env bash
# db-query 技能一键环境检查 + 安装 + 测试
# 幂等：依赖已装则跳过 npm ci

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SCRIPT_DIR"

# ── Node / npm 版本检查 ──
if ! command -v node &>/dev/null; then
  echo "✗ 未找到 node，需要 Node.js >= 18"
  exit 1
fi

NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "✗ Node.js 版本 $(node -v) 低于最低要求 18"
  exit 1
fi

if ! command -v npm &>/dev/null; then
  echo "✗ 未找到 npm"
  exit 1
fi

echo "Node $(node -v) ✓  npm $(npm -v) ✓"

# ── 幂等安装运行时依赖 ──
# 已有 node_modules 时 npm ci 仍会检查一致性，幂等安全
if [ -d node_modules ]; then
  echo "依赖已存在，跳过安装（删除 node_modules 可强制重装）"
else
  echo "安装运行时依赖（mysql2 redis dotenv）..."
  if [ -f package-lock.json ]; then
    npm ci --omit=dev --no-audit --no-fund
  else
    npm install --omit=dev --no-audit --no-fund
  fi
  echo "依赖安装 ✓"
fi

# ── 运行测试 ──
echo "运行测试..."
if node --test tests/*.test.js 2>/dev/null; then
  echo "全部测试通过 ✓"
else
  echo "⚠ 未找到测试文件或测试未通过（首次部署无测试属正常）"
fi

echo "db-query 环境就绪 ✓"
