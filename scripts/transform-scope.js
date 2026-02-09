#!/usr/bin/env node
/**
 * Transform scope from @opendaw to @moises-ai
 *
 * Only publishable packages are renamed. Non-publishable packages
 * (apps, config, build artifacts, forge infrastructure) keep their
 * @opendaw scope to minimise diff from upstream.
 *
 * This script can be re-run after upstream merges to reapply
 * the scope transformations without manual edits.
 *
 * Usage: node scripts/transform-scope.js [--verify]
 */

const fs = require("fs");
const path = require("path");

const OLD_SCOPE = "@opendaw";
const NEW_SCOPE = "@moises-ai";
const GITHUB_REGISTRY = "https://npm.pkg.github.com";

// Short names (without scope) of packages that should be published.
// Only these get renamed from @opendaw → @moises-ai.
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

/**
 * Return true when the short package name (no scope) is publishable
 */
function isPublishable(shortName) {
  return PUBLISHABLE_PACKAGES.has(shortName);
}

/**
 * Recursively find all package.json files
 */
function findPackageJsonFiles(dir, results = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    // Skip node_modules and dist directories
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
 * Collect all local workspace package names by scanning package.json files.
 * Returns a Set containing every workspace package name (both scoped forms).
 */
function collectWorkspacePackageNames(rootDir) {
  const names = new Set();
  const packageFiles = findPackageJsonFiles(rootDir);
  for (const file of packageFiles) {
    const content = JSON.parse(fs.readFileSync(file, "utf8"));
    if (content.name) {
      names.add(content.name);
      // Add the "other" scoped form so callers can test membership regardless
      // of whether the name has already been transformed or not.
      if (content.name.startsWith(OLD_SCOPE)) {
        names.add(content.name.replace(OLD_SCOPE, NEW_SCOPE));
      }
      if (content.name.startsWith(NEW_SCOPE)) {
        names.add(content.name.replace(NEW_SCOPE, OLD_SCOPE));
      }
    }
  }
  return names;
}

/**
 * Transform a package.json file
 */
function transformPackageJson(filePath, workspacePackageNames) {
  const content = JSON.parse(fs.readFileSync(filePath, "utf8"));
  let modified = false;

  // Transform package name — only publishable packages
  if (content.name && content.name.startsWith(OLD_SCOPE)) {
    const shortName = content.name.replace(OLD_SCOPE + "/", "");
    if (isPublishable(shortName)) {
      content.name = `${NEW_SCOPE}/${shortName}`;
      modified = true;
    }
  }

  // Transform dependencies
  for (const depType of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
  ]) {
    if (content[depType]) {
      const newDeps = {};
      for (const [name, version] of Object.entries(content[depType])) {
        let newName = name;
        let newVersion = version;

        if (name.startsWith(OLD_SCOPE)) {
          const shortName = name.replace(OLD_SCOPE + "/", "");
          const transformedName = `${NEW_SCOPE}/${shortName}`;
          const isLocalPackage = workspacePackageNames.has(name) || workspacePackageNames.has(transformedName);

          if (isLocalPackage && isPublishable(shortName)) {
            // Publishable workspace package → rename scope
            newName = transformedName;
          }

          // Use wildcard version for ALL local workspace packages
          // (both publishable and non-publishable) so npm resolves
          // from the monorepo instead of checking a scoped registry.
          if (isLocalPackage && version !== "*") {
            newVersion = "*";
          }
        }

        if (newName !== name || newVersion !== version) modified = true;
        newDeps[newName] = newVersion;
      }
      content[depType] = newDeps;
    }
  }

  // Update publishConfig for publishable packages
  const currentShortName = content.name
    ? content.name.replace(`${NEW_SCOPE}/`, "").replace(`${OLD_SCOPE}/`, "")
    : "";
  if (isPublishable(currentShortName) && !content.private) {
    const newPublishConfig = {
      registry: GITHUB_REGISTRY,
      access: "public",
    };
    if (JSON.stringify(content.publishConfig) !== JSON.stringify(newPublishConfig)) {
      content.publishConfig = newPublishConfig;
      modified = true;
    }
  }

  if (modified) {
    // Preserve the original indentation (4 spaces based on existing files)
    fs.writeFileSync(filePath, JSON.stringify(content, null, 4) + "\n");
    console.log(`  Updated: ${path.relative(process.cwd(), filePath)}`);
  }

  return modified;
}

/**
 * Transform turbo.json — only rename publishable package references
 */
function transformTurboJson(filePath) {
  let content = fs.readFileSync(filePath, "utf8");
  const original = content;

  // Replace @opendaw/package-name only for publishable packages
  content = content.replace(
    new RegExp(OLD_SCOPE.replace("@", "\\@") + "/([\\w-]+)", "g"),
    (match, packageName) => {
      if (isPublishable(packageName)) {
        return `${NEW_SCOPE}/${packageName}`;
      }
      return match;
    }
  );

  if (content !== original) {
    fs.writeFileSync(filePath, content);
    console.log(`  Updated: ${path.relative(process.cwd(), filePath)}`);
    return true;
  }
  return false;
}

/**
 * Transform lerna.json
 */
function transformLernaJson(filePath) {
  const content = JSON.parse(fs.readFileSync(filePath, "utf8"));
  let modified = false;

  if (
    content.command?.publish?.registry &&
    !content.command.publish.registry.includes("npm.pkg.github.com")
  ) {
    content.command.publish.registry = GITHUB_REGISTRY + "/";
    modified = true;
  }

  if (modified) {
    fs.writeFileSync(filePath, JSON.stringify(content, null, 2) + "\n");
    console.log(`  Updated: ${path.relative(process.cwd(), filePath)}`);
  }

  return modified;
}

/**
 * Transform root package.json scripts — only rename publishable package refs
 */
function transformRootPackageJson(filePath) {
  const content = JSON.parse(fs.readFileSync(filePath, "utf8"));
  let modified = false;

  if (content.scripts) {
    for (const [key, value] of Object.entries(content.scripts)) {
      if (typeof value === "string" && value.includes(OLD_SCOPE)) {
        const newValue = value.replace(
          new RegExp(OLD_SCOPE.replace("@", "\\@") + "/([\\w-]+)", "g"),
          (match, packageName) => {
            if (isPublishable(packageName)) {
              return `${NEW_SCOPE}/${packageName}`;
            }
            return match;
          }
        );
        if (newValue !== value) {
          content.scripts[key] = newValue;
          modified = true;
        }
      }
    }
  }

  if (modified) {
    fs.writeFileSync(filePath, JSON.stringify(content, null, 2) + "\n");
    console.log(`  Updated scripts in: ${path.relative(process.cwd(), filePath)}`);
  }

  return modified;
}

/**
 * Recursively find all TypeScript source files (excluding node_modules)
 */
function findSourceFiles(dir, results = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (
      entry.isDirectory() &&
      !["node_modules", "dist", ".git"].includes(entry.name)
    ) {
      findSourceFiles(fullPath, results);
    } else if (entry.isFile() && (
      entry.name.endsWith(".ts") ||
      entry.name.endsWith(".tsx") ||
      entry.name.endsWith(".js") ||
      entry.name.endsWith(".mjs") ||
      entry.name.endsWith(".html")
    )) {
      results.push(fullPath);
    }
  }

  return results;
}

/**
 * Transform a TypeScript source file (handles imports)
 *
 * Only renames @opendaw/package-name to @moises-ai/package-name when the
 * package is publishable AND a local workspace package. Non-publishable
 * workspace packages and external @opendaw packages are left unchanged.
 */
function transformSourceFile(filePath, workspacePackageNames) {
  let content = fs.readFileSync(filePath, "utf8");
  const original = content;

  content = content.replace(
    new RegExp(OLD_SCOPE.replace("@", "\\@") + "/([\\w-]+)", "g"),
    (match, packageName) => {
      const transformed = `${NEW_SCOPE}/${packageName}`;
      if (workspacePackageNames.has(transformed) && isPublishable(packageName)) {
        return transformed;
      }
      // Not publishable or not a workspace package — keep original scope
      return match;
    }
  );

  if (content !== original) {
    fs.writeFileSync(filePath, content);
    return true;
  }
  return false;
}

async function main() {
  const rootDir = path.resolve(__dirname, "..");

  console.log("\n=== Scope Transformation ===");
  console.log(`  ${OLD_SCOPE} -> ${NEW_SCOPE} (publishable packages only)\n`);

  let totalChanges = 0;

  // Collect workspace package names first so we can use workspace: protocol
  const workspacePackageNames = collectWorkspacePackageNames(rootDir);
  console.log(`Found ${workspacePackageNames.size} workspace packages\n`);

  // Transform all package.json files
  console.log("Processing package.json files...");
  const packageFiles = findPackageJsonFiles(rootDir);

  for (const file of packageFiles) {
    if (transformPackageJson(file, workspacePackageNames)) totalChanges++;
  }

  // Transform root package.json scripts separately (for --filter= args)
  const rootPackageJson = path.join(rootDir, "package.json");
  if (transformRootPackageJson(rootPackageJson)) totalChanges++;

  // Transform turbo.json
  console.log("\nProcessing turbo.json...");
  const turboPath = path.join(rootDir, "turbo.json");
  if (fs.existsSync(turboPath)) {
    if (transformTurboJson(turboPath)) totalChanges++;
  }

  // Transform lerna.json
  console.log("\nProcessing lerna.json...");
  const lernaPath = path.join(rootDir, "lerna.json");
  if (fs.existsSync(lernaPath)) {
    if (transformLernaJson(lernaPath)) totalChanges++;
  }

  // NOTE: tsconfig.json files are NOT transformed.
  // They reference @opendaw/typescript-config which is non-publishable
  // and stays as @opendaw.

  // Transform TypeScript source files
  console.log("\nProcessing TypeScript source files...");
  const packagesDir = path.join(rootDir, "packages");
  const sourceFiles = findSourceFiles(packagesDir);
  let sourceFilesUpdated = 0;
  for (const file of sourceFiles) {
    if (transformSourceFile(file, workspacePackageNames)) sourceFilesUpdated++;
  }
  console.log(`  Updated ${sourceFilesUpdated} source files`);
  totalChanges += sourceFilesUpdated;

  // Write marker file
  const markerPath = path.join(rootDir, ".moises-scope-applied");
  fs.writeFileSync(
    markerPath,
    `Scope transformation applied: ${new Date().toISOString()}\n` +
      `Old scope: ${OLD_SCOPE}\n` +
      `New scope: ${NEW_SCOPE}\n`
  );

  console.log(
    `\n${totalChanges > 0 ? totalChanges + " files updated" : "All files already transformed"}`
  );
  console.log("Scope transformation complete!\n");
  console.log("Next steps:");
  console.log("  1. Run: npm install");
  console.log("  2. Run: npm run build");
  console.log("  3. Run: npm run verify-scope");
  console.log("");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
