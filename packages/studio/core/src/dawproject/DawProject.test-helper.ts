import * as fs from "node:fs"
import * as path from "node:path"
import {spawnSync} from "node:child_process"
import * as os from "node:os"
import {asDefined, asInstanceOf, Class, isDefined, isInstanceOf, Observer, Option, Subscription, Terminable, UUID} from "@opendaw/lib-std"
import {Box, Field, IndexedBox} from "@opendaw/lib-box"
import {AudioData, AudioInfo, Interpolation, PPQN, TimeBase} from "@opendaw/lib-dsp"
import {AudioSendRouting, AudioUnitType, IconSymbol} from "@opendaw/studio-enums"
import {Peaks} from "@opendaw/lib-fusion"
import {
    AudioBusBox,
    AudioClipBox,
    AudioFileBox,
    AudioPitchStretchBox,
    AudioRegionBox,
    AudioUnitBox,
    AuxSendBox,
    CaptureAudioBox,
    CaptureMidiBox,
    DelayDeviceBox,
    MarkerBox,
    MasteringDeviceBox,
    NoteClipBox,
    NoteEventBox,
    NoteEventCollectionBox,
    NoteRegionBox,
    RootBox,
    SignatureEventBox,
    TrackBox,
    ValueClipBox,
    ValueEventBox,
    ValueEventCollectionBox,
    ValueRegionBox,
    WarpMarkerBox,
    WclapInstrumentBox,
    WclapParameterBox
} from "@opendaw/studio-boxes"
import {
    AudioLease,
    InstrumentFactories,
    InterpolationFieldAdapter,
    ProjectSkeleton,
    SampleLoader,
    SampleLoaderManager,
    SampleLoaderState,
    TrackType
} from "@opendaw/studio-adapters"
import {DeviceState} from "./DeviceState"
import {ProjectMigration} from "../project/ProjectMigration"
import {ProjectEnv} from "../project/ProjectEnv"

export const testFiles = path.resolve(__dirname, "../../../../../test-files")

// the system xmllint against the vendored schemas, a missing xmllint fails the test
export const validate = (xml: string, schema: "Project" | "MetaData"): string => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dawproject-"))
    const file = path.join(directory, `${schema}.xml`)
    fs.writeFileSync(file, xml)
    const xsd = path.resolve(__dirname, `../../../../lib/dawproject/xsd/${schema}.xsd`)
    const result = spawnSync("xmllint", ["--noout", "--schema", xsd, file], {encoding: "utf-8"})
    fs.rmSync(directory, {recursive: true, force: true})
    if (isDefined(result.error)) {return `xmllint failed: ${result.error.message}`}
    return result.status === 0 ? "valid" : result.stderr.split(file).join(schema).trim()
}

// as the studio has it: decoded and migrated
export const loadSkeleton = async (file: string): Promise<ProjectSkeleton> => {
    const buffer = fs.readFileSync(path.join(testFiles, file))
    const skeleton = ProjectSkeleton.decode(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))
    await ProjectMigration.migrate({sampleManager: silentSamples()} as unknown as ProjectEnv, skeleton)
    return skeleton
}

// every sample is a short silent stereo file
export const silentSamples = (): SampleLoaderManager => {
    const loaders = UUID.newSet<{ uuid: UUID.Bytes, loader: SampleLoader }>(({uuid}) => uuid)
    return {
        record: () => {},
        remove: () => {},
        invalidate: () => {},
        register: () => Terminable.Empty,
        getOrCreate: (uuid: UUID.Bytes): SampleLoader => loaders.opt(uuid).match({
            some: ({loader}) => loader,
            none: () => {
                const data = AudioData.create(44100, 4410, 2)
                const loader: SampleLoader = {
                    uuid,
                    data: Option.wrap(data),
                    info: Option.wrap<AudioInfo>(data),
                    peaks: Option.None as Option<Peaks>,
                    meta: Option.None,
                    state: {type: "loaded"} as SampleLoaderState,
                    invalidate: () => {},
                    subscribe: (observer: Observer<SampleLoaderState>): Subscription => {
                        queueMicrotask(() => observer({type: "loaded"}))
                        return Terminable.Empty
                    },
                    acquire: (): Promise<AudioLease> => Promise.resolve({data, terminate: () => {}})
                }
                loaders.add({uuid, loader})
                return loader
            }
        })
    }
}

const sortedBy = <T>(items: ReadonlyArray<T>, key: (item: T) => number): ReadonlyArray<T> =>
    [...items].sort((left, right) => key(left) - key(right))

const incoming = <T extends Box>(field: { pointerHub: { incoming(): ReadonlyArray<{ box: Box }> } },
                                 clazz: Class<T>): ReadonlyArray<T> =>
    field.pointerHub.incoming().map(({box}) => asInstanceOf(box, clazz))

// what DAWproject carries of a project, everything listed in the docs as not representable is left out
export const describeProject = (skeleton: ProjectSkeleton) => {
    const {boxGraph, mandatoryBoxes: {rootBox, timelineBox}} = skeleton
    const uuid = (box: Box) => UUID.toString(box.address.uuid)
    const notes = (collection: NoteEventCollectionBox) => ({
        collection: uuid(collection),
        notes: sortedBy(incoming(collection.events, NoteEventBox), event => event.position.getValue() * 128 + event.pitch.getValue())
            .map(event => ({
                position: event.position.getValue(), duration: event.duration.getValue(), pitch: event.pitch.getValue(),
                velocity: event.velocity.getValue(), cent: event.cent.getValue()
            }))
    })
    const values = (collection: ValueEventCollectionBox) => ({
        collection: uuid(collection),
        events: sortedBy(incoming(collection.events, ValueEventBox), event => event.position.getValue() * 1024 + event.index.getValue())
            .map(event => ({
                position: event.position.getValue(), index: event.index.getValue(), value: event.value.getValue(),
                hold: InterpolationFieldAdapter.read(event.interpolation).type === "none"
            }))
    })
    const audio = (file: AudioFileBox, playMode: Option<Box>, waveformOffset: number) => {
        const markers = playMode.mapOr(box => {
            const field = Reflect.get(box, "warpMarkers")
            return isDefined(field) ? sortedBy(incoming(field, WarpMarkerBox), marker => marker.position.getValue())
                .map(marker => ({position: marker.position.getValue(), seconds: Math.fround(marker.seconds.getValue() + waveformOffset)})) : []
        }, [])
        return {file: uuid(file), playMode: playMode.mapOr(box => box.name === "AudioPitchStretchBox" ? "repitch" : "stretch", "none"), markers,
            waveformOffset: playMode.isEmpty() ? waveformOffset : 0}
    }
    const region = (box: Box) => {
        if (isInstanceOf(box, NoteRegionBox)) {
            return {
                kind: "notes" as const, position: box.position.getValue(), duration: box.duration.getValue(),
                loopOffset: box.loopOffset.getValue(), loopDuration: box.loopDuration.getValue(),
                label: box.label.getValue(), hue: box.hue.getValue(), mute: box.mute.getValue(),
                content: notes(asInstanceOf(box.events.targetVertex.unwrap().box, NoteEventCollectionBox))
            }
        }
        if (isInstanceOf(box, ValueRegionBox)) {
            return {
                kind: "values" as const, position: box.position.getValue(), duration: box.duration.getValue(),
                loopOffset: box.loopOffset.getValue(), loopDuration: box.loopDuration.getValue(),
                label: box.label.getValue(), hue: box.hue.getValue(), mute: box.mute.getValue(),
                content: values(asInstanceOf(box.events.targetVertex.unwrap().box, ValueEventCollectionBox))
            }
        }
        const audioRegion = asInstanceOf(box, AudioRegionBox)
        return {
            kind: "audio" as const, position: audioRegion.position.getValue(), duration: audioRegion.duration.getValue(),
            loopOffset: audioRegion.loopOffset.getValue(), loopDuration: audioRegion.loopDuration.getValue(),
            timeBase: audioRegion.timeBase.getValue(), label: audioRegion.label.getValue(), hue: audioRegion.hue.getValue(),
            mute: audioRegion.mute.getValue(),
            fading: [audioRegion.fading.in.getValue(), audioRegion.fading.out.getValue()],
            content: audio(asInstanceOf(audioRegion.file.targetVertex.unwrap().box, AudioFileBox),
                audioRegion.playMode.targetVertex.map(({box}) => box), audioRegion.waveformOffset.getValue())
        }
    }
    const clip = (box: Box) => {
        if (isInstanceOf(box, NoteClipBox)) {
            return {kind: "notes", index: box.index.getValue(), duration: box.duration.getValue(), label: box.label.getValue(),
                hue: box.hue.getValue(), mute: box.mute.getValue(), loop: box.triggerMode.loop.getValue(),
                content: notes(asInstanceOf(box.events.targetVertex.unwrap().box, NoteEventCollectionBox))}
        }
        if (isInstanceOf(box, ValueClipBox)) {
            return {kind: "values", index: box.index.getValue(), duration: box.duration.getValue(), label: box.label.getValue(),
                hue: box.hue.getValue(), mute: box.mute.getValue(), loop: box.triggerMode.loop.getValue(),
                content: values(asInstanceOf(box.events.targetVertex.unwrap().box, ValueEventCollectionBox))}
        }
        const audioClip = asInstanceOf(box, AudioClipBox)
        return {kind: "audio", index: audioClip.index.getValue(), duration: audioClip.duration.getValue(),
            label: audioClip.label.getValue(), hue: audioClip.hue.getValue(), mute: audioClip.mute.getValue(),
            loop: audioClip.triggerMode.loop.getValue(),
            content: audio(asInstanceOf(audioClip.file.targetVertex.unwrap().box, AudioFileBox),
                audioClip.playMode.targetVertex.map(({box}) => box), audioClip.waveformOffset.getValue())}
    }
    // the root, timeline and global groove are new boxes in every project, their uuids are masked
    const globals = [rootBox, timelineBox, ...rootBox.groove.targetVertex.mapOr(({box}) => [box], [])]
        .map(box => Array.from(box.address.uuid))
    const masked = (bytes: Uint8Array): ReadonlyArray<number> => {
        const array = Array.from(bytes)
        globals.forEach(global => {
            for (let index = 0; index <= array.length - 16; index++) {
                if (global.every((byte, offset) => array[index + offset] === byte)) {array.fill(0, index, index + 16)}
            }
        })
        return array
    }
    const device = (box: Box) => ({name: box.name, uuid: uuid(box), state: masked(new Uint8Array(DeviceState.encode(box, [rootBox, timelineBox])))})
    const units = sortedBy(incoming(rootBox.audioUnits, AudioUnitBox), unit => unit.index.getValue()).map(unit => {
        const input = unit.input.pointerHub.incoming().at(0)?.box
        return {
            uuid: uuid(unit), type: unit.type.getValue(), index: unit.index.getValue(),
            volume: unit.volume.getValue(), panning: unit.panning.getValue(), mute: unit.mute.getValue(), solo: unit.solo.getValue(),
            output: unit.output.targetVertex.mapOr(vertex => isInstanceOf(vertex.box, RootBox) ? "root" : uuid(vertex.box), "none"),
            input: isInstanceOf(input, AudioBusBox) ? {bus: uuid(input), label: input.label.getValue()} : isDefined(input) ? device(input) : "none",
            midiEffects: IndexedBox.collectIndexedBoxes(unit.midiEffects).map(device),
            audioEffects: IndexedBox.collectIndexedBoxes(unit.audioEffects).map(device),
            mastering: unit.mastering.pointerHub.incoming().map(({box}) => device(box)),
            sends: sortedBy(incoming(unit.auxSends, AuxSendBox), send => send.index.getValue()).map(send => ({
                uuid: uuid(send), routing: send.routing.getValue(), gain: send.sendGain.getValue(), pan: send.sendPan.getValue(),
                target: send.targetBus.targetVertex.mapOr(vertex => uuid(vertex.box), "none")
            })),
            tracks: sortedBy(incoming(unit.tracks, TrackBox), track => track.index.getValue()).map(track => ({
                uuid: uuid(track), type: track.type.getValue(), index: track.index.getValue(),
                target: track.type.getValue() === TrackType.Value ? track.target.targetAddress.mapOr(address => address.toString(), "none") : "unit",
                regions: sortedBy(track.regions.pointerHub.incoming().map(({box}) => box),
                    box => asDefined(Reflect.get(box, "position")).getValue()).map(region),
                clips: sortedBy(track.clips.pointerHub.incoming().map(({box}) => box),
                    box => IndexedBox.isIndexedBox(box) ? box.index.getValue() : 0).map(clip)
            }))
        }
    })
    const tempoEvents = timelineBox.tempoTrack.enabled.getValue()
        ? timelineBox.tempoTrack.events.targetVertex.mapOr(({box}) => values(asInstanceOf(box, ValueEventCollectionBox)).events, [])
        : []
    return {
        bpm: timelineBox.bpm.getValue(),
        signature: [timelineBox.signature.nominator.getValue(), timelineBox.signature.denominator.getValue()],
        tempoRange: [timelineBox.tempoTrack.minBpm.getValue(), timelineBox.tempoTrack.maxBpm.getValue()],
        tempoEvents,
        signatureEvents: timelineBox.signatureTrack.enabled.getValue()
            ? sortedBy(incoming(timelineBox.signatureTrack.events, SignatureEventBox), event => event.index.getValue())
                .map(event => [event.relativePosition.getValue(), event.nominator.getValue(), event.denominator.getValue()])
            : [],
        markers: sortedBy(incoming(timelineBox.markerTrack.markers, MarkerBox), marker => marker.position.getValue())
            .map(marker => ({position: marker.position.getValue(), label: marker.label.getValue(), hue: marker.hue.getValue()})),
        units,
        samples: boxGraph.boxes().filter(box => isInstanceOf(box, AudioFileBox)).map(uuid).sort()
    }
}


const Bar = PPQN.Bar
const Beat = PPQN.Quarter

// one of everything DAWproject can carry
export const buildProject = (): ProjectSkeleton => {
    const skeleton = ProjectSkeleton.empty({createOutputMaximizer: true, createDefaultUser: true})
    const {boxGraph, mandatoryBoxes: {rootBox, timelineBox, primaryAudioBusBox, primaryAudioUnitBox}} = skeleton
    boxGraph.beginTransaction()
    timelineBox.bpm.setValue(123.5)
    timelineBox.signature.nominator.setValue(3)
    timelineBox.signature.denominator.setValue(4)
    const tempo = asInstanceOf(timelineBox.tempoTrack.events.targetVertex.unwrap().box, ValueEventCollectionBox)
    ;[[0, 123.5, Interpolation.Linear], [4 * Bar, 140, Interpolation.None], [8 * Bar, 100, Interpolation.Linear]]
        .forEach(([position, value, interpolation], index) => {
            const event = ValueEventBox.create(boxGraph, UUID.generate(), box => {
                box.position.setValue(position as number)
                box.index.setValue(index === 1 ? 0 : 0)
                box.value.setValue(value as number)
                box.events.refer(tempo.events)
            })
            InterpolationFieldAdapter.write(event.interpolation, interpolation as Interpolation)
        })
    SignatureEventBox.create(boxGraph, UUID.generate(), box => {
        box.index.setValue(0)
        box.relativePosition.setValue(2)
        box.nominator.setValue(7)
        box.denominator.setValue(8)
        box.events.refer(timelineBox.signatureTrack.events)
    })
    ;[[0, "Intro", 10], [8 * Bar, "Drop & <Build>", 200]].forEach(([position, label, hue]) =>
        MarkerBox.create(boxGraph, UUID.generate(), box => {
            box.position.setValue(position as number)
            box.label.setValue(label as string)
            box.hue.setValue(hue as number)
            box.track.refer(timelineBox.markerTrack.markers)
        }))
    const createBus = (type: AudioUnitType, label: string, index: number) => {
        const unit = AudioUnitBox.create(boxGraph, UUID.generate(), box => {
            box.collection.refer(rootBox.audioUnits)
            box.type.setValue(type)
            box.index.setValue(index)
            box.output.refer(primaryAudioBusBox.input)
            box.volume.setValue(-3.5)
        })
        const bus = AudioBusBox.create(boxGraph, UUID.generate(), box => {
            box.collection.refer(rootBox.audioBusses)
            box.label.setValue(label)
            box.icon.setValue(IconSymbol.toName(IconSymbol.AudioBus))
            box.color.setValue("hsl(31, 100%, 73%)")
            box.output.refer(unit.input)
        })
        return {unit, bus}
    }
    const aux = createBus(AudioUnitType.Aux, "Reverb Return", 3)
    const group = createBus(AudioUnitType.Bus, "Drums", 4)
    const createInstrument = (index: number, audio: boolean) => {
        const capture = audio ? CaptureAudioBox.create(boxGraph, UUID.generate()) : CaptureMidiBox.create(boxGraph, UUID.generate())
        return AudioUnitBox.create(boxGraph, UUID.generate(), box => {
            box.collection.refer(rootBox.audioUnits)
            box.type.setValue(AudioUnitType.Instrument)
            box.index.setValue(index)
            box.output.refer(group.bus.input)
            box.capture.refer(capture)
        })
    }
    const synth = createInstrument(0, false)
    synth.panning.setValue(-0.25)
    synth.mute.setValue(true)
    InstrumentFactories.Vaporisateur.create(boxGraph, synth.input, "Lead", IconSymbol.Piano)
    const delay = DelayDeviceBox.create(boxGraph, UUID.generate(), box => {
        box.host.refer(synth.audioEffects)
        box.index.setValue(0)
        box.label.setValue("Echo")
        box.enabled.setValue(false)
    })
    AuxSendBox.create(boxGraph, UUID.generate(), box => {
        box.audioUnit.refer(synth.auxSends)
        box.targetBus.refer(aux.bus.input)
        box.routing.setValue(AudioSendRouting.Pre)
        box.sendGain.setValue(-6.0)
        box.sendPan.setValue(0.5)
        box.index.setValue(0)
    })
    const track = (unit: AudioUnitBox, type: TrackType, index: number, target?: Field) =>
        TrackBox.create(boxGraph, UUID.generate(), box => {
            box.tracks.refer(unit.tracks)
            box.target.refer(target ?? unit)
            box.type.setValue(type)
            box.index.setValue(index)
        })
    const notesA = track(synth, TrackType.Notes, 0)
    const notesB = track(synth, TrackType.Notes, 1)
    const delayWet = track(synth, TrackType.Value, 2, delay.wet)
    const volume = track(synth, TrackType.Value, 3, synth.volume)
    const mute = track(synth, TrackType.Value, 4, synth.mute)
    track(synth, TrackType.Value, 5, synth.panning)
    const shared = NoteEventCollectionBox.create(boxGraph, UUID.generate())
    ;[[0, 60, 0.5, 0], [Beat, 64, 1.0, -25.5], [2 * Beat, 67, 0.25, 50]].forEach(([position, pitch, velocity, cent]) =>
        NoteEventBox.create(boxGraph, UUID.generate(), box => {
            box.position.setValue(position)
            box.duration.setValue(Beat / 2)
            box.pitch.setValue(pitch)
            box.velocity.setValue(velocity)
            box.cent.setValue(cent)
            box.events.refer(shared.events)
        }))
    const noteRegion = (track: TrackBox, position: number, loopOffset: number, label: string) =>
        NoteRegionBox.create(boxGraph, UUID.generate(), box => {
            box.position.setValue(position)
            box.duration.setValue(2 * Bar)
            box.loopOffset.setValue(loopOffset)
            box.loopDuration.setValue(Bar)
            box.label.setValue(label)
            box.hue.setValue(123)
            box.events.refer(shared.owners)
            box.regions.refer(track.regions)
        })
    noteRegion(notesA, 0, 0, "Mirror A")
    noteRegion(notesA, 4 * Bar, Beat, "Mirror B")
    noteRegion(notesB, Bar, 0, "")
    const valueRegion = (track: TrackBox, values: ReadonlyArray<[number, number, Interpolation]>) => {
        const events = ValueEventCollectionBox.create(boxGraph, UUID.generate())
        values.forEach(([position, value, interpolation], index) => {
            const event = ValueEventBox.create(boxGraph, UUID.generate(), box => {
                box.position.setValue(position)
                box.index.setValue(values.slice(0, index).filter(([other]) => other === position).length)
                box.value.setValue(value)
                box.events.refer(events.events)
            })
            InterpolationFieldAdapter.write(event.interpolation, interpolation)
        })
        ValueRegionBox.create(boxGraph, UUID.generate(), box => {
            box.position.setValue(Bar)
            box.duration.setValue(4 * Bar)
            box.loopDuration.setValue(2 * Bar)
            box.label.setValue("Automation")
            box.events.refer(events.owners)
            box.regions.refer(track.regions)
        })
        return events
    }
    valueRegion(delayWet, [[0, 0.25, Interpolation.Linear], [Bar, 0.75, Interpolation.None], [Bar, 0.5, Interpolation.Linear]])
    valueRegion(volume, [[0, 0.5, Interpolation.Linear], [Bar, 0.1, Interpolation.Linear]])
    valueRegion(mute, [[0, 0.0, Interpolation.None], [Bar, 1.0, Interpolation.None]])
    NoteClipBox.create(boxGraph, UUID.generate(), box => {
        box.index.setValue(1)
        box.duration.setValue(Bar)
        box.label.setValue("Clip")
        box.events.refer(shared.owners)
        box.clips.refer(notesB.clips)
        box.triggerMode.loop.setValue(false)
    })
    const clipEvents = ValueEventCollectionBox.create(boxGraph, UUID.generate())
    ValueClipBox.create(boxGraph, UUID.generate(), box => {
        box.index.setValue(0)
        box.duration.setValue(Bar)
        box.events.refer(clipEvents.owners)
        box.clips.refer(volume.clips)
    })
    const sampler = createInstrument(1, true)
    InstrumentFactories.Tape.create(boxGraph, sampler.input, "Loops", IconSymbol.Waveform)
    const audioTrack = track(sampler, TrackType.Audio, 0)
    const file = AudioFileBox.create(boxGraph, UUID.generate(), box => {
        box.fileName.setValue("Loop 01")
        box.endInSeconds.setValue(0.1)
    })
    const secondsEvents = ValueEventCollectionBox.create(boxGraph, UUID.generate())
    AudioRegionBox.create(boxGraph, UUID.generate(), box => {
        box.position.setValue(0)
        box.duration.setValue(1.5)
        box.loopOffset.setValue(0.025)
        box.loopDuration.setValue(0.075)
        box.waveformOffset.setValue(0.0125)
        box.timeBase.setValue(TimeBase.Seconds)
        box.label.setValue("Seconds")
        box.hue.setValue(200)
        box.file.refer(file)
        box.events.refer(secondsEvents.owners)
        box.regions.refer(audioTrack.regions)
    })
    const pitch = AudioPitchStretchBox.create(boxGraph, UUID.generate())
    ;[[0, 0.0], [Bar, 0.05], [2 * Bar, 0.1]].forEach(([position, seconds]) => WarpMarkerBox.create(boxGraph, UUID.generate(), box => {
        box.owner.refer(pitch.warpMarkers)
        box.position.setValue(position)
        box.seconds.setValue(seconds)
    }))
    const warpedEvents = ValueEventCollectionBox.create(boxGraph, UUID.generate())
    AudioRegionBox.create(boxGraph, UUID.generate(), box => {
        box.position.setValue(4 * Bar)
        box.duration.setValue(4 * Bar)
        box.loopDuration.setValue(2 * Bar)
        box.timeBase.setValue(TimeBase.Musical)
        box.label.setValue("Warped")
        box.hue.setValue(30)
        box.fading.in.setValue(Beat / 4)
        box.fading.out.setValue(Beat)
        box.file.refer(file)
        box.playMode.refer(pitch)
        box.events.refer(warpedEvents.owners)
        box.regions.refer(audioTrack.regions)
    })
    const clipEvents2 = ValueEventCollectionBox.create(boxGraph, UUID.generate())
    AudioClipBox.create(boxGraph, UUID.generate(), box => {
        box.index.setValue(0)
        box.duration.setValue(0.05)
        box.timeBase.setValue(TimeBase.Seconds)
        box.waveformOffset.setValue(0.025)
        box.label.setValue("One Shot")
        box.file.refer(file)
        box.events.refer(clipEvents2.owners)
        box.clips.refer(audioTrack.clips)
        box.triggerMode.loop.setValue(false)
    })
    const plugin = createInstrument(2, false)
    const wclap = InstrumentFactories.Wclap.create(boxGraph, plugin.input, "Surge XT", IconSymbol.WebClap)
    const wclapBox = asInstanceOf(wclap, WclapInstrumentBox)
    wclapBox.url.setValue("local:surge")
    wclapBox.clapId.setValue("org.surge-synth-team.surge-xt")
    wclapBox.pluginState.setValue(new Int8Array([1, 2, 3, -1]))
    const drive = WclapParameterBox.create(boxGraph, UUID.generate(), box => {
        box.owner.refer(wclapBox.parameters)
        box.label.setValue("A Waveshaper Drive")
        box.clapId.setValue(1243907205)
        box.min.setValue(0.0)
        box.max.setValue(2.0)
        box.value.setValue(1.25)
    })
    track(plugin, TrackType.Notes, 0)
    track(plugin, TrackType.Value, 1, drive.value)
    MasteringDeviceBox.create(boxGraph, UUID.generate(), box => box.host.refer(primaryAudioUnitBox.mastering))
    primaryAudioUnitBox.index.setValue(5)
    boxGraph.endTransaction()
    boxGraph.verifyPointers()
    return skeleton
}

