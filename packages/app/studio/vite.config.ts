/// <reference path="./src/vite-plugin-cross-origin-isolation.d.ts" />
import { readFileSync, writeFileSync } from "fs"
import { resolve } from "path"
import { defineConfig } from "vite"
import crossOriginIsolation from "vite-plugin-cross-origin-isolation"
import viteCompression from "vite-plugin-compression"
import { BuildInfo } from "./src/BuildInfo"
import { existsSync } from "node:fs"
import { execSync } from "child_process"

export default defineConfig(({ command }) => {
    let gitHash = "dev"
    try {
        gitHash = execSync("git rev-parse --short HEAD").toString().trim()
    } catch (e) {
        console.warn("Failed to get git hash", e)
    }
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "")
    const uuid = `v${dateStr}-${gitHash}`
    console.debug(`Build Version: ${uuid}`)

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
        resolve: {
            alias: {
                "@": resolve(__dirname, "./src")
            }
        },
        optimizeDeps: {
            exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util", "monaco-editor"]
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
            },
            // Ollama Proxy: Bypass CORS for local LLM
            proxy: {
                "/api/ollama": {
                    target: "http://localhost:11434",
                    changeOrigin: true,
                    rewrite: (path) => path.replace(/^\/api\/ollama/, ""),
                    configure: (proxy, _options) => {
                        proxy.on("proxyRes", (proxyRes) => {
                            proxyRes.headers["Access-Control-Allow-Origin"] = "*"
                        })
                    }
                }
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
                    writeFileSync(outputPath, JSON.stringify({ date, uuid, env } satisfies BuildInfo, null, 2))
                    writeFileSync(resolve(__dirname, "public", "version.txt"), uuid)
                    console.debug(`Build info written to: ${outputPath}`)
                }
            },
            {
                name: "spa",
                configureServer(server) {
                    server.middlewares.use((req, res, next) => {
                        const url: string | undefined = req.url
                        // Exclude /api/ paths from SPA fallback to allow proxy
                        if (url !== undefined && url.indexOf(".") === -1 && !url.startsWith("/@vite/") && !url.startsWith("/api/")) {
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
