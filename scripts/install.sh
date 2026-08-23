#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

bun install --frozen-lockfile

git submodule update --init .repos/serve-sim
(
  cd .repos/serve-sim
  bun install --frozen-lockfile
  bun run packages/serve-sim/build.ts
)

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew is required to install AXe's simulator frameworks." >&2
  exit 1
fi

if ! brew --prefix axe >/dev/null 2>&1; then
  brew install cameroncooke/axe/axe
fi

"$repo_root/scripts/build-dtuhid-broker.sh"
