#!/bin/bash
#
# sync-upstream.sh
# Helper script to sync with upstream openDAW repository and re-apply scope transformations
#
# Usage: npm run sync-upstream
#        or: bash scripts/sync-upstream.sh
#

set -e

echo ""
echo "=== OpenDAW Upstream Sync Helper ==="
echo ""

# Check if upstream remote exists
if ! git remote | grep -q '^upstream$'; then
    echo "ERROR: 'upstream' remote not configured"
    echo ""
    echo "Add it with:"
    echo "  git remote add upstream https://github.com/andremichelle/openDAW"
    echo ""
    exit 1
fi

# Check for uncommitted changes
if ! git diff-index --quiet HEAD --; then
    echo "ERROR: You have uncommitted changes"
    echo ""
    echo "Please commit or stash your changes before syncing:"
    echo "  git stash"
    echo "  npm run sync-upstream"
    echo "  git stash pop"
    echo ""
    exit 1
fi

# 1. Fetch upstream changes
echo "1. Fetching upstream..."
git fetch upstream

# 2. Show what will be merged
COMMITS_BEHIND=$(git rev-list --count HEAD..upstream/main 2>/dev/null || echo "0")
if [ "$COMMITS_BEHIND" = "0" ]; then
    echo ""
    echo "Already up to date with upstream/main"
    echo ""
    exit 0
fi

echo "   Found $COMMITS_BEHIND new commit(s) in upstream/main"
echo ""

# 3. Create a backup branch
BACKUP_BRANCH="pre-sync-backup-$(date +%Y%m%d-%H%M%S)"
echo "2. Creating backup branch: $BACKUP_BRANCH"
git branch "$BACKUP_BRANCH"

# 4. Merge upstream/main
echo ""
echo "3. Merging upstream/main..."
if ! git merge upstream/main --no-edit; then
    echo ""
    echo "!!! Merge conflicts detected !!!"
    echo ""
    echo "Please resolve the conflicts manually, then run:"
    echo "  git add ."
    echo "  git commit"
    echo "  npm run apply-scope"
    echo "  npm install"
    echo "  npm run build"
    echo ""
    echo "To abort the merge and restore the previous state:"
    echo "  git merge --abort"
    echo ""
    exit 1
fi

# 5. Re-apply scope transformations
echo ""
echo "4. Re-applying scope transformations..."
npm run apply-scope

# 6. Reinstall dependencies
echo ""
echo "5. Reinstalling dependencies..."
npm install

# 7. Build to verify
echo ""
echo "6. Building to verify..."
if npm run build; then
    echo ""
    echo "=== Sync Complete! ==="
    echo ""
    echo "Changes have been merged and scope transformations applied."
    echo "A backup branch was created: $BACKUP_BRANCH"
    echo ""
    echo "Please review the changes with:"
    echo "  git log --oneline -10"
    echo "  git diff HEAD~$COMMITS_BEHIND"
    echo ""
    echo "If everything looks good, you can delete the backup branch:"
    echo "  git branch -d $BACKUP_BRANCH"
    echo ""
else
    echo ""
    echo "!!! Build failed !!!"
    echo ""
    echo "Please investigate the build errors."
    echo "You may need to resolve additional issues."
    echo ""
    echo "To rollback to the previous state:"
    echo "  git reset --hard $BACKUP_BRANCH"
    echo ""
    exit 1
fi
