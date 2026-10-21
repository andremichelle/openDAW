// Automation and modulation behind delay compensation (#482). A Werkstatt delays one track by 1000 frames, an
// impulse plays at frame 0, and at pulse 10 (frame 250) automation or a modulator switches the path off further
// down the chain. The audio reaches that point at frame 1000: compensated, the processor reads its automation where
// the audio was rendered and the impulse passes. The control declares no latency (the uncompensated engine) and
// loses the impulse, which proves each case tells the two apart.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {Interpolation} from "@opendaw/lib-dsp"
import type {BoxGraph, Field} from "@opendaw/lib-box"
import {
    AudioUnitBox,
    AuxSendBox,
    MacroModulatorBox,
    ModulationBox,
    StereoToolDeviceBox,
    TrackBox,
    ValueEventBox,
    ValueEventCollectionBox,
    ValueRegionBox
} from "@opendaw/studio-boxes"
import {InterpolationFieldAdapter, TrackType} from "@opendaw/studio-adapters"
import {AudioSendRouting} from "@opendaw/studio-enums"
import {build, busUnit, impulseUnit, peaks, registerWerkstatt, Skeleton, start, werkstattDelay} from "./helpers/compensation-harness"

const DELAY = 1000
const SWITCH = 10 // pulses, frame 250 at 120 bpm

// A value track holding `from` until `SWITCH`, then `to`.
const step = (source: BoxGraph, target: Field, tracks: Field, from: number, to: number): void => {
    const track = TrackBox.create(source, UUID.generate(), box => {
        box.type.setValue(TrackType.Value)
        box.enabled.setValue(true)
        box.index.setValue(1)
        box.target.refer(target)
        box.tracks.refer(tracks)
    })
    const collection = ValueEventCollectionBox.create(source, UUID.generate())
    const event = (position: number, value: number, order: number) =>
        ValueEventBox.create(source, UUID.generate(), box => {
            box.position.setValue(position)
            box.value.setValue(value)
            box.index.setValue(order)
            box.slope.setValue(NaN)
            box.events.refer(collection.events)
            InterpolationFieldAdapter.write(box.interpolation, Interpolation.None)
        })
    event(0, from, 0)
    event(SWITCH, to, 1)
    ValueRegionBox.create(source, UUID.generate(), box => {
        box.regions.refer(track.regions)
        box.events.refer(collection.owners)
        box.position.setValue(0)
        box.duration.setValue(3840)
        box.loopDuration.setValue(3840)
    })
}

type Scene = (skeleton: Skeleton, unit: AudioUnitBox) => void

// One impulse track whose first effect is the delaying Werkstatt, then `scene` adds what is automated.
const render = async (declared: number, scene: Scene): Promise<ReadonlyArray<[number, number]>> => {
    const werkstatts: Array<{ uuid: string, code: string }> = []
    const source = build((skeleton, scripts) => {
        const unit = impulseUnit(skeleton, 1, scripts)
        werkstatts.push(werkstattDelay(skeleton.boxGraph, unit.audioEffects, 0, DELAY, declared))
        scene(skeleton, unit)
    })
    werkstatts.forEach(registerWerkstatt)
    const {play} = await start(source)
    return peaks(play(8))
}

const expectCompensated = async (scene: Scene) => {
    const compensated = await render(DELAY, scene)
    expect(compensated.length).toBe(1)
    expect(compensated[0][0]).toBe(DELAY)
    expect(await render(0, scene)).toEqual([])
}

const stereoTool = (source: BoxGraph, unit: AudioUnitBox): StereoToolDeviceBox =>
    StereoToolDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.audioEffects)
        box.index.setValue(1)
        box.volume.setValue(0.0)
        box.panning.setValue(0.0)
        box.stereo.setValue(0.0)
    })

describe("automation and modulation behind delay compensation", () => {
    it("the channel strip mutes where its audio was rendered", async () => {
        await expectCompensated(({boxGraph}, unit) => step(boxGraph, unit.mute, unit.tracks, 0.0, 1.0))
    }, 60000)

    it("a device parameter after a latent device follows its audio", async () => {
        await expectCompensated(({boxGraph}, unit) => {
            const tool = stereoTool(boxGraph, unit)
            step(boxGraph, tool.volume, unit.tracks, 0.75, 0.0)
        })
    }, 60000)

    it("an aux send gain follows the audio it taps", async () => {
        await expectCompensated((skeleton, unit) => {
            unit.mute.setValue(true)
            const {bus} = busUnit(skeleton, 2)
            const send = AuxSendBox.create(skeleton.boxGraph, UUID.generate(), box => {
                box.audioUnit.refer(unit.auxSends)
                box.targetBus.refer(bus.input)
                box.index.setValue(0)
                box.routing.setValue(AudioSendRouting.Pre)
                box.sendGain.setValue(0.0)
                box.sendPan.setValue(0.0)
            })
            step(skeleton.boxGraph, send.sendGain, unit.tracks, 0.75, 0.0)
        })
    }, 60000)

    it("a modulator reads its value from when the audio was rendered", async () => {
        await expectCompensated(({boxGraph, mandatoryBoxes: {rootBox}}, unit) => {
            const tool = stereoTool(boxGraph, unit)
            tool.volume.setValue(0.0)
            const macro = MacroModulatorBox.create(boxGraph, UUID.generate(), box => {
                box.collection.refer(rootBox.modulators)
                box.label.setValue("Macro")
                box.bipolar.setValue(false)
            })
            ModulationBox.create(boxGraph, UUID.generate(), box => {
                box.source.refer(macro.assignments)
                box.target.refer(tool.volume)
                box.depth.setValue(-1.0)
            })
            step(boxGraph, macro.value, macro.tracks, 0.0, 1.0)
        })
    }, 60000)
})
