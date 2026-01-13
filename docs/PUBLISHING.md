# Publishing @moises-ai Packages to GitHub Package Registry

This document describes how to publish the OpenDAW packages under the `@moises-ai` scope to GitHub Package Registry, and how to maintain synchronization with the upstream repository.

## Overview

This fork of [andremichelle/openDAW](https://github.com/andremichelle/openDAW) publishes packages under the `@moises-ai` scope to GitHub Package Registry instead of npm.

**Key design principle**: We use a transform script that can be re-run after upstream merges to minimize merge conflicts. The script transforms `@opendaw/*` package names to `@moises-ai/*`.

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

### Private Packages (not published)

These packages have `"private": true` and are not published:

- `@moises-ai/app-studio` - Web application
- `@moises-ai/lab` - Lab application
- `@moises-ai/studio-core-workers` - Audio workers (built into core)
- `@moises-ai/studio-core-processors` - Audio processors (built into core)
- `@moises-ai/studio-forge-boxes` - Code generator
- `@moises-ai/lib-box-forge` - Box forge infrastructure
- `@moises-ai/eslint-config` - ESLint configuration
- `@moises-ai/typescript-config` - TypeScript configuration
- `yjs-server` - Collaboration server (no scope)

## Publishing Workflow

### Automatic Publishing (via GitHub Releases)

Packages are automatically published when you create a new release in GitHub:

1. Go to **Releases** in the GitHub repository
2. Click **"Draft a new release"**
3. Create a new tag (e.g., `v0.0.94`)
4. Fill in the release title and notes
5. Click **"Publish release"**

The GitHub Action will:
1. Checkout the code
2. Install dependencies
3. Build all packages
4. Run tests
5. Publish all non-private packages to GitHub Package Registry

### Manual Publishing (via workflow dispatch)

You can also trigger publishing manually:

1. Go to **Actions** > **Publish Packages to GitHub Registry**
2. Click **"Run workflow"**
3. Optionally enable "dry run" to test without publishing
4. Click **"Run workflow"**

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

### Using the Sync Script (Recommended)

```bash
npm run sync-upstream
```

This script will:
1. Fetch changes from upstream
2. Create a backup branch
3. Merge upstream/main
4. Re-apply the scope transformation
5. Reinstall dependencies
6. Build to verify everything works

### Manual Sync Process

If you prefer to sync manually or need to resolve conflicts:

```bash
# 1. Fetch upstream changes
git fetch upstream

# 2. Merge upstream (resolve conflicts if needed)
git merge upstream/main

# 3. Re-apply scope transformation
npm run apply-scope

# 4. Reinstall dependencies (lockfile will change)
npm install

# 5. Build and test
npm run build
npm test

# 6. Commit the changes
git add .
git commit -m "chore: sync with upstream, reapply scope transformation"
```

### Handling Merge Conflicts

Most conflicts will be in `package.json` files. After resolving:

1. Keep the upstream's structural changes
2. Don't worry about the `@opendaw` scope - the transform script will fix it
3. Run `npm run apply-scope` to reapply the scope transformation
4. Run `npm install` to update the lockfile

## Scripts Reference

### `npm run apply-scope`

Transforms all `@opendaw/*` package names to `@moises-ai/*`. This script:
- Updates all `package.json` files
- Updates `turbo.json` task references
- Updates `lerna.json` registry configuration
- Sets `publishConfig` for publishable packages

This script is idempotent - you can run it multiple times safely.

### `npm run verify-scope`

Verifies that all scope transformations have been applied correctly. Returns exit code 0 if everything is correct, 1 if there are issues.

### `npm run sync-upstream`

Helper script to sync with upstream repository. See "Syncing with Upstream" section above.

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

### Build fails after upstream sync

1. Run `npm run apply-scope` to ensure all scopes are transformed
2. Delete `node_modules` and `package-lock.json`, then run `npm install`
3. Check for any new dependencies that might need scope transformation

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
1. **Minimize merge conflicts**: Upstream changes to `package.json` files merge cleanly
2. **Easy re-application**: After any upstream sync, just run the script again
3. **Separation of concerns**: Moises-specific configuration is isolated in the script

### File Locations

- `scripts/transform-scope.js` - Main transformation script
- `scripts/verify-scope.js` - Verification script
- `scripts/sync-upstream.sh` - Upstream sync helper
- `.npmrc` - npm registry configuration
- `.github/workflows/publish.yml` - GitHub Actions workflow
- `lerna.json` - Lerna configuration (registry, versioning)
- `turbo.json` - Turbo build configuration (task names)
