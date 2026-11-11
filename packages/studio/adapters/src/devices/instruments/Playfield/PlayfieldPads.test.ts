import {describe, expect, it} from "vitest"
import {isInstanceOf, Option, UUID} from "@opendaw/lib-std"
import {AudioFileBox, AudioUnitBox, InstrumentCompositeCellBox, NanoDeviceBox, PlayfieldDeviceBox, VaporisateurDeviceBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "../../../project/ProjectSkeleton"
import {PlayfieldPads} from "./PlayfieldPads"

const setup = () => {
    const {boxGraph, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    boxGraph.beginTransaction()
    const unit = AudioUnitBox.create(boxGraph, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
    })
    const playfield = PlayfieldDeviceBox.create(boxGraph, UUID.generate(), box => box.host.refer(unit.input))
    const file = AudioFileBox.create(boxGraph, UUID.generate(), box => box.fileName.setValue("kick.wav"))
    const pad = PlayfieldPads.create(boxGraph, playfield, file, 36, {exclude: true})
    boxGraph.endTransaction()
    return {boxGraph, playfield, file, pad}
}

const instrumentOf = (cell: InstrumentCompositeCellBox) => cell.instrument.pointerHub.incoming()[0].box

describe("PlayfieldPads", () => {
    it("creates a pad that plays like the former slot", () => {
        const {playfield, pad} = setup()
        expect(PlayfieldPads.isPad(pad)).toBe(true)
        expect([pad.index.getValue(), pad.key.getValue(), pad.exclude.getValue()]).toEqual([36, 60, true])
        expect(playfield.pads.pointerHub.incoming()).toHaveLength(1)
        const nano = instrumentOf(pad) as NanoDeviceBox
        expect([nano.oneShot.getValue(), nano.fixedPitch.getValue(), nano.tail.getValue(), nano.polyphone.getValue()])
            .toEqual([true, true, true, false])
        expect([nano.loopFade.getValue(), nano.volume.getValue(), nano.label.getValue()]).toEqual([expect.closeTo(0.001, 6), 0, "kick.wav"])
    })

    it("turns a pad playing another instrument back into a sample pad", () => {
        const {boxGraph, pad} = setup()
        boxGraph.beginTransaction()
        instrumentOf(pad).delete()
        VaporisateurDeviceBox.create(boxGraph, UUID.generate(), box => box.host.refer(pad.instrument))
        const file = AudioFileBox.create(boxGraph, UUID.generate(), box => box.fileName.setValue("snare.wav"))
        PlayfieldPads.playSample(boxGraph, pad, file)
        boxGraph.endTransaction()
        expect(pad.instrument.pointerHub.incoming()).toHaveLength(1)
        const nano = instrumentOf(pad)
        expect(isInstanceOf(nano, NanoDeviceBox)).toBe(true)
        expect((nano as NanoDeviceBox).file.targetVertex.unwrap().box).toBe(file)
    })

    it("resets the pad and its Nano", () => {
        const {boxGraph, pad} = setup()
        const nano = instrumentOf(pad) as NanoDeviceBox
        boxGraph.beginTransaction()
        pad.gain.setValue(-12)
        pad.mute.setValue(true)
        nano.attack.setValue(1.0)
        PlayfieldPads.resetParameters(pad, Option.wrap(nano))
        boxGraph.endTransaction()
        expect([pad.gain.getValue(), pad.mute.getValue(), pad.exclude.getValue()]).toEqual([0, false, false])
        expect(nano.attack.getValue()).toBeCloseTo(0.001)
    })
})
