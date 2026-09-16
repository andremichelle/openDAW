import {existsSync, readFileSync} from "node:fs"
import {resolve} from "node:path"
import {defineConfig} from "vite"
import viteCompression from "vite-plugin-compression"

export default defineConfig(({command}) => ({
    base: "/manuals/",
    build: {
        target: "esnext",
        minify: true,
        sourcemap: true,
        modulePreload: false
    },
    esbuild: {
        target: "esnext"
    },
    optimizeDeps: {
        exclude: ["@opendaw/studio-icons", "@opendaw/studio-markdown", "@opendaw/studio-scrollbars"]
    },
    clearScreen: false,
    server: {
        port: 8081,
        host: "localhost",
        https: command === "serve" && existsSync(resolve(__dirname, "../../../certs/localhost-key.pem")) ? {
            key: readFileSync(resolve(__dirname, "../../../certs/localhost-key.pem")),
            cert: readFileSync(resolve(__dirname, "../../../certs/localhost.pem"))
        } : undefined,
        fs: {
            allow: [resolve(__dirname, "../../../")]
        }
    },
    preview: {
        port: 8081,
        host: "localhost"
    },
    plugins: [
        viteCompression({algorithm: "brotliCompress"})
    ]
}))
