import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import type {BoxGraph, Field} from "@opendaw/lib-box"
import {
    ApparatDeviceBox,
    AudioUnitBox,
    LinearMatrixDuckerDeviceBox,
    NoteEventBox,
    NoteEventCollectionBox,
    NoteRegionBox,
    TrackBox
} from "@opendaw/studio-boxes"
import {ProjectSkeleton, ScriptCompiler, TrackType} from "@opendaw/studio-adapters"
import {Pointers} from "@opendaw/studio-enums"
import {build, impulseUnit, peaks, start} from "./helpers/compensation-harness"
import {readSignalGraph} from "../src/engine-exports"

// 10 ms of lookahead at 48 kHz plus 9 frames for the inter-sample-peak filter, as Compactor reports
const LATENCY = 489

const sine = (gain: number, frequency: number) => `class Processor {
    voices = 0
    phase = 0
    noteOn() { this.voices++ }
    noteOff() { this.voices-- }
    process(output, block) {
        if (this.voices === 0) return
        for (let i = block.s0; i < block.s1; i++) {
            const s = Math.sin(this.phase * Math.PI * 2) * ${gain}
            output[0][i] += s; output[1][i] += s
            this.phase += ${frequency} / sampleRate
        }
    }
}`

type Skeleton = ReturnType<typeof ProjectSkeleton.empty>

const sineUnit = (skeleton: Skeleton, index: number, code: string, scripts: Array<[string, string]>): AudioUnitBox => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} = skeleton
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(index)
    })
    const apparat = ApparatDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.input)
        box.code.setValue("// @apparat js 1 1\n" + code)
    })
    scripts.push([UUID.toString(apparat.address.uuid), code])
    const track = TrackBox.create(source, UUID.generate(), box => {
        box.type.setValue(TrackType.Notes)
        box.enabled.setValue(true)
        box.index.setValue(0)
        box.target.refer(unit)
        box.tracks.refer(unit.tracks)
    })
    const events = NoteEventCollectionBox.create(source, UUID.generate())
    NoteEventBox.create(source, UUID.generate(), box => {
        box.events.refer(events.events)
        box.position.setValue(0)
        box.duration.setValue(100_000)
        box.pitch.setValue(60)
        box.velocity.setValue(1.0)
    })
    NoteRegionBox.create(source, UUID.generate(), box => {
        box.regions.refer(track.regions)
        box.events.refer(events.owners)
        box.position.setValue(0)
        box.duration.setValue(100_000)
        box.loopDuration.setValue(100_000)
    })
    return unit
}

const ducker = (source: BoxGraph, host: Field<Pointers.AudioEffectHost>, thresholdDb: number): LinearMatrixDuckerDeviceBox =>
    LinearMatrixDuckerDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(host)
        box.index.setValue(0)
        box.threshold.setValue(thresholdDb)
    })

const buildSines = (populate: (skeleton: Skeleton, scripts: Array<[string, string]>) => void): BoxGraph => {
    const skeleton = ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    const scripts: Array<[string, string]> = []
    skeleton.boxGraph.beginTransaction()
    populate(skeleton, scripts)
    skeleton.boxGraph.endTransaction()
    scripts.forEach(([uuid, code]) => new Function(ScriptCompiler.wrap(
        {headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"}, uuid, 1, code))())
    return skeleton.boxGraph
}

const peakOf = (signal: Float32Array, from: number): number =>
    signal.subarray(from).reduce((max, sample) => Math.max(max, Math.abs(sample)), 0)

describe("Linear Matrix Ducker", () => {
    it("reports its lookahead, so delay compensation aligns a parallel dry track", async () => {
        const source = build((skeleton, scripts) => {
            impulseUnit(skeleton, 1, scripts)
            const latent = impulseUnit(skeleton, 2, scripts)
            ducker(skeleton.boxGraph, latent.audioEffects, 0.0)
        })
        const {engine, memory, play} = await start(source)
        expect(peaks(play(8))).toEqual([[LATENCY, 1]])
        const master = readSignalGraph(engine, memory).nodes.find(node => node.label === "master-sum")
        expect(master?.arrival).toBe(LATENCY)
    }, 30000)

    it("clips the carrier at the threshold without a sidechain", async () => {
        const source = buildSines((skeleton, scripts) => {
            const unit = sineUnit(skeleton, 1, sine(0.9, 441), scripts)
            ducker(skeleton.boxGraph, unit.audioEffects, -6.0)
        })
        const {play} = await start(source)
        const output = play(120)
        const peak = peakOf(output, LATENCY + 512)
        expect(peak).toBeLessThanOrEqual(Math.pow(10, -6 / 20) + 1e-4)
        expect(peak).toBeGreaterThan(0.45)
    }, 30000)

    it("keeps carrier plus sidechain under the threshold at the master", async () => {
        const render = async (withDucker: boolean) => {
            const source = buildSines((skeleton, scripts) => {
                const carrier = sineUnit(skeleton, 1, sine(0.8, 220), scripts)
                const side = sineUnit(skeleton, 2, sine(0.4, 331), scripts)
                if (withDucker) {
                    const box = ducker(skeleton.boxGraph, carrier.audioEffects, 0.0)
                    box.sideChain.refer(side)
                }
            })
            const {play} = await start(source)
            return peakOf(play(200), LATENCY * 2 + 512)
        }
        expect(await render(false)).toBeGreaterThan(1.1)
        const ducked = await render(true)
        expect(ducked).toBeLessThanOrEqual(1.0 + 1e-4)
        expect(ducked).toBeGreaterThan(0.8)
    }, 60000)

    it("ducks a quiet carrier by the sidechain level", async () => {
        const render = async (range: number) => {
            const source = buildSines((skeleton, scripts) => {
                const carrier = sineUnit(skeleton, 1, sine(0.2, 220), scripts)
                const side = sineUnit(skeleton, 2, sine(0.5, 331), scripts)
                const box = ducker(skeleton.boxGraph, carrier.audioEffects, 0.0)
                box.range.setValue(range)
                box.sideChain.refer(side)
            })
            const {play} = await start(source)
            return play(200).subarray(LATENCY * 2 + 512)
        }
        // Range 0 ignores a sidechain below the threshold, so the difference is the ducking of the carrier alone.
        const ignored = await render(0.0)
        const ducked = await render(1.0)
        const difference = ducked.reduce((max, sample, index) => Math.max(max, Math.abs(sample - ignored[index])), 0)
        expect(difference).toBeGreaterThan(0.05)
        expect(difference).toBeLessThanOrEqual(0.2 * 0.5 + 1e-3)
    }, 60000)
})
