import {describe, expect, it} from "vitest"
import {SamplerDeviceBoxAdapter} from "./SamplerDeviceBoxAdapter"

// the same cases as `a_synced_lfo_snaps_to_the_nearest_note_length` of the device
describe("SamplerDeviceBoxAdapter.syncIndex", () => {
    const name = (hertz: number, bpm: number): string => SamplerDeviceBoxAdapter.SyncNames[SamplerDeviceBoxAdapter.syncIndex(hertz, bpm)]
    it("names the note length a rate snaps to", () => {
        expect(name(2.0, 120)).toBe("1/4")
        expect(name(2.3, 120)).toBe("1/4")
        expect(name(3.5, 120)).toBe("1/8")
        expect(name(0.5, 120)).toBe("1 bar")
        expect(name(3.0, 120)).toBe("1/6")
        expect(name(2.0, 60)).toBe("1/8")
    })
    it("stays inside the list", () => {
        expect(name(0.001, 120)).toBe("8 bars")
        expect(name(500, 120)).toBe("1/32")
    })
    it("has a name for every length", () => {
        expect(SamplerDeviceBoxAdapter.SyncNames).toHaveLength(SamplerDeviceBoxAdapter.SyncBars.length)
    })
})
