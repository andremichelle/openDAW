import {defineConfig} from "vite"

// Cross-origin isolation enables SharedArrayBuffer (shared memory + assets). Set directly — no plugin.
const headers = {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "cross-origin"
}

export default defineConfig({
    server: {headers, port: 8080},
    preview: {headers, port: 8080}
})
