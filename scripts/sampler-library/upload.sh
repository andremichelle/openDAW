#!/bin/zsh
# Uploads one staged folder: ./upload.sh <stage dir> <slug> [names.json]. Reads the access code from the api.opendaw.studio
# checkout. names.json maps a file name to the cloud name, for folders whose file names are wrong.
cd "$(dirname "$0")/../.."
export OPENDAW_ACCESS_CODE=$(sed -n "s/^\$validKey = '\(.*\)';/\1/p" ../api.opendaw.studio/samples/upload.php)
names=()
[ -n "$3" ] && names=(--names "$3")
node scripts/upload-samples.mjs --dir "$1/$2" --bpm 0 --origin openDAW --results "$1/$2/results.json" "${names[@]}"
