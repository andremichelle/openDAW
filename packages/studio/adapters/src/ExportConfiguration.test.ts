import {describe, expect, it} from "vitest"
import {Option} from "@opendaw/lib-std"
import {ExportConfiguration, ExportStemConfiguration} from "./EngineProcessorAttachment"

// `countStems` sizes `numberOfChannels` (pairs * 2) for the offline render, and the wasm engine allocates its
// stem staging from the same count. If the two disagree by one pair, stems silently read the wrong channels,
// so the metronome's effect on the count is pinned here.
const stem = (fileName: string): ExportStemConfiguration =>
    ({includeAudioEffects: true, includeSends: true, useInstrumentOutput: false, fileName})

const config = (value: ExportConfiguration) => Option.wrap(value)

describe("ExportConfiguration", () => {
    describe("countStems", () => {
        it("should count a bare mixdown as one pair", () => {
            expect(ExportConfiguration.countStems(Option.None)).toBe(1)
            expect(ExportConfiguration.countStems(config({}))).toBe(1)
        })
        it("should count each unit stem", () => {
            expect(ExportConfiguration.countStems(config({stems: {a: stem("a"), b: stem("b")}}))).toBe(2)
        })
        it("should add ONE pair for the metronome stem", () => {
            expect(ExportConfiguration.countStems(config({
                stems: {a: stem("a"), b: stem("b")},
                metronome: {stem: {fileName: "Metronome"}}
            }))).toBe(3)
        })
        it("should allow a metronome-only stem export", () => {
            expect(ExportConfiguration.countStems(config({
                stems: {},
                metronome: {stem: {fileName: "Metronome"}}
            }))).toBe(1)
        })
        it("should NOT add a pair in a mixdown: the click mixes into the stereo pair", () => {
            expect(ExportConfiguration.countStems(config({metronome: {includeInMixdown: true}}))).toBe(1)
        })
        it("should ignore a metronome that only carries settings or sounds", () => {
            expect(ExportConfiguration.countStems(config({
                stems: {a: stem("a")},
                metronome: {settings: {gain: -3}}
            }))).toBe(1 + 0)
        })
    })

    // The zip writer maps rendered channel pair i to name i, so these names must cover EVERY pair the engine
    // staged, in the engine's order. One name short and the last pair is written as "undefined.wav".
    describe("stemFileNames", () => {
        it("should name every unit stem in key order", () => {
            expect(ExportConfiguration.stemFileNames({stems: {a: stem("Drums"), b: stem("Bass")}}))
                .toEqual(["Drums", "Bass"])
        })
        it("should name the metronome LAST, matching the engine's staging order", () => {
            expect(ExportConfiguration.stemFileNames({
                stems: {a: stem("Drums"), b: stem("Bass")},
                metronome: {stem: {fileName: "Metronome"}}
            })).toEqual(["Drums", "Bass", "Metronome"])
        })
        it("should produce one name per counted pair", () => {
            const config: ExportConfiguration = {
                stems: {a: stem("Drums")},
                metronome: {stem: {fileName: "Metronome"}}
            }
            expect(ExportConfiguration.stemFileNames(config).length)
                .toBe(ExportConfiguration.countStems(Option.wrap(config)))
        })
        it("should name a metronome-only export", () => {
            expect(ExportConfiguration.stemFileNames({stems: {}, metronome: {stem: {fileName: "Metronome"}}}))
                .toEqual(["Metronome"])
        })
        it("should not name a metronome that only mixes into the mixdown", () => {
            expect(ExportConfiguration.stemFileNames({stems: {a: stem("Drums")}, metronome: {includeInMixdown: true}}))
                .toEqual(["Drums"])
        })
    })

    describe("sanitizeExportNamesInPlace", () => {
        it("should sanitize and de-duplicate the metronome against the unit stems", () => {
            const config: ExportConfiguration = {
                stems: {a: stem("Drums")},
                metronome: {stem: {fileName: "Drums"}}
            }
            ExportConfiguration.sanitizeExportNamesInPlace(config)
            // They share one zip, where a duplicate name silently overwrites. The click yields, not the stem.
            expect(config.stems!.a.fileName).toBe("Drums")
            expect(config.metronome!.stem!.fileName).not.toBe("Drums")
            expect(new Set(ExportConfiguration.stemFileNames(config)).size).toBe(2)
        })
        it("should strip illegal characters from the metronome name", () => {
            const config: ExportConfiguration = {stems: {}, metronome: {stem: {fileName: "Metro/nome:1"}}}
            ExportConfiguration.sanitizeExportNamesInPlace(config)
            expect(config.metronome!.stem!.fileName).not.toMatch(/[<>:"/\\|?*]/)
        })
    })

    describe("isMetronomeAudible", () => {
        it("should stay silent without a configuration", () => {
            expect(ExportConfiguration.isMetronomeAudible(Option.None)).toBe(false)
            expect(ExportConfiguration.isMetronomeAudible(config({}))).toBe(false)
        })
        it("should stay silent for a plain mixdown or a plain stems export", () => {
            expect(ExportConfiguration.isMetronomeAudible(config({stems: {a: stem("a")}}))).toBe(false)
            expect(ExportConfiguration.isMetronomeAudible(config({metronome: {}}))).toBe(false)
        })
        it("should sound in a mixdown only when explicitly included", () => {
            expect(ExportConfiguration.isMetronomeAudible(config({metronome: {includeInMixdown: true}}))).toBe(true)
            expect(ExportConfiguration.isMetronomeAudible(config({metronome: {includeInMixdown: false}}))).toBe(false)
        })
        it("should sound in a stems export only when a metronome stem was requested", () => {
            expect(ExportConfiguration.isMetronomeAudible(config({
                stems: {a: stem("a")},
                metronome: {stem: {fileName: "Metronome"}}
            }))).toBe(true)
        })
        it("should ignore includeInMixdown for a stems export: there is no mixdown to mix into", () => {
            expect(ExportConfiguration.isMetronomeAudible(config({
                stems: {a: stem("a")},
                metronome: {includeInMixdown: true}
            }))).toBe(false)
        })
    })
})
