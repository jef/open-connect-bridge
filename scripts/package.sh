#!/usr/bin/env bash
# Builds the downloadable assets for one platform into build/release.
# Usage: bash scripts/package.sh <windows|linux|macos> [version]
# Without a version, the version from src-tauri/tauri.conf.json is used and assets are named "dev".
set -euo pipefail

platform="${1:?Usage: package.sh <windows|linux|macos> [version]}"
version="${2:-}"
label="${version:-dev}"

config=()
if [ -n "$version" ]; then
  printf '{"version":"%s"}' "$version" > src-tauri/release-version.json
  config=(--config src-tauri/release-version.json)
fi

mkdir -p build/release

case "$platform" in
  windows)
    cargo tauri build ${config[@]+"${config[@]}"} --no-bundle -- --locked
    cp src-tauri/target/release/open-connect-bridge.exe build/release/open-connect-bridge.exe
    ;;
  linux)
    cargo tauri build ${config[@]+"${config[@]}"} --no-bundle -- --locked
    tar -C src-tauri/target/release -czf "build/release/open-connect-bridge-$label-linux-x64.tar.gz" open-connect-bridge
    ;;
  macos)
    for entry in "x64:x86_64-apple-darwin" "arm64:aarch64-apple-darwin"; do
      arch="${entry%%:*}"
      target="${entry#*:}"
      cargo tauri build ${config[@]+"${config[@]}"} --target "$target" --bundles dmg -- --locked
      shopt -s nullglob
      files=(src-tauri/target/"$target"/release/bundle/dmg/*.dmg)
      [ "${#files[@]}" -eq 1 ] || { echo "Expected one DMG for $target, found ${#files[@]}" >&2; exit 1; }
      cp "${files[0]}" "build/release/open-connect-bridge-$label-mac-$arch.dmg"
    done
    ;;
  *)
    echo "Unknown platform: $platform" >&2
    exit 1
    ;;
esac

ls -l build/release
