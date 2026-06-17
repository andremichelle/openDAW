import {defineConfig} from "vitest/config"

// Parity harness runs in node (loads wasm + reads built artifacts; no DOM needed). Kept off the
// default `turbo test` run via the `test:parity` script so the main test suite stays Rust-free.
export default defineConfig({
    test: {
        globals: true,
        environment: "node",
        include: ["src/**/*.test.ts"]
    },
    esbuild: {
        target: "ESNext"
    }
})
