#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Function to recursively find all TypeScript files
function findTsFiles(dir, baseDir = dir) {
    const files = [];
    const items = fs.readdirSync(dir);

    for (const item of items) {
        const fullPath = path.join(dir, item);
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
            files.push(...findTsFiles(fullPath, baseDir));
        } else if (item.endsWith('.ts') && !item.endsWith('.d.ts') && !item.endsWith('.test.ts') && item !== 'index.ts') {
            const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/').replace('.ts', '');
            files.push(relativePath);
        }
    }

    return files;
}

// Generate the index.ts content
function generateIndex() {
    const srcDir = path.join(__dirname, 'src');
    const files = findTsFiles(srcDir);

    const exports = files
        .sort()
        .map(file => `export * from "./${file}"`)
        .join('\n');

    const content = `// Auto-generated exports - do not edit manually
// Run: node generate-exports.js to regenerate

${exports}
`;

    fs.writeFileSync(path.join(srcDir, 'index.ts'), content);
    console.log(`Generated ${files.length} exports in index.ts`);
}

generateIndex(); 