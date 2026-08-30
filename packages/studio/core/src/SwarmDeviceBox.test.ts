import {describe, expect, it} from "vitest"
import {Option, UUID} from "@opendaw/lib-std"
import {BoxGraph} from "@opendaw/lib-box"
import {BoxIO, SwarmDeviceBox} from "@opendaw/studio-boxes"

describe("SwarmDeviceBox defaults", () => {
    it("creates with expected parameter defaults", () => {
        const boxGraph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
        boxGraph.beginTransaction()
        const box = SwarmDeviceBox.create(boxGraph, UUID.generate())
        expect(box.reverse.getValue()).toBe(false)
        expect(box.octave.getValue()).toBe(0)
        expect(box.volume.getValue()).toBeCloseTo(-3.0)
        expect(box.attack.getValue()).toBeCloseTo(0.001)
        expect(box.release.getValue()).toBeCloseTo(0.1)
        expect(box.sampleStart.getValue()).toBeCloseTo(0.0)
        expect(box.sampleEnd.getValue()).toBeCloseTo(1.0)
        expect(box.enabled.getValue()).toBe(true)
        expect(box.rootKey.getValue()).toBe(60)
        expect(box.loop.getValue()).toBe(false)
        expect(box.loopFade.getValue()).toBeCloseTo(0.05)
        expect(box.loopStart.getValue()).toBeCloseTo(0.0)
        expect(box.loopEnd.getValue()).toBeCloseTo(1.0)
    })
})
