import {describe, expect, it, vi} from "vitest"
import {DefaultObservableValue, isDefined, Option, Terminable, unitValue, UUID} from "@opendaw/lib-std"
import {ppqn, PPQN} from "@opendaw/lib-dsp"
import {
    AudioUnitBoxAdapter,
    AutomatableParameterFieldAdapter,
    LfoModulatorBoxAdapter,
    ModulationBoxAdapter,
    Modulators,
    ProjectSkeleton,
    TrackBoxAdapter,
    TrackType,
    ValueRegionBoxAdapter
} from "@opendaw/studio-adapters"
import {TrackBox} from "@opendaw/studio-boxes"
import {PrimitiveField, PrimitiveValues} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import type {ProjectEnv} from "../project/ProjectEnv"
import type {EngineWorklet} from "../EngineWorklet"

// Automation recording is write-driven and latching: any write to a parameter while the transport records opens
// a take, and only the transport (or a loop wrap) closes it. No producer opts in, so a knob, a MIDI controller,
// a checkbox and a graph handle all record alike.

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const sampleManager = () => ({
    getOrCreate: (uuid: UUID.Bytes) => ({
        get data() {return Option.None}, get peaks() {return Option.None}, get uuid() {return uuid},
        get state() {return {type: "idle"} as const}, invalidate() {}, subscribe: () => Terminable.Empty
    }), record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
})

const env = (): ProjectEnv => ({
    audioContext: undefined, audioWorklets: undefined, sampleManager: sampleManager(),
    soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
}) as unknown as ProjectEnv

const createFakeWorklet = () => ({
    suspended: new Array<UUID.Bytes>(),
    suspendAutomation(uuid: UUID.Bytes): void {this.suspended.push(uuid)},
    playbackTimestamp: new DefaultObservableValue(0),
    countInBeatsRemaining: new DefaultObservableValue(0),
    position: new DefaultObservableValue<ppqn>(0),
    bpm: new DefaultObservableValue(120),
    isPlaying: new DefaultObservableValue(false),
    isRecording: new DefaultObservableValue(false),
    isCountingIn: new DefaultObservableValue(false),
    markerState: new DefaultObservableValue(null),
    cpuLoad: new DefaultObservableValue(0),
    preferences: {update: () => {}, subscribeAll: () => Terminable.Empty}
})

type Options = {
    target?: "volume" | "mute"
    createTrackUpfront?: boolean
}

const setup = async (options?: Options) => {
    const target = options?.target ?? "volume"
    const {Project} = await import("../project/Project")
    const {RecordAutomation} = await import("./RecordAutomation")
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox}} = skeleton
    const field = target === "volume" ? primaryAudioUnitBox.volume : primaryAudioUnitBox.mute
    if (options?.createTrackUpfront === true) {
        boxGraph.beginTransaction()
        TrackBox.create(boxGraph, UUID.generate(), box => {
            box.type.setValue(TrackType.Value)
            box.tracks.refer(primaryAudioUnitBox.tracks)
            box.target.refer(field)
        })
        boxGraph.endTransaction()
    }
    const project = Project.fromSkeleton(env(), skeleton)
    const audioUnit = project.boxAdapters.adapterFor(primaryAudioUnitBox, AudioUnitBoxAdapter)
    const parameter: AutomatableParameterFieldAdapter =
        project.parameterFieldAdapters.opt(field.address).unwrap("no parameter")
    const worklet = createFakeWorklet()
    project.engine.setWorklet(worklet as unknown as EngineWorklet)
    // A new timeline loops over four bars, which would wrap every take. Tests that want the wrap enable it again.
    project.editing.modify(() => project.timelineBox.loopArea.enabled.setValue(false))
    const recorder = RecordAutomation.start(project)
    const seek = (position: ppqn) => worklet.position.setValue(position)
    const record = (recording: boolean) => worklet.isRecording.setValue(recording)
    const play = (playing: boolean) => worklet.isPlaying.setValue(playing)
    const suspensions = (): ReadonlyArray<UUID.Bytes> => worklet.suspended
    // What Recording does when the transport leaves the recording state: terminating the recorder closes the takes.
    const stop = () => {
        worklet.isRecording.setValue(false)
        recorder.terminate()
    }
    const write = (value: unitValue) => project.editing.modify(() => parameter.setUnitValue(value), false)
    const track = (): Option<TrackBoxAdapter> => audioUnit.tracks.controls(field)
    const regionsOf = (owner: Option<TrackBoxAdapter>): ReadonlyArray<ValueRegionBoxAdapter> =>
        owner.mapOr(track => track.regions.collection.asArray() as ReadonlyArray<ValueRegionBoxAdapter>, [])
    const regions = () => regionsOf(track())
    const events = (index: number = 0) => regions()[index].events.unwrap("no events").asArray()
    // What both engines read: the rightmost region at/before the position (TS `lowerEqual`, wasm
    // `floor_last_index`). `valueAt` itself needs a clip sequencer, which is audio-context only.
    const resolvedAt = (position: ppqn): ValueRegionBoxAdapter =>
        regions().filter(region => region.position <= position).slice(-1)[0]
    const positions = (index: number = 0) => events(index).map(event => event.position)
    const loop = (from: ppqn, to: ppqn) => project.editing.modify(() => {
        const {loopArea} = project.timelineBox
        loopArea.from.setValue(from)
        loopArea.to.setValue(to)
        loopArea.enabled.setValue(true)
    })
    return {
        project, parameter, audioUnit, recorder,
        seek, record, play, stop, suspensions, write, track, regions, regionsOf, events, positions, resolvedAt, loop
    }
}

describe("RecordAutomation", () => {
    describe("gates", () => {
        it("does not record while the transport is not recording", async () => {
            const {write, track} = await setup()
            write(0.25)
            expect(track().isEmpty()).toBe(true)
        })

        it("records without any lane owner registered by the UI", async () => {
            const {record, write, track, regions} = await setup()
            record(true)
            write(0.25)
            expect(track().unwrap("no track").type).toBe(TrackType.Value)
            expect(regions().length).toBe(1)
        })

        it("ignores a write that does not change the value", async () => {
            const {parameter, record, write, track} = await setup()
            record(true)
            write(parameter.getUnitValue())
            expect(track().isEmpty()).toBe(true)
        })

        // Undo, redo and remote sync all land on the field, never on the adapter, so they never open a take.
        it("does not record a field written behind the adapter", async () => {
            const {project, parameter, record, track} = await setup()
            record(true)
            project.editing.modify(() => parameter.field.setValue(-12.0), false)
            expect(track().isEmpty()).toBe(true)
        })

        it("does not record an undo", async () => {
            const {project, record, write, stop, regions} = await setup()
            record(true)
            write(0.25)
            stop()
            const recorded = regions().length
            project.editing.undo()
            expect(regions().length).toBeLessThanOrEqual(recorded)
        })
    })

    describe("opening a take", () => {
        it("opens the region on the very first write", async () => {
            const {record, write, regions} = await setup()
            record(true)
            write(0.25)
            expect(regions().length).toBe(1)
            expect(regions()[0].duration).toBe(PPQN.SemiQuaver)
        })

        it("records a single write, which is all a checkbox ever sends", async () => {
            const {record, seek, write, stop, regions, events} = await setup({target: "mute"})
            record(true)
            write(1.0)
            seek(PPQN.Quarter)
            stop()
            expect(regions().length).toBe(1)
            expect(events()[events().length - 1].value).toBeCloseTo(1.0)
        })

        it("opens the region at the transport position, quantized down to a semiquaver", async () => {
            const {record, seek, write, regions} = await setup()
            record(true)
            seek(PPQN.Quarter + 13)
            write(0.25)
            expect(regions()[0].position).toBe(PPQN.Quarter)
        })

        it("reuses an existing lane instead of creating a second one", async () => {
            const {record, write, audioUnit, regions} = await setup({createTrackUpfront: true})
            record(true)
            write(0.25)
            expect(audioUnit.tracks.values().length).toBe(1)
            expect(regions().length).toBe(1)
        })

        it("seeds the value the parameter held before the take", async () => {
            const {parameter, record, write, events} = await setup()
            record(true)
            const previous = parameter.getUnitValue()
            write(0.25)
            const [first, second] = events()
            expect(events().length).toBe(2)
            expect(first.position).toBe(0)
            expect(first.value).toBeCloseTo(previous)
            expect(second.position).toBe(0)
            expect(second.value).toBeCloseTo(0.25)
        })
    })

    describe("writing events", () => {
        it("overwrites the last event while the position stands still", async () => {
            const {record, write, events} = await setup()
            record(true)
            write(0.25)
            write(0.5)
            write(0.75)
            expect(events().length).toBe(2)
            expect(events()[1].value).toBeCloseTo(0.75)
        })

        it("appends one event per advanced position", async () => {
            const {record, seek, write, positions} = await setup()
            record(true)
            write(0.25)
            seek(PPQN.SemiQuaver)
            write(0.5)
            seek(PPQN.SemiQuaver * 2)
            write(0.75)
            expect(positions()).toEqual([0, 0, PPQN.SemiQuaver, PPQN.SemiQuaver * 2])
        })

        it("ignores writes behind the last recorded position", async () => {
            const {record, seek, write, positions} = await setup()
            record(true)
            write(0.25)
            seek(PPQN.SemiQuaver * 2)
            write(0.5)
            seek(PPQN.SemiQuaver)
            write(0.75)
            expect(positions()).toEqual([0, 0, PPQN.SemiQuaver * 2])
        })

        it("records linear interpolation for a floating parameter", async () => {
            const {record, write, events} = await setup({target: "volume"})
            record(true)
            write(0.25)
            expect(events()[1].interpolation.type).toBe("linear")
        })

        it("records no interpolation for a stepped parameter", async () => {
            const {record, write, events} = await setup({target: "mute"})
            record(true)
            write(1.0)
            expect(events()[1].interpolation.type).toBe("none")
        })
    })

    describe("latching", () => {
        it("keeps the take open across a gap in the writes", async () => {
            const {record, seek, write, regions} = await setup()
            record(true)
            write(0.25)
            seek(PPQN.Bar)
            write(0.5)
            expect(regions().length).toBe(1)
            expect(regions()[0].duration).toBe(PPQN.Bar)
        })

        it("grows the region with the transport position", async () => {
            const {record, seek, write, regions} = await setup()
            record(true)
            write(0.25)
            seek(PPQN.Quarter)
            expect(regions()[0].duration).toBe(PPQN.Quarter)
            seek(PPQN.Bar)
            expect(regions()[0].duration).toBe(PPQN.Bar)
        })

        it("closes the take on transport stop with a quantized duration and a held tail event", async () => {
            const {record, seek, write, stop, regions, events} = await setup()
            record(true)
            write(0.25)
            seek(PPQN.Quarter + 1)
            stop()
            expect(regions()[0].duration).toBe(PPQN.Quarter + PPQN.SemiQuaver)
            const tail = events()[events().length - 1]
            expect(tail.position).toBe(PPQN.Quarter + PPQN.SemiQuaver)
            expect(tail.value).toBeCloseTo(0.25)
        })

        it("deletes a take that ended where it started", async () => {
            const {record, write, stop, regions} = await setup()
            record(true)
            write(0.25)
            stop()
            expect(regions().length).toBe(0)
        })

        it("simplifies collinear events of a floating parameter on close", async () => {
            const {record, seek, write, stop, positions} = await setup()
            record(true)
            write(0.0)
            seek(PPQN.SemiQuaver)
            write(0.25)
            seek(PPQN.SemiQuaver * 2)
            write(0.5)
            stop()
            expect(positions()).toEqual([0, 0, PPQN.SemiQuaver * 2])
        })

        it("keeps a smooth arc within epsilon of every raw sample", async () => {
            // Issue #363: a greedy filter swallowed the whole parabola (max deviation 0.198 = 19.8 x epsilon).
            const {record, seek, write, stop, events} = await setup()
            const spacing = 66
            const count = 116
            const raw = Array.from({length: count}, (_, index) => ({
                position: index * spacing,
                value: 0.9 - 0.8 * (index / (count - 1)) ** 2
            }))
            record(true)
            raw.forEach(({position, value}) => {
                seek(position)
                write(value)
            })
            stop()
            const kept = events()
            expect(kept.length).toBeLessThan(raw.length / 2)
            const valueAt = (position: ppqn): unitValue => {
                const right = kept.findIndex(event => event.position > position)
                const a = kept[right - 1]
                const b = kept[right]
                if (a.position === position) {return a.value}
                return a.value + (position - a.position) / (b.position - a.position) * (b.value - a.value)
            }
            const deviation = raw.reduce((max, {position, value}) =>
                Math.max(max, Math.abs(valueAt(position) - value)), 0)
            expect(deviation).toBeLessThanOrEqual(0.01)
        })

        it("closes the take at the loop end and opens the next one at the loop start", async () => {
            const {record, seek, write, regions, loop} = await setup()
            loop(0, PPQN.Bar)
            record(true)
            seek(PPQN.Quarter)
            write(0.25)
            seek(PPQN.Bar - 1)
            seek(PPQN.SemiQuaver)
            expect(regions().length).toBe(2)
            expect(regions()[0].position).toBe(0)
            expect(regions()[0].duration).toBe(PPQN.SemiQuaver)
            expect(regions()[1].position).toBe(PPQN.Quarter)
            expect(regions()[1].duration).toBe(PPQN.Bar - PPQN.Quarter)
        })
    })

    // #347: while the transport runs, a written parameter takes over from its own curve, so re-recording over
    // an existing take cannot flap between the take being written and the pass underneath it. The geometry
    // still puts the old region at the growing edge, and that no longer matters because nothing reads it.
    describe("manual control while the transport runs", () => {
        it("suspends the lane of a parameter written during playback", async () => {
            const {play, write, track, suspensions} = await setup({createTrackUpfront: true})
            play(true)
            write(0.25)
            expect(suspensions()).toEqual([track().unwrap("no track").uuid])
        })

        it("suspends the lane once, not per write", async () => {
            const {play, seek, write, suspensions} = await setup({createTrackUpfront: true})
            play(true)
            write(0.25)
            seek(PPQN.SemiQuaver)
            write(0.5)
            expect(suspensions().length).toBe(1)
        })

        it("suspends the take's lane while recording over an older pass", async () => {
            const {play, record, seek, write, regions, resolvedAt, suspensions, track, loop} = await setup()
            loop(0, PPQN.Bar)
            play(true)
            record(true)
            write(0.2)
            seek(PPQN.Bar - 1)
            seek(0)
            write(0.8)
            seek(PPQN.SemiQuaver)
            expect(regions().length).toBe(2)
            expect(resolvedAt(PPQN.SemiQuaver).position).toBe(PPQN.SemiQuaver)
            expect(suspensions()).toEqual([track().unwrap("no track").uuid])
        })

        it("does not suspend a parameter that has no lane", async () => {
            const {play, write, suspensions} = await setup()
            play(true)
            write(0.25)
            expect(suspensions()).toEqual([])
        })

        it("does not suspend while the transport is idle", async () => {
            const {write, suspensions} = await setup({createTrackUpfront: true})
            write(0.25)
            expect(suspensions()).toEqual([])
        })

        it("re-arms on pause, so the next run reads the curve until it is written again", async () => {
            const {play, write, suspensions} = await setup({createTrackUpfront: true})
            play(true)
            write(0.25)
            play(false)
            play(true)
            write(0.5)
            expect(suspensions().length).toBe(2)
        })
    })

    describe("living beside existing material", () => {
        // The overlap invariant is what the whole #1054 crash family hangs on, and loop recording is the one
        // path that rewrites a lane's geometry over and over while the transport runs.
        it("leaves a legal track after several loop passes", async () => {
            const {record, seek, write, track, regions, loop} = await setup()
            const {RegionClipResolver} = await import("../ui/timeline/RegionClipResolver")
            loop(0, PPQN.Bar)
            record(true)
            write(0.2)
            const pass = (value: unitValue) => {
                seek(PPQN.Bar - 1)
                seek(0)
                write(value)
                seek(PPQN.Quarter)
            }
            pass(0.4)
            pass(0.6)
            pass(0.8)
            // A pass eats the pass under it as it grows, so the lane holds the take being written plus the
            // remains of the one before it, never a pile that grows with the number of passes.
            expect(regions().length).toBe(2)
            RegionClipResolver.validateTrack(track().unwrap("no track"))
        })

        it("keeps the head and the tail of a region it punches into", async () => {
            const {project, parameter, record, seek, write, stop, regions} = await setup({createTrackUpfront: true})
            const {ValueEventBox, ValueEventCollectionBox, ValueRegionBox} = await import("@opendaw/studio-boxes")
            const {boxGraph} = project
            const trackBox = parameter.track.unwrap("no track").box
            project.editing.modify(() => {
                const collection = ValueEventCollectionBox.create(boxGraph, UUID.generate())
                ValueRegionBox.create(boxGraph, UUID.generate(), box => {
                    box.position.setValue(0)
                    box.duration.setValue(PPQN.Bar)
                    box.loopDuration.setValue(PPQN.Bar)
                    box.events.refer(collection.owners)
                    box.regions.refer(trackBox.regions)
                })
                ValueEventBox.create(boxGraph, UUID.generate(), box => {
                    box.position.setValue(0)
                    box.value.setValue(0.1)
                    box.events.refer(collection.events)
                })
            })
            record(true)
            seek(PPQN.Quarter * 2)
            write(0.9)
            seek(PPQN.Quarter * 3)
            stop()
            const layout = regions().map(region => [region.position, region.duration])
            expect(layout.length).toBe(3)
            expect(layout[0][0]).toBe(0)
            expect(layout[1][0]).toBe(PPQN.Quarter * 2)
            expect(layout[2][0] + layout[2][1]).toBe(PPQN.Bar)
        })

        it("records two parameters at once onto their own lanes", async () => {
            const {project, audioUnit, record, play, seek, write, suspensions, regions, regionsOf} = await setup()
            const {panning} = audioUnit.namedParameter
            const movePanning = (value: unitValue) =>
                project.editing.modify(() => panning.setUnitValue(value), false)
            play(true)
            record(true)
            write(0.25)
            movePanning(0.75)
            seek(PPQN.Quarter)
            write(0.5)
            movePanning(0.25)
            expect(regions().length).toBe(1)
            expect(regionsOf(audioUnit.tracks.controls(panning.field)).length).toBe(1)
            expect(suspensions().length).toBe(2)
        })

        // The suspension listens on the same write notifier as the recorder and runs BEFORE it, so the write
        // that CREATES a lane cannot suspend one yet. That is harmless (a fresh lane has no older curve to
        // fight) and it must stay that way: a parameter that already owns a lane is suspended on its first
        // write, which is the case that matters.
        it("suspends a lane the take itself created from the write after it exists", async () => {
            const {play, record, seek, write, track, suspensions} = await setup()
            play(true)
            record(true)
            write(0.25)
            expect(suspensions()).toEqual([])
            seek(PPQN.SemiQuaver)
            write(0.5)
            expect(suspensions()).toEqual([track().unwrap("no track").uuid])
        })
    })

    // The path the whole rework started from: a mapped controller writes through the adapter like any knob, so
    // it opens a take with no MIDI-specific code in the recorder.
    describe("midi", () => {
        it("records a take driven by a MIDI controller", async () => {
            const {project, parameter, record, regions, events} = await setup({createTrackUpfront: true})
            const {MidiDevices} = await import("../midi/MidiDevices")
            const {MIDIControllerBox} = await import("@opendaw/studio-boxes")
            if (!isDefined(Reflect.get(globalThis, "MIDIInput"))) {
                Reflect.set(globalThis, "MIDIInput", class {})
            }
            const observers: Array<(event: MIDIMessageEvent) => void> = []
            vi.spyOn(MidiDevices, "subscribeMessageEvents").mockImplementation(observer => {
                observers.push(observer)
                return Terminable.Empty
            })
            project.editing.modify(() => MIDIControllerBox.create(project.boxGraph, UUID.generate(), box => {
                box.controllers.refer(project.userInterfaceBoxes[0].midiControllers)
                box.parameter.refer(parameter.field as PrimitiveField<PrimitiveValues, Pointers.MIDIControl | Pointers>)
                box.deviceId.setValue("")
                box.deviceChannel.setValue(-1)
                box.controlId.setValue(7)
            }))
            expect(observers.length).toBe(1)
            record(true)
            observers[0]({data: new Uint8Array([0xB0, 7, 127]), target: null} as unknown as MIDIMessageEvent)
            expect(regions().length).toBe(1)
            expect(events()[events().length - 1].value).toBeCloseTo(1.0)
        })
    })

    describe("modulators", () => {
        const createModulator = async () => {
            const context = await setup()
            const {project} = context
            const box = project.editing.modify(() => Modulators.createLfo(project, "A")).unwrap("no lfo")
            const modulator = project.boxAdapters.adapterFor(box, LfoModulatorBoxAdapter)
            return {...context, box, modulator}
        }

        it("records a modulator's own parameter onto the modulator's lanes", async () => {
            const {project, record, modulator, regionsOf} = await createModulator()
            record(true)
            project.editing.modify(() => modulator.amount.setUnitValue(0.75), false)
            const lane = modulator.tracks.controls(modulator.amount.field)
            expect(lane.nonEmpty()).toBe(true)
            expect(regionsOf(lane).length).toBe(1)
        })

        it("records an assignment's depth onto the driving modulator's lanes", async () => {
            const {project, parameter, record, box, modulator, regionsOf} = await createModulator()
            const modulation = project.editing.modify(() =>
                Modulators.assign(project, box, parameter.modulationTarget)).unwrap("no modulation")
            const {depth} = project.boxAdapters.adapterFor(modulation, ModulationBoxAdapter).namedParameter
            record(true)
            project.editing.modify(() => depth.setUnitValue(0.9), false)
            const lane = modulator.tracks.controls(depth.field)
            expect(lane.nonEmpty()).toBe(true)
            expect(regionsOf(lane).length).toBe(1)
        })

        // What the lane's track header does on delete and on "Remove Automation": walk from the lane to the
        // parameter it targets, and from there to the lane's owner, which for a modulator is the modulator.
        it("removes a modulator lane through the parameter it targets", async () => {
            const {project, record, modulator, regionsOf} = await createModulator()
            record(true)
            project.editing.modify(() => modulator.amount.setUnitValue(0.75), false)
            const lane = modulator.tracks.controls(modulator.amount.field).unwrap("no lane")
            const tracks = lane.target.targetVertex
                .flatMap(vertex => project.parameterFieldAdapters.opt(vertex.address))
                .flatMap(parameter => parameter.optTracks())
                .unwrap("no lane owner")
            project.editing.modify(() => tracks.delete(lane))
            expect(modulator.tracks.controls(modulator.amount.field).isEmpty()).toBe(true)
            expect(regionsOf(Option.None).length).toBe(0)
        })

        it("keeps a modulator's lane off the audio unit", async () => {
            const {project, record, modulator, audioUnit} = await createModulator()
            record(true)
            project.editing.modify(() => modulator.amount.setUnitValue(0.75), false)
            expect(audioUnit.tracks.values().length).toBe(0)
        })
    })
})
