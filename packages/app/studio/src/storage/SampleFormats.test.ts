import {describe, expect, it} from "vitest"
import {StorageWalk} from "@opendaw/lib-fusion"
import {AudioData, PcmData, SampleConversion, WavFile} from "@opendaw/lib-dsp"
import {SampleFormats} from "./SampleFormats"

const json = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value))

const audioOf = (...values: ReadonlyArray<number>): AudioData => {
    const audio = AudioData.create(48_000, values.length, 1)
    audio.frames[0].set(values)
    return audio
}

const floatFile = (...values: ReadonlyArray<number>): Uint8Array => new Uint8Array(WavFile.encodeFloats(audioOf(...values)))
const smallFile = (...values: ReadonlyArray<number>): Uint8Array => new Uint8Array(WavFile.encodePcm(PcmData.smallest(audioOf(...values))))

type Store = Map<string, Uint8Array>

const scanOf = async (store: Store) => {
    const files: Array<StorageWalk.File> = Array.from(store, ([path, bytes]) => ({path, size: bytes.byteLength}))
    const fullReads: Array<string> = []
    const report = await SampleFormats.scan(files,
        async (path, bytes) => store.get(path)!.slice(0, bytes),
        async path => {
            fullReads.push(path)
            const bytes = store.get(path)
            return bytes === undefined ? Promise.reject(new Error("missing")) : bytes
        }, () => {})
    return {report, fullReads}
}

const sample = (store: Store, id: string, audio: Uint8Array, meta: unknown = {name: id, origin: "import"}): void => {
    store.set(`samples/v2/${id}/audio.wav`, audio)
    store.set(`samples/v2/${id}/peaks.bin`, new Uint8Array(8))
    store.set(`samples/v2/${id}/meta.json`, json(meta))
}

describe("SampleFormats.scan", () => {
    it("tells the five kinds apart", async () => {
        const store: Store = new Map()
        sample(store, "sixteen", smallFile(0.5, -0.25))
        sample(store, "exact", floatFile(0.5, -0.25))
        sample(store, "rounding", floatFile(0.1, -0.9))
        sample(store, "scaling", floatFile(1.01, 0.2))
        sample(store, "float", floatFile(1.5, 0.2))
        const {report} = await scanOf(store)
        expect(Object.fromEntries(report.entries.map(({id, kind}) => [id, kind])))
            .toEqual({sixteen: "sixteen", exact: "exact", rounding: "rounding", scaling: "scaling", float: "float"})
        expect(report.failures).toEqual([])
    })
    it("does not read the frames of a sample that is 16 bit already", async () => {
        const store: Store = new Map()
        sample(store, "small", smallFile(0.5, -0.25))
        sample(store, "big", floatFile(0.5, -0.25))
        const {fullReads} = await scanOf(store)
        expect(fullReads.filter(path => path.endsWith("audio.wav"))).toEqual(["samples/v2/big/audio.wav"])
    })
    it("reports name, origin, size, peak and what a conversion frees", async () => {
        const store: Store = new Map()
        sample(store, "abc", floatFile(0.5, -0.75, 0.25, 0), {name: "Kick", origin: "openDAW", bpm: 120})
        const {report: {entries: [entry]}} = await scanOf(store)
        expect(entry).toEqual({id: "abc", name: "Kick", origin: "openDAW", size: 44 + 16, kind: "exact", peak: 0.75, saving: 8})
    })
    it("frees nothing for samples that do not convert", async () => {
        const store: Store = new Map()
        sample(store, "loud", floatFile(1.5))
        sample(store, "small", smallFile(0.5))
        const {report} = await scanOf(store)
        expect(report.entries.map(({saving, peak}) => [saving, peak])).toEqual([[0, 1.5], [0, null]])
    })
    it("falls back to the id when the meta is missing or broken", async () => {
        const store: Store = new Map()
        store.set("samples/v2/nometa/audio.wav", floatFile(0.5))
        sample(store, "broken", floatFile(0.5))
        store.set("samples/v2/broken/meta.json", new TextEncoder().encode("{not json"))
        sample(store, "odd", floatFile(0.5), [1, 2])
        const {report} = await scanOf(store)
        expect(report.entries.map(({name, origin}) => [name, origin])).toEqual([["nometa", null], ["broken", null], ["odd", null]])
    })
    it("lists an audio file it cannot decode as a failure", async () => {
        const store: Store = new Map()
        sample(store, "bad", new Uint8Array(60))
        sample(store, "good", floatFile(0.5))
        const {report} = await scanOf(store)
        expect(report.failures).toEqual(["samples/v2/bad/audio.wav"])
        expect(report.entries.map(({id}) => id)).toEqual(["good"])
    })
    it("names the samples whose replacement was cut off, readable or not", async () => {
        const store: Store = new Map()
        sample(store, "cut", floatFile(0.5))
        store.set("samples/v2/cut/audio.wav.pending", smallFile(0.5))
        sample(store, "marked", floatFile(0.5))
        store.set("samples/v2/marked/audio.wav.commit", new Uint8Array([1]))
        sample(store, "torn", new Uint8Array(20))
        store.set("samples/v2/torn/audio.wav.commit", new Uint8Array([1]))
        store.set("samples/v2/torn/audio.wav.pending", smallFile(0.5))
        sample(store, "fine", floatFile(0.5))
        const {report} = await scanOf(store)
        expect(report.leftovers).toEqual(["cut", "marked", "torn"])
        expect(report.failures).toEqual(["samples/v2/torn/audio.wav"])
    })
    it("ignores files that are not a sample's audio", async () => {
        const store: Store = new Map()
        sample(store, "one", floatFile(0.5))
        store.set("samples/v2/trash.json", json([]))
        store.set("samples/v2/garbage.json", json([]))
        store.set("soundfont/abc/audio.wav", floatFile(0.5))
        store.set("samples/v2/one/deeper/audio.wav", floatFile(0.5))
        const {report} = await scanOf(store)
        expect(report.entries.map(({id}) => id)).toEqual(["one"])
    })
    it("reports progress up to one", async () => {
        const store: Store = new Map()
        sample(store, "a", floatFile(0.5))
        sample(store, "b", floatFile(0.5))
        const steps: Array<number> = []
        const files = Array.from(store, ([path, bytes]) => ({path, size: bytes.byteLength}))
        await SampleFormats.scan(files, async (path, bytes) => store.get(path)!.slice(0, bytes), async path => store.get(path)!,
            value => steps.push(value))
        expect(steps).toEqual([0.5, 1.0])
    })
    it("is empty for an empty storage", async () => {
        expect((await scanOf(new Map())).report).toEqual({entries: [], failures: [], leftovers: []})
    })
})

describe("SampleFormats helpers", () => {
    const entry = (kind: SampleConversion.Kind, peak: number | null, size = 1000, saving = 400, name = "x"): SampleFormats.Entry =>
        ({id: name, name, origin: null, size, kind, peak, saving})
    it("sorts a kind by size, largest first, then by name", () => {
        const entries = [entry("exact", 0.5, 10, 4, "b"), entry("exact", 0.5, 30, 4, "a"), entry("float", 2, 99), entry("exact", 0.5, 10, 4, "a2")]
        expect(SampleFormats.ofKind(entries, "exact").map(({name}) => name)).toEqual(["a", "a2", "b"])
    })
    it("an entry after its conversion is 16 bit, smaller and frees nothing more", () => {
        expect(SampleFormats.converted(entry("rounding", 0.5, 1000, 400)))
            .toEqual({id: "x", name: "x", origin: null, size: 600, kind: "sixteen", peak: null, saving: 0})
    })
    it("sums sizes and savings", () => {
        const entries = [entry("exact", 0.5, 100, 40), entry("rounding", 0.5, 50, 20)]
        expect([SampleFormats.sizeOf(entries), SampleFormats.savingOf(entries)]).toEqual([150, 60])
    })
    it("says what happens to each kind", () => {
        expect(SampleFormats.describe(entry("sixteen", null))).toBe("Is 16 bit")
        expect(SampleFormats.describe(entry("exact", 0.5))).toBe("Nothing is lost")
        expect(SampleFormats.describe(entry("rounding", 0.5))).toBe("Rounded to 16 bit")
        expect(SampleFormats.describe(entry("scaling", 1.01))).toBe("Lowered by 0.09 dB, then rounded")
        expect(SampleFormats.describe(entry("float", 2))).toBe("Too loud for 16 bit, stays 32 bit")
    })
    it("never lowers by more than a little over 0.1 dB", () => {
        expect(SampleFormats.loweredBy(entry("scaling", SampleConversion.Headroom))).toBeLessThan(0.1003)
        expect(SampleFormats.loweredBy(entry("rounding", 0.9))).toBe(0)
        expect(SampleFormats.loweredBy(entry("scaling", null))).toBe(0)
    })
    it("prints the peak in decibel", () => {
        expect(SampleFormats.peakText(entry("exact", 1.0))).toBe("0.00 dB")
        expect(SampleFormats.peakText(entry("rounding", 0.9999))).toBe("0.00 dB")
        expect(SampleFormats.peakText(entry("scaling", 1.0001))).toBe("0.00 dB")
        expect(SampleFormats.peakText(entry("exact", 0.5))).toBe("-6.02 dB")
        expect(SampleFormats.peakText(entry("float", 2.0))).toBe("+6.02 dB")
        expect(SampleFormats.peakText(entry("exact", 0.0))).toBe("silent")
        expect(SampleFormats.peakText(entry("float", Number.POSITIVE_INFINITY))).toBe("not a number")
        expect(SampleFormats.peakText(entry("sixteen", null))).toBe("")
    })
    it("lists the kinds with the convertible ones first", () =>
        expect(SampleFormats.KindOrder).toEqual(["exact", "rounding", "scaling", "float", "sixteen"]))
})
