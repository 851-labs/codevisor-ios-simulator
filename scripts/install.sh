#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required to install the iOS Simulator plugin." >&2
  exit 1
fi

npm ci

required_runtime_files=(
  "vendor/serve-sim/middleware.js"
  "vendor/serve-sim/native/serve-sim-native.node"
  "vendor/serve-sim/simax/serve-sim-ax-settings"
)
for runtime_file in "${required_runtime_files[@]}"; do
  if [[ ! -f "$runtime_file" ]]; then
    echo "The plugin package is incomplete: $runtime_file is missing." >&2
    exit 1
  fi
done

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "The iOS Simulator plugin currently supports Apple Silicon Macs only." >&2
  exit 1
fi

chmod +x vendor/serve-sim/simax/serve-sim-ax-settings

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew is required to install AXe's simulator frameworks." >&2
  exit 1
fi

if ! brew --prefix axe >/dev/null 2>&1; then
  brew install cameroncooke/axe/axe
fi

"$repo_root/scripts/build-dtuhid-broker.sh"
