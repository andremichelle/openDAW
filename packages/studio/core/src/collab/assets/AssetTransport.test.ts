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
    it("stops resolution after first successful source", async () => {
        const data1 = new ArrayBuffer(4)
        const data2 = new ArrayBuffer(8)
        const source1 = createMockSource("first", new Map([["asset-1", data1]]))
        const source2 = createMockSource("second", new Map([["asset-1", data2]]))
        const chain = new AssetTransportChain([source1, source2])
        const result = await chain.resolve("asset-1")
        expect(result).toBe(data1)
        expect(source2.resolve).not.toHaveBeenCalled()
    })
    it("returns undefined when no source has the asset", async () => {
        const source1 = createMockSource("empty1", new Map())
        const source2 = createMockSource("empty2", new Map())
        const chain = new AssetTransportChain([source1, source2])
        const result = await chain.resolve("missing")
        expect(result).toBeUndefined()
    })
    it("source that throws during resolve is skipped", async () => {
        const throwingSource: AssetSource = {
            name: "broken",
            resolve: vi.fn(async () => {throw new Error("disk error")}),
            publish: vi.fn(async () => {}),
        }
        const data = new ArrayBuffer(4)
        const goodSource = createMockSource("good", new Map([["asset-1", data]]))
        const chain = new AssetTransportChain([throwingSource, goodSource])
        const result = await chain.resolve("asset-1")
        expect(result).toBe(data)
    })
    it("empty chain returns undefined", async () => {
        const chain = new AssetTransportChain([])
        const result = await chain.resolve("any-id")
        expect(result).toBeUndefined()
    })
    it("sourceNames reflects construction order", () => {
        const s1 = createMockSource("alpha", new Map())
        const s2 = createMockSource("beta", new Map())
        const s3 = createMockSource("gamma", new Map())
        const chain = new AssetTransportChain([s1, s2, s3])
        expect(chain.sourceNames).toEqual(["alpha", "beta", "gamma"])
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
    it("all sources receive publish even if one fails", async () => {
        const failSource: AssetSource = {
            name: "fail",
            resolve: vi.fn(async () => undefined),
            publish: vi.fn(async () => {throw new Error("upload failed")}),
        }
        const goodSource = createMockSource("good", new Map())
        const chain = new AssetTransportChain([failSource, goodSource])
        const data = new ArrayBuffer(4)
        const meta = {assetId: "a1", name: "test.wav", sizeBytes: 4, mimeType: "audio/wav", s3Url: undefined}
        await chain.publish("a1", data, meta).catch(() => {})
        expect(failSource.publish).toHaveBeenCalled()
        expect(goodSource.publish).toHaveBeenCalled()
    })
})
