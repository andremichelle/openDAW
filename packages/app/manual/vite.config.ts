import {existsSync, readdirSync, readFileSync, statSync, writeFileSync} from "node:fs"
import {relative, resolve} from "node:path"
import {defineConfig, Plugin} from "vite"
import viteCompression from "vite-plugin-compression"
import markdownit from "markdown-it"
import {markdownItTable} from "markdown-it-table"
import {Prerender} from "./src/Prerender"

const markdownFiles = (directory: string): ReadonlyArray<string> => readdirSync(directory).flatMap(name => {
    const path = resolve(directory, name)
    return statSync(path).isDirectory() ? markdownFiles(path) : name.endsWith(".md") ? [path] : []
})

// writeBundle runs before the compression plugin's closeBundle, so every page also gets its .br
const prerenderPages = (): Plugin => ({
    name: "opendaw-prerender-manuals",
    apply: "build",
    writeBundle: () => {
        const source = resolve(__dirname, "public")
        const target = resolve(__dirname, "dist")
        const template = readFileSync(resolve(target, "index.html"), "utf8")
        const markdown = markdownit({html: false, linkify: true}).use(markdownItTable)
        markdownFiles(source).forEach(file => {
            const path = relative(source, file).replaceAll("\\", "/").replace(/\.md$/, "")
            const page = path === "index" ? "" : path
            const html = Prerender.page(template, {path: page, markdown: readFileSync(file, "utf8")}, text => markdown.render(text))
            writeFileSync(resolve(target, page === "" ? "index.html" : `${page}.html`), html)
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
        prerenderPages(),
        viteCompression({algorithm: "brotliCompress"})
    ]
}))
