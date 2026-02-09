# Publishing @moises-ai Packages to GitHub Package Registry

This document describes how to publish the OpenDAW packages under the `@moises-ai` scope to GitHub Package Registry, and how to maintain synchronization with the upstream repository.

## Overview

This fork of [andremichelle/openDAW](https://github.com/andremichelle/openDAW) publishes packages under the `@moises-ai` scope to GitHub Package Registry instead of npm.

**Key design principle**: We use a transform script that can be re-run after upstream merges to minimize merge conflicts. The script transforms only **publishable** `@opendaw/*` package names to `@moises-ai/*`, leaving non-publishable packages (apps, config, build artifacts) as `@opendaw` to match upstream and reduce merge conflicts. It also converts internal dependency versions to wildcards for workspace resolution, and preserves external `@opendaw` packages (like `@opendaw/nam-wasm`) that should resolve from npmjs.org.

## Package Structure

### Publishable Packages (16 total)

These packages are published to GitHub Package Registry when a release is created:

**Studio packages:**
- `@moises-ai/studio-sdk` - Meta-package that re-exports all studio functionality
- `@moises-ai/studio-core` - Core studio functionality
- `@moises-ai/studio-adapters` - Adapters for studio integration
- `@moises-ai/studio-boxes` - Box schemas and types
- `@moises-ai/studio-enums` - Shared enumerations
- `@moises-ai/studio-scripting` - Scripting support

**Library packages:**
- `@moises-ai/lib-std` - Standard library utilities
- `@moises-ai/lib-runtime` - Runtime utilities
- `@moises-ai/lib-box` - Box infrastructure
- `@moises-ai/lib-dom` - DOM utilities
- `@moises-ai/lib-dsp` - Digital signal processing
- `@moises-ai/lib-fusion` - State management
- `@moises-ai/lib-jsx` - JSX utilities
- `@moises-ai/lib-midi` - MIDI utilities
- `@moises-ai/lib-xml` - XML parsing
- `@moises-ai/lib-dawproject` - DAWproject format support

### Non-publishable Packages (keep `@opendaw` scope)

These packages have `"private": true` and are not published. They keep their upstream `@opendaw` scope to minimize diff from upstream and reduce merge conflicts during syncs:

- `@opendaw/app-studio` - Web application
- `@opendaw/lab` - Lab application
- `@opendaw/studio-core-workers` - Audio workers (built into core)
- `@opendaw/studio-core-processors` - Audio processors (built into core)
- `@opendaw/studio-forge-boxes` - Code generator
- `@opendaw/lib-box-forge` - Box forge infrastructure
- `@opendaw/nam-test` - Neural amp modeling test app
- `@opendaw/eslint-config` - ESLint configuration
- `@opendaw/typescript-config` - TypeScript configuration
- `yjs-server` - Collaboration server (no scope)

## Publishing Workflow

### Step 1: Run a Dry Run First (Recommended)

Before publishing, always run a dry run to verify everything works:

1. Go to **Actions** → **Publish Packages to GitHub Registry**
2. Click **"Run workflow"** (dropdown on the right)
3. Check ✓ **Perform a dry run**
4. Click the green **"Run workflow"** button

The dry run will build, test, and simulate publishing without actually pushing to the registry. Check the output for:
- Any build or test failures
- The list of packages and versions that will be published

Example successful output:
```
Successfully published:
 - @moises-ai/studio-sdk@0.0.93
 - @moises-ai/studio-core@0.0.93
 - @moises-ai/lib-std@0.0.65
 ...
```

Note the version number for `@moises-ai/studio-sdk` (e.g., `0.0.93`) - you'll use this for the release tag.

### Step 2: Create a GitHub Release

Once the dry run succeeds, create a release to publish for real:

1. Go to **Releases** → **Draft a new release**
2. Click **"Choose a tag"** and create a new tag using the highest version from the dry run (e.g., `v0.0.93`)
3. Target: `main` branch
4. Release title: Same as the tag (e.g., `v0.0.93`)
5. Add release notes describing what changed
6. Click **"Publish release"**

The GitHub Action will automatically build, test, and publish all 16 packages to GitHub Package Registry.

**Release Naming Convention:** Since this project uses independent versioning (each package has its own version), the release tag serves as a snapshot marker. Use the `@moises-ai/studio-sdk` version as the tag name.

**Note:** Manual workflow triggers are always dry runs. Actual publishing requires creating a GitHub Release.

### Local Manual Publishing

For testing or emergency publishing:

```bash
# Ensure you're authenticated
npm login --registry=https://npm.pkg.github.com --scope=@moises-ai

# Build everything
npm run build

# Publish (dry run first)
npx lerna publish from-package --yes --no-private --dry-run

# Actual publish
npx lerna publish from-package --yes --no-private
```

## Syncing with Upstream

This fork is designed to stay in sync with [andremichelle/openDAW](https://github.com/andremichelle/openDAW).

### Sync Process

```bash
# 1. Create a branch for the sync
git checkout -b sync-upstream-YYYY-MM-DD

# 2. Fetch and merge upstream
git fetch upstream
git merge upstream/main

# 3. Resolve conflicts — accept upstream for ALL conflicted files
#    The transform script will reapply our scope changes afterward.
git diff --name-only --diff-filter=U | xargs -I{} git checkout --theirs "{}"
git add -A
git commit -m "chore: merge upstream/main"

# 4. Restore all package.json files from upstream to ensure a clean transform
#    (previous transforms may have written stale scope references)
git checkout upstream/main -- $(find packages -name 'package.json' -not -path '*/node_modules/*' -maxdepth 4) package.json

# 5. Re-apply scope transformation
node scripts/transform-scope.js

# 6. Delete stale lockfile and reinstall
rm -f package-lock.json
npm install

# 7. Build and test
npm run build
npm test

# 8. Commit and push
git add -A
git commit -m "chore: sync with upstream, reapply scope transformation"
git push -u origin sync-upstream-YYYY-MM-DD
```

### Handling Merge Conflicts

**Accept upstream for all conflicts.** The transform script handles all scope-related changes, so there's no need to manually resolve conflicts:

1. Run `git checkout --theirs` on all conflicted files
2. Restore `package.json` files from upstream for a clean starting point
3. Run `node scripts/transform-scope.js` to reapply all scope transformations
4. Delete `package-lock.json` and run `npm install` to regenerate it

> **Why delete `package-lock.json`?** The upstream lockfile references `@opendaw` packages on npmjs.org. After scope transformation, these entries become invalid. A fresh `npm install` generates a correct lockfile using workspace resolution.

## Scripts Reference

> **Note:** After an upstream merge, the `npm run` aliases for these scripts may be overwritten. Run the scripts directly with `node` or `bash` instead.

### `node scripts/transform-scope.js`

Transforms the codebase from `@opendaw` to `@moises-ai` scope for **publishable packages only**. This script:
- Renames only the 16 publishable `@opendaw/*` packages to `@moises-ai/*` in `package.json` files
- **Leaves non-publishable packages as `@opendaw`** — apps, config, build artifacts, and forge infrastructure keep their upstream scope
- **Only renames workspace-local publishable packages** — external `@opendaw` dependencies (e.g. `@opendaw/nam-wasm`) are preserved so they resolve from npmjs.org
- **Converts internal dependency versions to `"*"`** for all workspace packages (both scopes) — ensures npm resolves locally instead of checking the GitHub Package Registry
- Updates `turbo.json` task references (publishable packages only)
- Updates `lerna.json` registry configuration
- Updates TypeScript/JavaScript source file imports (publishable workspace packages only)
- Sets `publishConfig` for publishable packages
- Does **not** transform `tsconfig.json` files — they reference `@opendaw/typescript-config` which stays as-is

This script is idempotent — you can run it multiple times safely.

### `node scripts/verify-scope.js`

Verifies that scope transformations have been applied correctly. Checks that:
- Publishable packages have `@moises-ai` scope
- Non-publishable packages have `@opendaw` scope
- `turbo.json` and root `package.json` scripts use the correct scope for each package

Returns exit code 0 if everything is correct, 1 if there are issues.

## Installing Packages from GitHub Registry

To install these packages in another project:

### 1. Configure npm for GitHub Packages

Create or update `.npmrc` in your project:

```ini
@moises-ai:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

### 2. Set the NODE_AUTH_TOKEN environment variable

You need a GitHub Personal Access Token with `read:packages` scope:

```bash
export NODE_AUTH_TOKEN=ghp_your_token_here
```

Or add it to your shell profile (`~/.bashrc`, `~/.zshrc`, etc.).

### 3. Install packages

```bash
npm install @moises-ai/studio-sdk
```

## Versioning

This repository uses **independent versioning** via Lerna. Each package has its own version number that increments independently.

When you need to bump versions before publishing:

```bash
# Bump versions based on conventional commits
npx lerna version --yes

# Or bump all packages to a specific version
npx lerna version 0.1.0 --yes
```

## Troubleshooting

### "Package not found" when installing

1. Ensure your `.npmrc` is configured correctly
2. Verify your `GITHUB_TOKEN` has `read:packages` scope
3. Check that the package has been published (check the Packages tab in GitHub)

### "No matching version found" (ETARGET) during `npm install`

This happens when npm checks the GitHub Package Registry for `@moises-ai` workspace packages and the registry doesn't have the latest upstream versions. The transform script prevents this by using wildcard (`"*"`) versions for all internal workspace deps (both `@moises-ai` and `@opendaw` scopes). If you see this error:

1. Ensure you ran `node scripts/transform-scope.js` after restoring `package.json` files from upstream
2. Verify internal deps use `"*"` versions: `grep -r '"@moises-ai/\|"@opendaw/' packages/*/package.json | grep -v '"*"' | grep -v nam-wasm`
3. Delete `package-lock.json` and re-run `npm install`

### Build fails after upstream sync

1. Run `node scripts/transform-scope.js` to ensure all scopes are transformed
2. Delete `node_modules` and `package-lock.json`, then run `npm install`
3. Check for any new external `@opendaw` dependencies that should NOT be renamed (the script handles this automatically for workspace packages)

### GitHub Action fails to publish

1. Check the Actions tab for error details
2. Ensure the release was created correctly
3. Verify that package versions don't already exist (can't republish same version)

### "403 Forbidden" when publishing

1. Ensure the `GITHUB_TOKEN` has `packages:write` permission
2. For GitHub Actions, ensure `permissions.packages: write` is set in the workflow

## Architecture Notes

### Why a Transform Script?

The transform script approach was chosen to:
1. **Minimize merge conflicts**: Upstream changes to `package.json` files merge cleanly — just accept upstream and re-run the script
2. **Easy re-application**: After any upstream sync, just run the script again
3. **Separation of concerns**: Moises-specific configuration is isolated in the script

### Wildcard Versions for Workspace Packages

Internal `@moises-ai` dependencies use `"*"` instead of caret ranges (e.g. `"^0.0.68"`). This is necessary because:

- npm always checks the scoped registry (`npm.pkg.github.com`) for `@moises-ai` packages, even when they exist locally as workspace packages
- If the registry doesn't have the version that the caret range requires, `npm install` fails with `ETARGET`
- Using `"*"` matches any version, so npm resolves from the local workspace without hitting the registry
- At publish time, Lerna replaces `"*"` with the actual version numbers

### External @opendaw Packages

Not all `@opendaw/*` packages are local to this monorepo. External packages like `@opendaw/nam-wasm` are published to npmjs.org and must keep their original scope. The transform script detects which packages are workspace-local and only renames those, leaving external `@opendaw` dependencies untouched in both `package.json` and source imports.

### File Locations

- `scripts/transform-scope.js` - Main transformation script
- `scripts/verify-scope.js` - Verification script
- `scripts/sync-upstream.sh` - Upstream sync helper
- `.npmrc` - npm registry configuration
- `.github/workflows/publish.yml` - GitHub Actions workflow
- `lerna.json` - Lerna configuration (registry, versioning)
- `turbo.json` - Turbo build configuration (task names)
