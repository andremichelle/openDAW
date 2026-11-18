#!/usr/bin/env bash
# export: test projects to <dir>/opendaw, opened in Bitwig. Re-export each from Bitwig into <dir>/bitwig, then: verify
set -euo pipefail
command="${1:-}"
directory="${2:-$HOME/Desktop/dawproject-bitwig}"
core="$(cd "$(dirname "$0")/../packages/studio/core" && pwd)"
case "$command" in
  export)
    rm -rf "$directory/opendaw"
    mkdir -p "$directory/opendaw" "$directory/bitwig"
    (cd "$core" && DAWPROJECT_EXPORT_DIR="$directory/opendaw" npx vitest run src/dawproject/DawProjectBitwigCheck.test.ts)
    if [ -d "/Applications/Bitwig Studio.app" ]; then
      for file in "$directory"/opendaw/*.dawproject; do open -a "Bitwig Studio" "$file"; done
    fi
    open -R "$directory/bitwig"
    ;;
  verify)
    (cd "$core" && DAWPROJECT_BITWIG_DIR="$directory/bitwig" npx vitest run src/dawproject/DawProjectBitwigCheck.test.ts)
    ;;
  *)
    echo "usage: $0 export|verify [directory]" >&2
    exit 1
    ;;
esac
