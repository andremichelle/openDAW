import {describe, expect, it, vi} from "vitest"
import {AssetTransportChain} from "./AssetTransport"
import {AssetSource} from "./AssetTransport"

describe("AssetTransportChain", () => {
    const createMockSource = (name: string, assets: Map<string, ArrayBuffer>): AssetSource => ({
        name,
        resolve: vi.fn(async (assetId: string) => assets.get(assetId)),
        publish: vi.fn(async () => {}),
    })
    it("resolves from the first source that has the asset", async () => {
        const data = new ArrayBuffer(8)
        const source1 = createMockSource("empty", new Map())
        const source2 = createMockSource("has-it", new Map([["asset-1", data]]))
        const chain = new AssetTransportChain([source1, source2])
        const result = await chain.resolve("asset-1")
        expect(result).toBe(data)
        expect(source1.resolve).toHaveBeenCalledWith("asset-1")
        expect(source2.resolve).toHaveBeenCalledWith("asset-1")
    })
    it("returns undefined when no source has the asset", async () => {
        const source1 = createMockSource("empty1", new Map())
        const source2 = createMockSource("empty2", new Map())
        const chain = new AssetTransportChain([source1, source2])
        const result = await chain.resolve("missing")
        expect(result).toBeUndefined()
    })
    it("publishes to all sources", async () => {
        const source1 = createMockSource("s1", new Map())
        const source2 = createMockSource("s2", new Map())
        const chain = new AssetTransportChain([source1, source2])
        const data = new ArrayBuffer(4)
        const meta = {assetId: "a1", name: "test.wav", sizeBytes: 4, mimeType: "audio/wav", s3Url: undefined}
        await chain.publish("a1", data, meta)
        expect(source1.publish).toHaveBeenCalledWith("a1", data, meta)
        expect(source2.publish).toHaveBeenCalledWith("a1", data, meta)
    })
})
