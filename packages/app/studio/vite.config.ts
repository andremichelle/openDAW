import {readdirSync, readFileSync, writeFileSync} from "fs"
import {resolve} from "path"
import {defineConfig} from "vite"
import crossOriginIsolation from "vite-plugin-cross-origin-isolation"
import viteCompression from "vite-plugin-compression"
import {BuildInfo} from "./src/BuildInfo"
import {existsSync} from "node:fs"

export default defineConfig(({command}) => {
    const uuid = generateUUID()
    console.debug(uuid)

    const env = process.env.NODE_ENV as BuildInfo["env"]
    const date = Date.now()
    const certsExist = existsSync(resolve(__dirname, "../../../certs/localhost-key.pem"))

    // Determine base path for production CI builds
    const isCI = process.env.CI === "true"
    const branchName = process.env.BRANCH_NAME || "main"
    const isMainBranch = branchName === "main"
    const envFolder = isMainBranch ? "main" : "dev"
    const base = (command === "build" && isCI) ? `/${envFolder}/releases/${uuid}/` : "/"

    return {
        base,
        define: {
            "import.meta.env.BUILD_UUID": JSON.stringify(uuid)
        },
        resolve: {
            alias: {
                "@": resolve(__dirname, "./src")
            }
        },
        optimizeDeps: {
            exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util", "monaco-editor", "onnxruntime-web"]
        },
        build: {
            target: "esnext",
            minify: true,
            sourcemap: true,
            modulePreload: false, // Disable modulepreload polyfill injection
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
            host: "localhost",
            https: command === "serve" ? {
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
            crossOriginIsolation(),
            viteCompression({
                algorithm: "brotliCompress"
            }),
            {
                name: "generate-date-json",
                buildStart() {
                    const outputPath = resolve(__dirname, "public", "build-info.json")
                    writeFileSync(outputPath, JSON.stringify({date, uuid, env} satisfies BuildInfo, null, 2))
                    console.debug(`Build info written to: ${outputPath}`)
                }
            },
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
                name: "spa",
                configureServer(server) {
                    server.middlewares.use((req, res, next) => {
                        const url: string | undefined = req.url
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