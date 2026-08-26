import {defineConfig} from "vitest/config"
import {fileURLToPath} from "node:url"

// Unit tests for the studio app. Node environment — app tests should exercise pure logic, not the DOM. The `@/`
// alias mirrors tsconfig so tests can import app modules by their usual path.
export default defineConfig({
    resolve: {
        alias: {"@": fileURLToPath(new URL("./src", import.meta.url))}
    },
    test: {
        globals: true,
        environment: "node",
        include: ["src/**/*.test.ts"]
    },
    esbuild: {
        target: "ESNext"
    }
})
