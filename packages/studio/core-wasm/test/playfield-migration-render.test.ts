import {describe, expect, it} from "vitest"
import {asInstanceOf, isInstanceOf} from "@opendaw/lib-std"
import {InstrumentCompositeCellBox, NanoDeviceBox, PlayfieldDeviceBox, PlayfieldSampleBox} from "@opendaw/studio-boxes"
import {renderOd} from "./helpers/render-od"

// playfield.od rendered on the former slot player and migrated to Nano pads. The Nano envelopes round differently
// and release without the slot's hold, so the renders match within a tolerance, not bit for bit.
describe("playfield migration render", () => {
    it("the migrated project sounds like the slot player", async () => {
        const legacy = await renderOd("playfield", 1500, true)
        const migrated = await renderOd("playfield", 1500)
        expect(legacy.boxGraph.boxes().some(box => isInstanceOf(box, PlayfieldSampleBox))).toBe(true)
        expect(migrated.boxGraph.boxes().some(box => isInstanceOf(box, PlayfieldSampleBox))).toBe(false)
        const playfield = asInstanceOf(migrated.boxGraph.boxes().find(box => isInstanceOf(box, PlayfieldDeviceBox)), PlayfieldDeviceBox)
        const pads = playfield.pads.pointerHub.incoming().map(({box}) => asInstanceOf(box, InstrumentCompositeCellBox))
        expect(pads.length).toBeGreaterThan(0)
        pads.forEach(pad => expect(isInstanceOf(pad.instrument.pointerHub.incoming()[0].box, NanoDeviceBox)).toBe(true))
        const energy = legacy.output.reduce((sum, value) => sum + value * value, 0)
        expect(energy, "the slot player is audible").toBeGreaterThan(1.0)
        const difference = legacy.output.reduce((sum, value, index) => sum + (value - migrated.output[index]) ** 2, 0)
        const relative = Math.sqrt(difference / energy)
        expect(relative, `relative rms difference ${relative}`).toBeLessThan(0.03)
    }, 120000)
})
