#!/usr/bin/env node
/**
 * Verify that scope transformation has been applied correctly
 *
 * Usage: node scripts/verify-scope.js
 *
 * Exit codes:
 *   0 - All scopes are correctly transformed
 *   1 - Errors found (old scope still present)
 */

const fs = require("fs");
const path = require("path");

const EXPECTED_SCOPE = "@moises-ai";
const OLD_SCOPE = "@opendaw";

/**
 * Collect all local workspace package names (both @opendaw and @moises-ai forms)
 */
function collectWorkspacePackageNames(rootDir) {
  const names = new Set();
  const packageFiles = findPackageJsonFiles(rootDir);
  for (const file of packageFiles) {
    const content = JSON.parse(fs.readFileSync(file, "utf8"));
    if (content.name) {
      names.add(content.name);
      if (content.name.startsWith(EXPECTED_SCOPE)) {
        names.add(content.name.replace(EXPECTED_SCOPE, OLD_SCOPE));
      }
    }
  }
  return names;
}

/**
 * Recursively find all package.json files
 */
function findPackageJsonFiles(dir, results = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (
      entry.isDirectory() &&
      !["node_modules", "dist", ".git"].includes(entry.name)
    ) {
      findPackageJsonFiles(fullPath, results);
    } else if (entry.isFile() && entry.name === "package.json") {
      results.push(fullPath);
    }
  }

  return results;
}

/**
 * Recursively find all tsconfig*.json files
 */
function findTsconfigFiles(dir, results = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (
      entry.isDirectory() &&
      !["node_modules", "dist", ".git"].includes(entry.name)
    ) {
      findTsconfigFiles(fullPath, results);
    } else if (entry.isFile() && entry.name.startsWith("tsconfig") && entry.name.endsWith(".json")) {
      results.push(fullPath);
    }
  }

  return results;
}

async function main() {
  const rootDir = path.resolve(__dirname, "..");
  let errors = 0;

  console.log("\n=== Scope Verification ===");
  console.log(`  Expected scope: ${EXPECTED_SCOPE}`);
  console.log(`  Checking for: ${OLD_SCOPE}\n`);

  // Collect workspace package names to distinguish local vs external @opendaw packages
  const packageFiles = findPackageJsonFiles(rootDir);
  const workspaceNames = collectWorkspacePackageNames(rootDir);

  // Check all package.json files
  console.log("Checking package.json files...");

  for (const file of packageFiles) {
    const content = JSON.parse(fs.readFileSync(file, "utf8"));
    const relativePath = path.relative(rootDir, file);

    // Check package name (skip yjs-server which has no scope)
    if (content.name?.includes(OLD_SCOPE)) {
      console.error(`  ERROR: ${relativePath}`);
      console.error(`         name contains ${OLD_SCOPE}: ${content.name}`);
      errors++;
    }

    // Check dependencies — only flag @opendaw deps that are workspace-local
    // (they should have been renamed). External @opendaw packages are allowed.
    for (const depType of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
    ]) {
      if (content[depType]) {
        for (const name of Object.keys(content[depType])) {
          if (name.startsWith(OLD_SCOPE) && workspaceNames.has(name)) {
            console.error(`  ERROR: ${relativePath}`);
            console.error(`         ${depType} contains ${OLD_SCOPE}: ${name} (workspace package should be renamed)`);
            errors++;
          }
        }
      }
    }
  }

  // Check turbo.json
  console.log("\nChecking turbo.json...");
  const turboPath = path.join(rootDir, "turbo.json");
  if (fs.existsSync(turboPath)) {
    const turboContent = fs.readFileSync(turboPath, "utf8");
    if (turboContent.includes(OLD_SCOPE)) {
      console.error(`  ERROR: turbo.json contains ${OLD_SCOPE}`);
      errors++;
    }
  }

  // Check tsconfig.json files
  console.log("Checking tsconfig.json files...");
  const tsconfigFiles = findTsconfigFiles(rootDir);
  for (const file of tsconfigFiles) {
    const content = fs.readFileSync(file, "utf8");
    if (content.includes(OLD_SCOPE)) {
      console.error(`  ERROR: ${path.relative(rootDir, file)} contains ${OLD_SCOPE}`);
      errors++;
    }
  }

  // Check root package.json scripts
  console.log("Checking root package.json scripts...");
  const rootPkg = JSON.parse(
    fs.readFileSync(path.join(rootDir, "package.json"), "utf8")
  );
  if (rootPkg.scripts) {
    for (const [key, value] of Object.entries(rootPkg.scripts)) {
      if (typeof value === "string" && value.includes(OLD_SCOPE)) {
        console.error(`  ERROR: package.json script "${key}" contains ${OLD_SCOPE}`);
        errors++;
      }
    }
  }

  // Check marker file exists
  console.log("\nChecking transformation marker...");
  const markerPath = path.join(rootDir, ".moises-scope-applied");
  if (!fs.existsSync(markerPath)) {
    console.warn(
      "  WARNING: .moises-scope-applied marker file not found"
    );
    console.warn("           Run 'npm run apply-scope' to apply transformation");
  } else {
    const markerContent = fs.readFileSync(markerPath, "utf8");
    console.log(`  Marker found: ${markerContent.split("\n")[0]}`);
  }

  // Summary
  console.log("\n=== Summary ===");
  if (errors === 0) {
    console.log(`  ✓ All scopes are correctly set to ${EXPECTED_SCOPE}`);
    console.log("  ✓ Verification passed\n");
    process.exit(0);
  } else {
    console.error(`  ✗ ${errors} error(s) found`);
    console.error(`  ✗ Run 'npm run apply-scope' to fix\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
