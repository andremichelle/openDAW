#!/bin/zsh
# Publishes one approved preset: ./publish.sh <stage dir> <slug> "<Name>". Copies preset.odp + meta.json into the commons
# checkout (../opendaw-commons-main, branch presets), opens the PR, merges it once the check passes and waits for the
# deploy. Ends with a line "published" or "failed: ...", a queue of publishes waits for it.
fail() { echo "failed: $1"; exit 1; }
STAGE=${1:A}
cd "$(dirname "$0")/../../../opendaw-commons-main" || fail "no commons checkout"
git fetch -q && git merge --ff-only -q origin/main || fail "merge main"
D=dev/presets/sampler/$2
mkdir -p $D && cp "$STAGE/$2/preset.odp" "$STAGE/$2/meta.json" $D/
(cd tools && npm run validate 2>&1 | tail -1)
git add $D && git commit -q -m "$3: a Sampler preset for the next release.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" || fail "commit"
git push -q origin presets || fail "push"
URL=$(gh pr create --base main --head presets --title "$3" --body "$3 in \`$D\`, sound and meta approved.

🤖 Generated with [Claude Code](https://claude.com/claude-code)") || fail "pr"
echo "PR $URL"
for i in $(seq 1 60); do s=$(gh pr checks $URL 2>/dev/null | awk '{print $2}' | head -1); [ "$s" = "pass" -o "$s" = "fail" ] && break; sleep 10; done
echo "check $s"
[ "$s" = "pass" ] || fail "check $s"
gh pr merge $URL --merge --admin || fail "merge"
SHA=$(gh pr view $URL --json mergeCommit -q .mergeCommit.oid)
for i in $(seq 1 60); do ID=$(gh run list --workflow deploy.yml --limit 10 --json databaseId,headSha -q ".[] | select(.headSha == \"$SHA\") | .databaseId" | head -1); [ -n "$ID" ] && break; sleep 5; done
[ -n "$ID" ] || fail "no deploy run for $SHA"
START=$(date +%s); gh run watch $ID --exit-status > /dev/null 2>&1 || fail "deploy $ID"
echo "deploy $ID in $(( $(date +%s) - START ))s"
for i in $(seq 1 12); do
    L=$(curl -s -H "Origin: https://opendaw.studio" "https://assets.opendaw.studio/community/dev/presets/index.json?t=$(date +%s)" | python3 -I -c "
import sys,json
for p in json.load(sys.stdin)['presets']:
    if p['name']==sys.argv[1]: print('live:', p['name'], len(p['samples']), p['downloadSize'])" "$3")
    [ -n "$L" ] && { echo "$L"; break; }
    sleep 10
done
[ -n "$L" ] || echo "not in the index yet"
echo "published"
