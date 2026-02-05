import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

try {
    const packageJsonPath = path.resolve(__dirname, '../package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    const version = packageJson.version || '0.0.0';

    let commitHash = 'dev';
    try {
        commitHash = execSync('git rev-parse --short HEAD', { stdio: 'pipe' }).toString().trim();
    } catch (e) {
        // git might not be available
    }

    const date = new Date().toISOString();
    // Format: "v0.0.101-a1b2c3d (2026-02-05T...)"
    // Or closer to original: "v20260205-e649a196" - The original looked like date-hash.
    // I will use a descriptive format.
    const content = `v${version}-${commitHash} [${date}]`;

    const outputPath = path.resolve(__dirname, '../public/version.txt');
    fs.writeFileSync(outputPath, content);

    console.log(`[Build] Generated version.txt: ${content}`);
} catch (error) {
    console.error('[Build] Failed to generate version.txt', error);
    process.exit(1);
}
