import {describe, expect, it} from "vitest"
import {WclapBundles} from "./WclapBundles"

describe("WclapBundles", () => {
    it("takes a bare wasm module as a bundle holding only module.wasm", async () => {
        const wasm = new Uint8Array([0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00])
        const bundle = await WclapBundles.register("test://bare", wasm.buffer)
        expect(bundle.files.map(({path}) => path)).toEqual(["module.wasm"])
        expect(Array.from(bundle.files[0].bytes)).toEqual(Array.from(wasm))
    })
    it("tells a wasm module from an archive", () => {
        expect(WclapBundles.isWasm(new Uint8Array([0x00, 0x61, 0x73, 0x6D]).buffer)).toBe(true)
        expect(WclapBundles.isWasm(new Uint8Array([0x1F, 0x8B, 0x08, 0x00]).buffer)).toBe(false)
        expect(WclapBundles.isWasm(new Uint8Array([0x00]).buffer)).toBe(false)
    })
})
