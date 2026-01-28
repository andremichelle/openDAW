import {defineConfig} from "vite"
import crossOriginIsolation from "vite-plugin-cross-origin-isolation"
import {readFileSync} from "fs"
import {resolve} from "path"

export default defineConfig(({command}) => ({
    server: {
        port: 8081,
        host: "localhost",
        https: command === "serve" ? {
            key: readFileSync(resolve(__dirname, "../../../certs/localhost-key.pem")),
            cert: readFileSync(resolve(__dirname, "../../../certs/localhost.pem"))
        } : undefined,
        headers: {
            "Cross-Origin-Opener-Policy": "same-origin",
            "Cross-Origin-Embedder-Policy": "require-corp"
        },
        fs: {
            allow: [".."]
        }
    },
    plugins: [
        crossOriginIsolation()
    ]
}))
