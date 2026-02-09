#!/usr/bin/env node
/**
 * Verify that scope transformation has been applied correctly
 *
 * Only publishable packages should have @moises-ai scope.
 * Non-publishable packages (apps, config, build artifacts, forge
 * infrastructure) should keep their @opendaw scope.
 *
 * Usage: node scripts/verify-scope.js
 *
 * Exit codes:
 *   0 - All scopes are correctly transformed
 *   1 - Errors found
 */

const fs = require("fs");
const path = require("path");

const EXPECTED_SCOPE = "@moises-ai";
const OLD_SCOPE = "@opendaw";

// Short names (without scope) of packages that should be published
// and therefore renamed to @moises-ai.
const PUBLISHABLE_PACKAGES = new Set([
  "lib-std",
  "lib-runtime",
  "lib-box",
  "lib-dom",
  "lib-dsp",
  "lib-fusion",
  "lib-jsx",
  "lib-midi",
  "lib-xml",
  "lib-dawproject",
  "studio-sdk",
  "studio-core",
  "studio-adapters",
  "studio-boxes",
  "studio-enums",
  "studio-scripting",
]);

function isPublishable(shortName) {
  return PUBLISHABLE_PACKAGES.has(shortName);
}

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
      if (content.name.startsWith(OLD_SCOPE)) {
        names.add(content.name.replace(OLD_SCOPE, EXPECTED_SCOPE));
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

async function main() {
  const rootDir = path.resolve(__dirname, "..");
  let errors = 0;

  console.log("\n=== Scope Verification ===");
  console.log(`  Publishable scope: ${EXPECTED_SCOPE}`);
  console.log(`  Non-publishable scope: ${OLD_SCOPE}\n`);

  // Collect workspace package names to distinguish local vs external @opendaw packages
  const packageFiles = findPackageJsonFiles(rootDir);
  const workspaceNames = collectWorkspacePackageNames(rootDir);

  // Check all package.json files
  console.log("Checking package.json files...");

  for (const file of packageFiles) {
    const content = JSON.parse(fs.readFileSync(file, "utf8"));
    const relativePath = path.relative(rootDir, file);

    // Check package name
    if (content.name) {
      if (content.name.startsWith(OLD_SCOPE)) {
        const shortName = content.name.replace(OLD_SCOPE + "/", "");
        if (isPublishable(shortName)) {
          console.error(`  ERROR: ${relativePath}`);
          console.error(`         Publishable package still has ${OLD_SCOPE} scope: ${content.name}`);
          errors++;
        }
        // Non-publishable with @opendaw is expected — no error
      }
      if (content.name.startsWith(EXPECTED_SCOPE)) {
        const shortName = content.name.replace(EXPECTED_SCOPE + "/", "");
        if (!isPublishable(shortName)) {
          console.error(`  ERROR: ${relativePath}`);
          console.error(`         Non-publishable package should not have ${EXPECTED_SCOPE} scope: ${content.name}`);
          errors++;
        }
      }
    }

    // Check dependencies — publishable workspace packages should be @moises-ai,
    // non-publishable workspace packages should be @opendaw
    for (const depType of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
    ]) {
      if (content[depType]) {
        for (const name of Object.keys(content[depType])) {
          if (name.startsWith(OLD_SCOPE)) {
            const shortName = name.replace(OLD_SCOPE + "/", "");
            // Only flag workspace-local publishable packages that weren't renamed
            if (isPublishable(shortName) && workspaceNames.has(name)) {
              console.error(`  ERROR: ${relativePath}`);
              console.error(`         ${depType} contains ${OLD_SCOPE}: ${name} (publishable — should be ${EXPECTED_SCOPE}/${shortName})`);
              errors++;
            }
          }
          if (name.startsWith(EXPECTED_SCOPE)) {
            const shortName = name.replace(EXPECTED_SCOPE + "/", "");
            if (!isPublishable(shortName) && workspaceNames.has(name)) {
              console.error(`  ERROR: ${relativePath}`);
              console.error(`         ${depType} contains ${EXPECTED_SCOPE}: ${name} (non-publishable — should be ${OLD_SCOPE}/${shortName})`);
              errors++;
            }
          }
        }
      }
    }
  }

  // Check turbo.json — publishable refs should be @moises-ai,
  // non-publishable should be @opendaw
  console.log("\nChecking turbo.json...");
  const turboPath = path.join(rootDir, "turbo.json");
  if (fs.existsSync(turboPath)) {
    const turboContent = fs.readFileSync(turboPath, "utf8");
    const turboMatches = turboContent.matchAll(/@(?:opendaw|moises-ai)\/([\w-]+)/g);
    for (const match of turboMatches) {
      const fullMatch = match[0];
      const shortName = match[1];
      if (isPublishable(shortName) && fullMatch.startsWith(OLD_SCOPE)) {
        console.error(`  ERROR: turbo.json has ${fullMatch} (publishable — should be ${EXPECTED_SCOPE}/${shortName})`);
        errors++;
      }
      if (!isPublishable(shortName) && fullMatch.startsWith(EXPECTED_SCOPE)) {
        console.error(`  ERROR: turbo.json has ${fullMatch} (non-publishable — should be ${OLD_SCOPE}/${shortName})`);
        errors++;
      }
    }
  }

  // NOTE: tsconfig.json files are not checked — they reference
  // @opendaw/typescript-config which is non-publishable and correct.

  // Check root package.json scripts — publishable refs should be @moises-ai,
  // non-publishable should be @opendaw
  console.log("Checking root package.json scripts...");
  const rootPkg = JSON.parse(
    fs.readFileSync(path.join(rootDir, "package.json"), "utf8")
  );
  if (rootPkg.scripts) {
    for (const [key, value] of Object.entries(rootPkg.scripts)) {
      if (typeof value === "string") {
        const scriptMatches = value.matchAll(/@(?:opendaw|moises-ai)\/([\w-]+)/g);
        for (const match of scriptMatches) {
          const fullMatch = match[0];
          const shortName = match[1];
          if (isPublishable(shortName) && fullMatch.startsWith(OLD_SCOPE)) {
            console.error(`  ERROR: package.json script "${key}" has ${fullMatch} (publishable — should be ${EXPECTED_SCOPE}/${shortName})`);
            errors++;
          }
          if (!isPublishable(shortName) && fullMatch.startsWith(EXPECTED_SCOPE)) {
            console.error(`  ERROR: package.json script "${key}" has ${fullMatch} (non-publishable — should be ${OLD_SCOPE}/${shortName})`);
            errors++;
          }
        }
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
    console.log(`  ✓ Publishable packages have ${EXPECTED_SCOPE} scope`);
    console.log(`  ✓ Non-publishable packages have ${OLD_SCOPE} scope`);
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
