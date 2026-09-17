import {defineConfig} from "vite"
import crossOriginIsolation from "vite-plugin-cross-origin-isolation"
import {existsSync, readFileSync} from "fs"
import {resolve} from "path"

const certsExist = existsSync(resolve(__dirname, "../../../certs/localhost-key.pem"))

export default defineConfig(({command}) => ({
    server: {
        port: 8080,
        host: "localhost",
        https: command === "serve" && certsExist ? {
            key: readFileSync(resolve(__dirname, "../../../certs/localhost-key.pem")),
            cert: readFileSync(resolve(__dirname, "../../../certs/localhost.pem"))
        } : undefined,
        headers: {
            "Cross-Origin-Opener-Policy": "same-origin",
            "Cross-Origin-Embedder-Policy": "require-corp"
        },
        fs: {
            // Allow serving files from the entire workspace
            allow: [".."]
        }
    },
    plugins: [
        crossOriginIsolation()
    ]
}))