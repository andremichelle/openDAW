#!/usr/bin/env bash
set -euo pipefail

echo "Generating mkcert for localhost"
mkdir -p certs && cd certs

if ! command -v mkcert >/dev/null 2>&1; then
  echo "Error: mkcert not found. Install it: https://github.com/FiloSottile/mkcert" >&2
  exit 1
fi

mkcert localhost