import {existsSync, readdirSync, readFileSync} from "node:fs"
import {extname, relative, resolve} from "node:path"
import {defineConfig, type Plugin} from "vite"
import viteCompression from "vite-plugin-compression"

const manualsContent = resolve(__dirname, "../../manuals/content")

const mimeTypes: Record<string, string> = {
    ".md": "text/markdown; charset=utf-8",
    ".webp": "image/webp",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml"
}

const manualsAssets = (): Plugin => ({
    name: "manuals-assets",
    configureServer(server) {
        server.middlewares.use((req, res, next) => {
            const url = (req.url ?? "").split("?")[0]
            if (!url.startsWith("/manuals/") || url.endsWith("/")) {return next()}
            const relativePath = decodeURIComponent(url.slice("/manuals/".length))
            const file = resolve(manualsContent, relativePath)
            if (!file.startsWith(manualsContent) || !existsSync(file)) {return next()}
            res.setHeader("Content-Type", mimeTypes[extname(file)] ?? "application/octet-stream")
            res.end(readFileSync(file))
        })
    },
    generateBundle() {
        const walk = (dir: string): ReadonlyArray<string> =>
            readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
                const path = resolve(dir, entry.name)
                return entry.isDirectory() ? walk(path) : [path]
            })
        walk(manualsContent).forEach(file => {
            this.emitFile({type: "asset", fileName: relative(manualsContent, file), source: readFileSync(file)})
        })
        this.emitFile({
            type: "asset",
            fileName: ".htaccess",
            source: readFileSync(resolve(__dirname, "public/.htaccess"))
        })
    }
})

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
        exclude: ["@opendaw/studio-icons", "@opendaw/studio-markdown", "@opendaw/manuals"]
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
        manualsAssets(),
        viteCompression({algorithm: "brotliCompress"})
    ]
}))
