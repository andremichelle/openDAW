import {defineConfig} from "vite"

// Cross-origin isolation enables SharedArrayBuffer (shared memory + assets). Set directly — no plugin.
const headers = {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "cross-origin"
}

export default defineConfig({
    // The perf render worker dynamically imports the studio EngineProcessor (code-splitting), which needs the ES
    // worker format (the default "iife" cannot code-split).
    worker: {format: "es"},
    server: {headers, port: 8080},
    preview: {headers, port: 8080}
})
