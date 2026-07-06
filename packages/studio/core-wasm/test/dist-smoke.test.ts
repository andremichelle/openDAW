// The consumer smoke test: everything a host needs must be present and coherent in dist/ ALONE — the
// published surface. Catches packaging regressions (a missing artifact, a stray relative import escaping
// the package, a device table entry without its built plugin) before publish.
import {describe, expect, it, vi} from "vitest"
import * as path from "node:path"
import {existsSync, readFileSync} from "node:fs"

const dist = path.resolve(__dirname, "../dist")
// dist/index.js reaches @opendaw/studio-core, which touches DOM globals at module scope; node has none.
vi.stubGlobal("AudioWorkletNode", class {})

describe("dist smoke", () => {
    it("ships the api, the prebuilt bundles and the binaries", () => {
        for (const file of ["index.js", "index.d.ts", "wasm-processor.js", "wasm-offline-worker.js", "wasm/engine.wasm"]) {
            expect(existsSync(path.join(dist, file)), file).toBe(true)
        }
    })
    it("main-thread api resolves from dist alone", async () => {
        const api = await import(path.join(dist, "index.js"))
        expect(typeof api.WasmEngine.install).toBe("function")
        expect(typeof api.loadEngineModules).toBe("function")
    })
    it("every device table entry has its built plugin (and vice versa)", async () => {
        const {DEVICES} = await import(path.join(dist, "index.js"))
        const tableFiles = DEVICES.map((device: { url: string }) => path.basename(device.url)).sort()
        const {readdirSync} = await import("node:fs")
        const builtFiles = readdirSync(path.join(dist, "wasm/plugins")).filter(name => name.endsWith(".wasm")).sort()
        expect(builtFiles).toEqual(tableFiles)
    })
    it("the worklet bundle registers the processor and shims the scope first", () => {
        const source = readFileSync(path.join(dist, "wasm-processor.js"), "utf8")
        expect(source).toContain("engine-wasm-processor")
        expect(source.indexOf("self??=globalThis")).toBeGreaterThanOrEqual(0)
        expect(source.indexOf("self??=globalThis")).toBeLessThan(source.indexOf("registerProcessor"))
        // Unguarded module-scope TextDecoder construction kills the worklet before registerProcessor
        // (AudioWorkletGlobalScope has none). Guarded `typeof TextDecoder` usage (Emscripten glue) is fine.
        expect(source).not.toMatch(/(?<!typeof TextDecoder<"u"\?)new TextDecoder/)
    })
    it("the engine binary compiles", async () => {
        const bytes = readFileSync(path.join(dist, "wasm/engine.wasm"))
        const module = await WebAssembly.compile(bytes)
        expect(WebAssembly.Module.exports(module).some(entry => entry.name === "render")).toBe(true)
    })
})
