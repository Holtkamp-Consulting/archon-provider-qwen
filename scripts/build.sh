#!/usr/bin/env bash
# Compile the provider into a standalone executable with Bun, the way Archon builds its
# own archon-provider-* binaries.
#
#   TARGET   Bun compile target (bun-darwin-arm64, bun-darwin-x64, bun-linux-x64, bun-linux-arm64).
#            Default: the host platform.
#   OUTFILE  Output path. Default: dist/archon-provider-qwen-<os>-<arch>.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -z "${TARGET:-}" ]; then
  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  case "$(uname -m)" in
    arm64 | aarch64) arch=arm64 ;;
    x86_64 | amd64) arch=x64 ;;
    *) echo "unsupported architecture $(uname -m)" >&2; exit 1 ;;
  esac
  TARGET="bun-${os}-${arch}"
fi
OUTFILE="${OUTFILE:-dist/archon-provider-qwen-${TARGET#bun-}}"
mkdir -p "$(dirname "$OUTFILE")"

# A standalone executable autoloads .env and bunfig.toml from its working directory
# unless told not to; the provider runs inside target repositories.
bun build \
  --compile \
  --minify \
  --no-compile-autoload-dotenv \
  --no-compile-autoload-bunfig \
  --target="$TARGET" \
  --outfile="$OUTFILE" \
  src/main.ts

echo "built $OUTFILE"
