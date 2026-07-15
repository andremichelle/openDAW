import {defineConfig} from "vite"
import crossOriginIsolation from "vite-plugin-cross-origin-isolation"
import {readFileSync} from "fs"
import {resolve} from "path"

const repoRoot = resolve(__dirname, "../../..")

export default defineConfig(({command}) => ({
    server: {
        port: 8082,
        host: "localhost",
        https: command === "serve" ? {
            key: readFileSync(resolve(repoRoot, "certs/localhost-key.pem")),
            cert: readFileSync(resolve(repoRoot, "certs/localhost.pem"))
        } : undefined,
        headers: {
            "Cross-Origin-Opener-Policy": "same-origin",
            "Cross-Origin-Embedder-Policy": "require-corp"
        },
        fs: {
            // Serve the repo-root test-files/ (WAV + .asd) via /@fs
            allow: [repoRoot]
        }
    },
    plugins: [
        crossOriginIsolation()
    ]
}))
