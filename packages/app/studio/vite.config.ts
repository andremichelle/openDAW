import {cpSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync} from "fs"
import {brotliCompressSync} from "zlib"
import {createRequire} from "module"
import {createHash} from "crypto"
import {extname, relative, resolve} from "path"
import {defineConfig} from "vite"
import {buildSync} from "esbuild"
import crossOriginIsolation from "vite-plugin-cross-origin-isolation"
import viteCompression from "vite-plugin-compression"
import {BuildInfo} from "./src/BuildInfo"
import {existsSync} from "node:fs"

// Minimum desktop shell API (SHELL_API in packages/app/desktop) the desktop build needs
const DESKTOP_SHELL_API = 1

export default defineConfig(({command, mode}) => {
    const uuid = generateUUID()
    console.debug(uuid)

    const env = process.env.NODE_ENV as BuildInfo["env"]
    const date = Date.now()
    const certsExist = existsSync(resolve(__dirname, "../../../certs/localhost-key.pem"))
        && existsSync(resolve(__dirname, "../../../certs/localhost.pem"))

    // Determine base path for production CI builds
    const isCI = process.env.CI === "true"
    const desktop = mode === "desktop"
    const branchName = process.env.BRANCH_NAME || "main"
    const envFolder = process.env.DEPLOY_ENV || (branchName === "main" ? "main" : "dev")
    const base = (command === "build" && isCI && !desktop) ? `/${envFolder}/releases/${uuid}/` : "/"

    return {
        base,
        define: {
            "import.meta.env.BUILD_UUID": JSON.stringify(uuid),
            // the desktop shell serves WCLAP plugin files on its plugin-only port (PLUGIN_PORT in wclap.rs)
            ...(desktop ? {
                "import.meta.env.VITE_WCLAP_ORIGIN": JSON.stringify("http://127.0.0.1:47111"),
                "import.meta.env.VITE_WCLAP_FRAME_QUERY": JSON.stringify("?host=shell"),
                "import.meta.env.VITE_SHARE_ORIGIN": JSON.stringify("https://opendaw.studio")
            } : {})
        },
        resolve: {
            alias: {
                "@": resolve(__dirname, "./src")
            }
        },
        optimizeDeps: {
            exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util", "monaco-editor", "onnxruntime-web",
                "@opendaw/studio-icons", "@opendaw/studio-markdown", "@opendaw/studio-scrollbars"]
        },
        build: {
            target: "esnext",
            minify: true,
            sourcemap: true,
            modulePreload: false, // Disable modulepreload polyfill injection
            outDir: desktop ? "dist-desktop" : "dist",
            rollupOptions: {
                input: {
                    main: resolve(__dirname, "index.html"),
                    "overlay-preview": resolve(__dirname, "overlay-preview.html")
                },
                output: {
                    format: "es",
                    entryFileNames: `[name].${uuid}.js`,
                    chunkFileNames: `[name].${uuid}.js`,
                    assetFileNames: `[name].${uuid}.[ext]`
                }
            }
        },
        esbuild: {
            target: "esnext"
        },
        clearScreen: false,
        server: {
            port: 8080,
            host: certsExist ? true : "localhost", // network-reachable only over HTTPS
            https: command === "serve" && certsExist ? {
                key: readFileSync(resolve(__dirname, "../../../certs/localhost-key.pem")),
                cert: readFileSync(resolve(__dirname, "../../../certs/localhost.pem"))
            } : undefined,
            headers: {
                "Cross-Origin-Opener-Policy": "same-origin",
                "Cross-Origin-Embedder-Policy": "require-corp",
                "Cross-Origin-Resource-Policy": "cross-origin"
            },
            fs: {
                // Allow serving files from the entire workspace
                allow: [resolve(__dirname, "../../../")]
            },
            proxy: {
                "/manuals": {target: `${certsExist ? "https" : "http"}://localhost:8081`, secure: false}
            },
            hmr: {
                overlay: false
            }
        },
        preview: {
            port: 8080,
            host: "localhost",
            https: certsExist ? {
                key: readFileSync(resolve(__dirname, "../../../certs/localhost-key.pem")),
                cert: readFileSync(resolve(__dirname, "../../../certs/localhost.pem"))
            } : undefined,
            headers: {
                "Cross-Origin-Opener-Policy": "same-origin",
                "Cross-Origin-Embedder-Policy": "require-corp",
                "Cross-Origin-Resource-Policy": "cross-origin"
            }
        },
        plugins: [
            ...(desktop ? [{
                name: "desktop-entry",
                transformIndexHtml: {
                    order: "pre" as const,
                    handler: (html: string) => html.replace(`src="/src/main.ts"`, `src="/src/main-desktop.ts"`)
                }
            }] : []),
            crossOriginIsolation(),
            viteCompression({
                algorithm: "brotliCompress",
                filter: isCompressible
            }),
            {
                name: "generate-date-json",
                buildStart() {
                    const outputPath = resolve(__dirname, "public", "build-info.json")
                    const info: BuildInfo = desktop ? {date, uuid, env, shellApi: DESKTOP_SHELL_API} : {date, uuid, env}
                    writeFileSync(outputPath, JSON.stringify(info, null, 2))
                    console.debug(`Build info written to: ${outputPath}`)
                }
            },
            ...(desktop ? [{
                name: "desktop-components",
                async writeBundle() {
                    const outDir = resolve(__dirname, "dist-desktop")
                    await copyFFmpeg(resolve(outDir, "ffmpeg"))
                    for (const [source, target] of [["../manual/dist", "manuals"], ["../../studio/docs/scripting", "docs/scripting"],
                        ["../desktop/devices/dist", "wasm-engine/wasm/desktop"]]) {
                        const from = resolve(__dirname, source)
                        if (existsSync(from)) {
                            cpSync(from, resolve(outDir, target), {recursive: true})
                        } else {
                            console.warn(`desktop build without ${target}: ${from} is missing (build it first)`)
                        }
                    }
                }
            }, {
                name: "desktop-manifest",
                async closeBundle() {
                    const outDir = resolve(__dirname, "dist-desktop")
                    // the native engine process runs this next to the unchanged wasm-processor bundle
                    buildSync({
                        entryPoints: [resolve(__dirname, "src/platform/desktop/engine/EngineHost.ts")],
                        outfile: resolve(outDir, "engine-host.js"),
                        bundle: true, format: "iife", platform: "neutral", mainFields: ["module", "main"], minify: true, logLevel: "warning"
                    })
                    const walk = (dir: string): ReadonlyArray<string> =>
                        readdirSync(dir, {withFileTypes: true}).filter(entry => !entry.name.startsWith(".")).flatMap(entry => entry.isDirectory()
                            ? walk(resolve(dir, entry.name)) : [resolve(dir, entry.name)])
                    const files = walk(outDir)
                        .map(file => relative(outDir, file).split("\\").join("/"))
                        .filter(path => !path.endsWith(".map") && !path.endsWith(".br") && path !== "manifest.json")
                        .sort()
                        .map(path => {
                            const bytes = readFileSync(resolve(outDir, path))
                            return {path, size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex")}
                        })
                    // the compression plugin also runs in closeBundle; wait for every .br it is going to write
                    const expected = files.filter(({path, size}) => isCompressible(path) && size > CompressionThreshold)
                    for (let attempt = 0; attempt < 600 && !expected.every(({path}) => existsSync(resolve(outDir, `${path}.br`))); attempt++) {
                        await new Promise(resolve => setTimeout(resolve, 100))
                    }
                    // the server answers with the .br file where one exists, so that is what the shell downloads
                    const entries = files.map(entry => {
                        const compressed = resolve(outDir, `${entry.path}.br`)
                        const download = existsSync(compressed) ? statSync(compressed).size : entry.size
                        const component = componentOf(entry.path)
                        return component === undefined ? {...entry, download} : {...entry, download, component}
                    })
                    const components = DesktopComponents.map(component => component.name === "neural" ? {...component, models: neuralModels()} : component)
                    const manifest: DesktopManifest = {uuid, date, shellApi: DESKTOP_SHELL_API, components, files: entries}
                    writeFileSync(resolve(outDir, "manifest.json"), JSON.stringify(manifest, null, 2))
                    console.debug(`Desktop manifest written with ${files.length} files`)
                }
            }] : []),
            {
                // The WASM engine binaries (built by @opendaw/studio-core-wasm's build-wasm.sh into its
                // dist/wasm/) served under /wasm-engine/: live from the package dist in dev (so a Rust rebuild
                // is picked up without restarting), copied into the bundle at build. When they are absent
                // (e.g. a CI runner without the Rust toolchain) the studio still builds; the engine toggle
                // then reports the WASM engine as unavailable.
                name: "wasm-engine-assets",
                configureServer(server) {
                    const sourceDir = resolve(__dirname, "../../studio/core-wasm/dist")
                    server.middlewares.use("/wasm-engine", (req, res, next) => {
                        const name = (req.url ?? "").split("?")[0].replace(/^\//, "")
                        const file = resolve(sourceDir, name)
                        if (!isWasmEngineAsset(name) || !existsSync(file)) {return next()}
                        res.setHeader("Content-Type", "application/wasm")
                        res.setHeader("Cache-Control", "no-store") // a Rust rebuild must never be shadowed by a cached wasm
                        res.end(readFileSync(file))
                    })
                },
                generateBundle() {
                    const sourceDir = resolve(__dirname, "../../studio/core-wasm/dist")
                    if (!existsSync(resolve(sourceDir, "wasm"))) {
                        console.warn("wasm-engine-assets: no artifacts found, skipping")
                        return
                    }
                    const walk = (relative: string): ReadonlyArray<string> =>
                        readdirSync(resolve(sourceDir, relative), {withFileTypes: true}).flatMap(entry =>
                            entry.isDirectory() ? walk(`${relative}/${entry.name}`) : [`${relative}/${entry.name}`])
                    walk("wasm").filter(isWasmEngineAsset).forEach(name => this.emitFile({
                        type: "asset",
                        fileName: `wasm-engine/${name}`,
                        source: readFileSync(resolve(sourceDir, name))
                    }))
                }
            },
            {
                // The generated scripting docs live in packages/studio/docs, deployed as their own folder
                name: "scripting-docs",
                configureServer(server) {
                    const docsDir = resolve(__dirname, "../../studio/docs")
                    const types: Record<string, string> = {
                        ".html": "text/html; charset=utf-8",
                        ".js": "text/javascript",
                        ".css": "text/css",
                        ".json": "application/json",
                        ".svg": "image/svg+xml",
                        ".png": "image/png",
                        ".woff2": "font/woff2"
                    }
                    server.middlewares.use((request, response, next) => {
                        const url = (request.url ?? "").split("?")[0]
                        if (!url.startsWith("/docs/")) {return next()}
                        const path = resolve(docsDir, decodeURIComponent(url.slice("/docs/".length)))
                        if (!path.startsWith(docsDir) || !existsSync(path)) {return next()}
                        const file = statSync(path).isDirectory() ? resolve(path, "index.html") : path
                        if (!existsSync(file)) {return next()}
                        response.setHeader("Content-Type", types[extname(file)] ?? "application/octet-stream")
                        response.end(readFileSync(file))
                    })
                }
            },
            {
                name: "spa",
                configureServer(server) {
                    server.middlewares.use((req, res, next) => {
                        const url: string | undefined = req.url
                        if (url !== undefined && url.startsWith("/manuals")) {return next()}
                        if (url !== undefined && url.indexOf(".") === -1 && !url.startsWith("/@vite/")) {
                            if (url === "/overlay-preview") {
                                const previewPath = resolve(__dirname, "overlay-preview.html")
                                res.end(readFileSync(previewPath))
                            } else {
                                const indexPath = resolve(__dirname, "index.html")
                                res.end(readFileSync(indexPath))
                            }
                        } else {
                            next()
                        }
                    })
                }
            }
        ]
    }
})

type DesktopModel = { path: string, url: string, sha256: string, bytes: number }
type DesktopComponent = { name: string, label: string, description: string, selected: boolean, models?: ReadonlyArray<DesktopModel> }

type DesktopManifest = {
    uuid: string
    date: number
    shellApi: number
    components: ReadonlyArray<DesktopComponent>
    files: ReadonlyArray<{ path: string, size: number, sha256: string, download: number, component?: string }>
}

// Optional parts of the desktop build: the installer lists them, the shell downloads only the chosen ones
// and offers the others when they are first used. Neural Demux also downloads its models, from their own URLs.
const DesktopComponents: ReadonlyArray<DesktopComponent> = [
    {name: "ffmpeg", label: "FFmpeg", description: "MP3 and FLAC export", selected: true},
    {name: "manuals", label: "Manuals", description: "The built-in help", selected: true},
    {name: "docs", label: "Scripting Documentation", description: "The reference for the scripting API", selected: true},
    {name: "neural", label: "Neural Demux", description: "AI stem separation and tempo detection", selected: false}
]

// Neural Demux's models, read from lib-inference's task registry (bundled for node, its dist does not load in node)
const neuralModels = (): ReadonlyArray<DesktopModel> => {
    const {outputFiles: [output]} = buildSync({
        entryPoints: [resolve(__dirname, "../../lib/inference/src/registry.ts")],
        bundle: true, write: false, format: "cjs", platform: "node", logLevel: "warning"
    })
    const module: { exports: { TaskRegistry?: Record<string, { model: { url: string, sha256: string, bytes: number, version: string } }> } } = {exports: {}}
    new Function("module", "exports", "require", output.text)(module, module.exports, createRequire(import.meta.url))
    return Object.entries(module.exports.TaskRegistry ?? {}).map(([taskKey, {model}]) =>
        ({path: `${taskKey}/${model.version}/model.onnx`, url: model.url, sha256: model.sha256, bytes: model.bytes}))
}

const componentOf = (file: string): string | undefined =>
    /ort-wasm.*\.wasm$/i.test(file) ? "neural"
        : file.startsWith("ffmpeg/") ? "ffmpeg"
            : file.startsWith("manuals/") ? "manuals"
                : file.startsWith("docs/") ? "docs" : undefined

// @ffmpeg/core 0.12.6 (dist/esm), mirrored on package.opendaw.studio; fetched once into .cache, pinned by sha256
const FFmpegCore = {
    version: "0.12.6",
    files: [
        {name: "ffmpeg-core.js", sha256: "c972f5abeafcd5f3949e54edfbdc74a9badb27025809feb1945d468ffbcfb7f1"},
        {name: "ffmpeg-core.wasm", sha256: "2390efa7fb66e7e42dbae15427571a5ffc96b829480904c30f471f0a78967f61"}
    ]
}

const copyFFmpeg = async (target: string): Promise<void> => {
    const cache = resolve(__dirname, ".cache", `ffmpeg-${FFmpegCore.version}`)
    mkdirSync(cache, {recursive: true})
    mkdirSync(target, {recursive: true})
    for (const {name, sha256} of FFmpegCore.files) {
        const file = resolve(cache, name)
        if (!existsSync(file) || createHash("sha256").update(readFileSync(file)).digest("hex") !== sha256) {
            const response = await fetch(`https://package.opendaw.studio/${name}`)
            const bytes = Buffer.from(await response.arrayBuffer())
            if (!response.ok || createHash("sha256").update(bytes).digest("hex") !== sha256) {
                throw new Error(`FFmpeg core ${name} could not be fetched or does not match its sha256`)
            }
            writeFileSync(file, bytes)
        }
        // the wasm is too large to brotli at every build, so its .br is made once and kept in the cache
        if (name.endsWith(".wasm") && !existsSync(`${file}.br`)) {writeFileSync(`${file}.br`, brotliCompressSync(readFileSync(file)))}
        cpSync(file, resolve(target, name))
        if (existsSync(`${file}.br`)) {cpSync(`${file}.br`, resolve(target, `${name}.br`))}
    }
}

// the onnx runtime (Neural Demux) is left out, too large to brotli at every build; the ffmpeg wasm brings its own .br
const isCompressible = (file: string): boolean => /\.(js|mjs|json|css|html|wasm)$/i.test(file)
    && !/ort-wasm.*\.wasm$/i.test(file) && !/ffmpeg-core\.wasm$/i.test(file)
// vite-plugin-compression skips files up to this size
const CompressionThreshold = 1025

// The artifacts live under public/wasm/ (engine.wasm + sine.wasm) and public/wasm/plugins/ (device_*.wasm).
const isWasmEngineAsset = (name: string): boolean =>
    name.startsWith("wasm/") && name.endsWith(".wasm") && !name.includes("..")

const generateUUID = () => {
    const format = crypto.getRandomValues(new Uint8Array(16))
    format[6] = (format[6] & 0x0f) | 0x40 // Version 4 (random)
    format[8] = (format[8] & 0x3f) | 0x80 // Variant 10xx for UUID
    const hex: string[] = []
    for (let i = 0; i < 256; i++) {hex[i] = (i + 0x100).toString(16).substring(1)}
    return hex[format[0]] + hex[format[1]] +
        hex[format[2]] + hex[format[3]] + "-" +
        hex[format[4]] + hex[format[5]] + "-" +
        hex[format[6]] + hex[format[7]] + "-" +
        hex[format[8]] + hex[format[9]] + "-" +
        hex[format[10]] + hex[format[11]] +
        hex[format[12]] + hex[format[13]] +
        hex[format[14]] + hex[format[15]]
}