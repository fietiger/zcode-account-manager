#!/usr/bin/env sh
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js，请先安装 Node.js 18 或更高版本：https://nodejs.org/" >&2
  exit 1
fi

exec node server/index.js
