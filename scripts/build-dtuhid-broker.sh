#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
output_dir="$repo_root/bin"
output_path="$output_dir/codevisor-dtuhid-broker"

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew is required to locate AXe's simulator frameworks." >&2
  exit 1
fi

axe_prefix="$(brew --prefix axe 2>/dev/null || true)"
frameworks_dir="$axe_prefix/libexec/Frameworks"
if [[ -z "$axe_prefix" || ! -d "$frameworks_dir/FBSimulatorControl.framework" ]]; then
  echo "AXe is required before building the DTUHID broker." >&2
  exit 1
fi

mkdir -p "$output_dir"
xcrun clang \
  -fobjc-arc \
  -fblocks \
  -O2 \
  -framework Foundation \
  -framework FBControlCore \
  -framework FBSimulatorControl \
  -F "$frameworks_dir" \
  -Xlinker -rpath \
  -Xlinker "$frameworks_dir" \
  "$repo_root/native/DTUHIDBroker.m" \
  -o "$output_path"

codesign --force --sign - "$output_path"
