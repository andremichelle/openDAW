#!/bin/zsh
# Uploads one staged folder: ./upload.sh <stage dir> <slug>. Reads the access code from the api.opendaw.studio checkout.
cd "$(dirname "$0")/../.."
export OPENDAW_ACCESS_CODE=$(sed -n "s/^\$validKey = '\(.*\)';/\1/p" ../api.opendaw.studio/samples/upload.php)
node scripts/upload-samples.mjs --dir "$1/$2" --bpm 0 --origin openDAW --results "$1/$2/results.json"
