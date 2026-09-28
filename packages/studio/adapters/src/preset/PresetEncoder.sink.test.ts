import {describe, expect, it} from "vitest"
import {Option, UUID} from "@opendaw/lib-std"
import {AudioBusBox, AudioSinkDeviceBox, CaptureAudioBox} from "@opendaw/studio-boxes"
import {AudioUnitType, Colors} from "@opendaw/studio-enums"
import {ProjectSkeleton} from "../project/ProjectSkeleton"
import {AudioUnitFactory} from "../factories/AudioUnitFactory"
import {AudioBusFactory} from "../factories/AudioBusFactory"
import {PresetEncoder} from "./PresetEncoder"
import {PresetDecoder} from "./PresetDecoder"
import {PresetHeader} from "./PresetHeader"

// A Sink's `targetBus` points at a bus OUTSIDE the device (AudioBusBox.input is not a mandatory target, so the
// dependency walk never drags the bus into the preset). Decoded into another project the pointer has nothing
// to resolve to and must be dropped: the sink arrives unassigned (silent), never pointing at a foreign uuid.
describe("PresetEncoder / PresetDecoder (audio sink)", () => {
    const encodeSinkChain = (): ArrayBuffer => {
        const source = ProjectSkeleton.empty({createDefaultUser: false, createOutputMaximizer: false})
        const {boxGraph} = source
        boxGraph.beginTransaction()
        const capture = CaptureAudioBox.create(boxGraph, UUID.generate())
        const unit = AudioUnitFactory.create(source, AudioUnitType.Instrument, Option.wrap(capture))
        const bus = AudioBusFactory.create(source, "Drums", "AudioBus", AudioUnitType.Bus, Colors.orange)
        const sink = AudioSinkDeviceBox.create(boxGraph, UUID.generate(), box => {
            box.host.refer(unit.audioEffects)
            box.index.setValue(0)
            box.pass.setValue(-6)
            box.targetBus.refer(bus.input)
        })
        boxGraph.endTransaction()
        return PresetEncoder.encodeEffects([sink], PresetHeader.ChainKind.Audio) as ArrayBuffer
    }

    it("drops the target bus pointer and carries no bus along", () => {
        const bytes = encodeSinkChain()
        const target = ProjectSkeleton.empty({createDefaultUser: false, createOutputMaximizer: false})
        const {boxGraph} = target
        boxGraph.beginTransaction()
        const capture = CaptureAudioBox.create(boxGraph, UUID.generate())
        const targetUnit = AudioUnitFactory.create(target, AudioUnitType.Instrument, Option.wrap(capture))
        const attempt = PresetDecoder.insertEffectChain(bytes, targetUnit.audioEffects, 0, PresetHeader.ChainKind.Audio)
        boxGraph.endTransaction()
        expect(attempt.isFailure()).toBe(false)
        const sinks = boxGraph.boxes().filter(box => box instanceof AudioSinkDeviceBox) as Array<AudioSinkDeviceBox>
        expect(sinks.length).toBe(1)
        const [sink] = sinks
        expect(sink.host.targetAddress.unwrap("host").equals(targetUnit.audioEffects.address)).toBe(true)
        expect(sink.pass.getValue()).toBe(-6)
        expect(sink.targetBus.isEmpty()).toBe(true)
        const busses = boxGraph.boxes().filter(box => box instanceof AudioBusBox)
        expect(busses.length, "only the target project's primary bus").toBe(1)
    })
})
