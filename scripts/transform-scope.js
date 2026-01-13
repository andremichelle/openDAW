#!/usr/bin/env node
/**
 * Transform scope from @opendaw to @moises-ai
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

// Packages that should be published (not private)
const PUBLISHABLE_PACKAGES = new Set([
  "@moises-ai/lib-std",
  "@moises-ai/lib-runtime",
  "@moises-ai/lib-box",
  "@moises-ai/lib-dom",
  "@moises-ai/lib-dsp",
  "@moises-ai/lib-fusion",
  "@moises-ai/lib-jsx",
  "@moises-ai/lib-midi",
  "@moises-ai/lib-xml",
  "@moises-ai/lib-dawproject",
  "@moises-ai/studio-sdk",
  "@moises-ai/studio-core",
  "@moises-ai/studio-adapters",
  "@moises-ai/studio-boxes",
  "@moises-ai/studio-enums",
  "@moises-ai/studio-scripting",
]);

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
 * Transform a package.json file
 */
function transformPackageJson(filePath) {
  const content = JSON.parse(fs.readFileSync(filePath, "utf8"));
  let modified = false;

  // Transform package name
  if (content.name && content.name.startsWith(OLD_SCOPE)) {
    content.name = content.name.replace(OLD_SCOPE, NEW_SCOPE);
    modified = true;
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
        const newName = name.startsWith(OLD_SCOPE)
          ? name.replace(OLD_SCOPE, NEW_SCOPE)
          : name;
        newDeps[newName] = version;
        if (newName !== name) modified = true;
      }
      content[depType] = newDeps;
    }
  }

  // Update publishConfig for publishable packages
  if (PUBLISHABLE_PACKAGES.has(content.name) && !content.private) {
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
 * Transform turbo.json
 */
function transformTurboJson(filePath) {
  let content = fs.readFileSync(filePath, "utf8");
  const original = content;

  // Replace all @opendaw references
  content = content.replace(new RegExp(OLD_SCOPE.replace("@", "\\@"), "g"), NEW_SCOPE);

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
 * Transform root package.json scripts
 */
function transformRootPackageJson(filePath) {
  const content = JSON.parse(fs.readFileSync(filePath, "utf8"));
  let modified = false;

  if (content.scripts) {
    for (const [key, value] of Object.entries(content.scripts)) {
      if (typeof value === "string" && value.includes(OLD_SCOPE)) {
        content.scripts[key] = value.replace(
          new RegExp(OLD_SCOPE.replace("@", "\\@"), "g"),
          NEW_SCOPE
        );
        modified = true;
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
 * Recursively find all tsconfig*.json files (excluding node_modules)
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

/**
 * Transform a tsconfig.json file (handles extends field)
 */
function transformTsconfigJson(filePath) {
  let content = fs.readFileSync(filePath, "utf8");
  const original = content;

  // Replace @opendaw references (typically in "extends" field)
  content = content.replace(new RegExp(OLD_SCOPE.replace("@", "\\@"), "g"), NEW_SCOPE);

  if (content !== original) {
    fs.writeFileSync(filePath, content);
    console.log(`  Updated: ${path.relative(process.cwd(), filePath)}`);
    return true;
  }
  return false;
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
 */
function transformSourceFile(filePath) {
  let content = fs.readFileSync(filePath, "utf8");
  const original = content;

  // Replace @opendaw references in import statements
  content = content.replace(new RegExp(OLD_SCOPE.replace("@", "\\@"), "g"), NEW_SCOPE);

  if (content !== original) {
    fs.writeFileSync(filePath, content);
    return true;
  }
  return false;
}

async function main() {
  const rootDir = path.resolve(__dirname, "..");

  console.log("\n=== Scope Transformation ===");
  console.log(`  ${OLD_SCOPE} -> ${NEW_SCOPE}\n`);

  let totalChanges = 0;

  // Transform all package.json files
  console.log("Processing package.json files...");
  const packageFiles = findPackageJsonFiles(rootDir);

  for (const file of packageFiles) {
    if (transformPackageJson(file)) totalChanges++;
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

  // Transform tsconfig.json files
  console.log("\nProcessing tsconfig.json files...");
  const tsconfigFiles = findTsconfigFiles(rootDir);
  for (const file of tsconfigFiles) {
    if (transformTsconfigJson(file)) totalChanges++;
  }

  // Transform TypeScript source files
  console.log("\nProcessing TypeScript source files...");
  const packagesDir = path.join(rootDir, "packages");
  const sourceFiles = findSourceFiles(packagesDir);
  let sourceFilesUpdated = 0;
  for (const file of sourceFiles) {
    if (transformSourceFile(file)) sourceFilesUpdated++;
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
