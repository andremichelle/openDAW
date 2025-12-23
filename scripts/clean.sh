#!/bin/bash
set -e

echo "Removing node_modules..."
find . -name node_modules -type d -prune -exec rm -rf {} + 2>/dev/null || true

echo "Removing dist..."
find . -name dist -type d -prune -exec rm -rf {} + 2>/dev/null || true

echo "Removing package-lock.json..."
find . -name package-lock.json -type f -delete 2>/dev/null || true

echo "Removing .turbo..."
rm -rf .turbo packages/*/.turbo 2>/dev/null || true

rm -rf packages/studio/boxes/src/* 2>/dev/null || true