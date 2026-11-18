import {
    Arrays,
    asInstanceOf,
    clamp,
    Color,
    int,
    isDefined,
    isInstanceOf,
    Option,
    Optional,
    Provider,
    tryCatch,
    UUID,
    ValueMapping
} from "@opendaw/lib-std"
import {Address, BooleanField, Box, BoxGraph, Field, IndexedBox, PointerField} from "@opendaw/lib-box"
import {gainToDb, Interpolation as DspInterpolation, ppqn, PPQN, seconds, ValueEvent} from "@opendaw/lib-dsp"
import {
    AudioSchema,
    BoolPointSchema,
    ChannelSchema,
    ClapPluginSchema,
    ClapPreset,
    ClipSchema,
    ClipSlotSchema,
    ClipsSchema,
    ContentType,
    DeviceRole,
    DeviceSchema,
    EqualizerSchema,
    ExpressionType,
    IntegerPointSchema,
    Interpolation,
    LanesSchema,
    MarkersSchema,
    MixerRole,
    NotesSchema,
    ParameterSchema,
    PointsSchema,
    ProjectSchema,
    RealParameterSchema,
    RealPointSchema,
    SendType,
    TimelineSchema,
    TimeSignaturePointSchema,
    TimeUnit,
    TrackSchema,
    TransportSchema,
    Unit,
    WarpsSchema
} from "@opendaw/lib-dawproject"
import {AudioSendRouting, AudioUnitType, IconSymbol, Pointers} from "@opendaw/studio-enums"
import {
    AudioBusBox,
    AudioClipBox,
    AudioFileBox,
    AudioPitchStretchBox,
    AudioRegionBox,
    AudioTimeStretchBox,
    AudioUnitBox,
    AuxSendBox,
    BoxIO,
    CaptureAudioBox,
    CaptureMidiBox,
    GrooveShuffleBox,
    MarkerBox,
    NoteClipBox,
    NoteEventBox,
    NoteEventCollectionBox,
    NoteRegionBox,
    RootBox,
    SignatureEventBox,
    TimelineBox,
    TrackBox,
    UnknownAudioEffectDeviceBox,
    UnknownMidiEffectDeviceBox,
    UserInterfaceBox,
    ValueClipBox,
    ValueEventBox,
    ValueEventCollectionBox,
    ValueRegionBox,
    WarpMarkerBox,
    WclapDeviceBox,
    WclapInstrumentBox,
    WclapMidiEffectBox,
    WclapParameterBox
} from "@opendaw/studio-boxes"
import {
    AudioUnitBoxAdapter,
    AudioUnitOrdering,
    ColorCodes,
    DeviceBoxUtils,
    InstrumentFactories,
    InterpolationFieldAdapter,
    ProjectSkeleton,
    TempoGridCursor,
    TempoRange,
    TrackType
} from "@opendaw/studio-adapters"
import {DawProject} from "./DawProject"
import {BuiltinDevices} from "./BuiltinDevices"
import {DawProjectIds} from "./DawProjectIds"
import {DawProjectExporter} from "./DawProjectExporter"
import {DeviceState} from "./DeviceState"
import {WclapBoxes} from "../wclap/WclapBoxes"
import {WclapParameters} from "../wclap/WclapParameters"

export namespace DawProjectImport {
    export type Result = {
        audioIds: ReadonlyArray<UUID.Bytes>
        skeleton: ProjectSkeleton
        issues: ReadonlyArray<string>
    }

    export interface Options {
        // the url of a WebCLAP bundle holding the CLAP plugin with that id
        readonly resolveClap?: (pluginId: string) => Promise<Option<string>>
    }

    type Unit = { readonly box: AudioUnitBox, readonly schema: TrackSchema, readonly channel: ChannelSchema }
    type ParameterTarget = { readonly field: Field, readonly schema: Optional<ParameterSchema> }
    type LoopWindow = { readonly shift: number, readonly loopOffset: number, readonly loopDuration: number }

    const toPulses = (beats: number): number => beats * PPQN.Quarter
    const toPulsesInt = (beats: number): int => Math.round(beats * PPQN.Quarter)

    export const read = async (schema: ProjectSchema,
                               resources: DawProject.ResourceProvider,
                               options: Options = {}): Promise<Result> => {
        const issues: Array<string> = []
        const fromOpenDAW = schema.application?.name === "openDAW"
        const boxGraph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
        boxGraph.beginTransaction()
        const isoString = new Date().toISOString()
        const grooveShuffleBox = GrooveShuffleBox.create(boxGraph, UUID.generate(), box => box.label.setValue("Global Shuffle"))
        const tempoAddress = isDefined(schema.transport?.tempo?.id)
            ? DawProjectIds.toAddress(schema.transport.tempo.id).unwrapOrUndefined() : undefined
        const timelineBox = TimelineBox.create(boxGraph, tempoAddress?.uuid ?? UUID.generate())
        const rootBox = RootBox.create(boxGraph, UUID.generate(), box => {
            box.groove.refer(grooveShuffleBox)
            box.created.setValue(isoString)
            box.timeline.refer(timelineBox.root)
        })
        grooveShuffleBox.collection.refer(rootBox.grooves)
        const userInterfaceBox = UserInterfaceBox.create(boxGraph, UUID.generate(), box => box.root.refer(rootBox.users))
        const resourceOf = (path: string): Option<DawProject.Resource> => {
            const resource = tryCatch(() => resources.fromPath(path))
            return resource.status === "success" ? Option.wrap(resource.value) : Option.None
        }
        // a uuid from the element id when an openDAW export wrote it there and it is still free
        const uuidOf = (id: Optional<string>): UUID.Bytes => {
            const address = isDefined(id) ? DawProjectIds.toAddress(id).unwrapOrUndefined() : undefined
            return isDefined(address) && address.isBox() && boxGraph.findBox(address.uuid).isEmpty()
                ? address.uuid : UUID.generate()
        }
        readTransport(schema.transport, timelineBox)
        const tempoEvents = readTempoAutomation(schema, timelineBox, boxGraph)
        readSignatureAutomation(schema, timelineBox, boxGraph)
        readMarkers(schema.arrangement?.markers, timelineBox, boxGraph)
        const tempoCursor = new TempoGridCursor()
        const storageBpm = timelineBox.bpm.getValue()
        const pulsesToSeconds = (from: ppqn, duration: number): seconds => tempoEvents.length === 0
            ? PPQN.pulsesToSeconds(duration, storageBpm)
            : tempoCursor.integrate(tempoEvents, from, from + duration, storageBpm)
        const secondsToPulses = (from: ppqn, duration: seconds): number => tempoEvents.length === 0
            ? PPQN.secondsToPulses(duration, storageBpm)
            : tempoCursor.advance(tempoEvents, from, 0.0, duration, storageBpm) - from
        const units: Array<Unit> = []
        const unitsById = new Map<string, Unit>()
        const busesByChannel = new Map<string, AudioBusBox>()
        const parameters = new Map<string, ParameterTarget>()
        const routes: Array<{ readonly destination: Optional<string>, readonly fallback: Optional<AudioBusBox>, readonly unit: Unit }> = []
        const primary: { bus: Optional<AudioBusBox>, unit: Optional<AudioUnitBox> } = {bus: undefined, unit: undefined}
        const registerParameter = (schema: Optional<ParameterSchema>, field: Field): void => {
            if (isDefined(schema?.id)) {parameters.set(schema.id, {field, schema})}
        }
        const createAudioBus = (channel: ChannelSchema, unit: AudioUnitBox, name: string, type: AudioUnitType,
                                color: Optional<string>): AudioBusBox => AudioBusBox.create(boxGraph, uuidOf(channel.id), box => {
            box.collection.refer(rootBox.audioBusses)
            box.label.setValue(name)
            box.icon.setValue(IconSymbol.toName(iconOf(type)))
            box.color.setValue(isDefined(color) && /^#[0-9a-fA-F]{6}$/.test(color)
                ? hslStringOf(color) : ColorCodes.forAudioType(type).toString())
            box.enabled.setValue(true)
            box.output.refer(unit.input)
        })
        const readTrack = (track: TrackSchema, parentBus: Optional<AudioBusBox>, depth: int): void => {
            const channel = track.channel
            if (!isDefined(channel)) {
                track.tracks.forEach(child => readTrack(child, parentBus, depth + 1))
                return
            }
            const type = unitTypeOf(track, channel, depth, isDefined(primary.unit))
            if (!isDefined(type)) {
                issues.push(`Track '${track.name ?? ""}' is a ${channel.role} track, which openDAW does not have.`)
                track.tracks.forEach(child => readTrack(child, parentBus, depth + 1))
                return
            }
            const box = AudioUnitBox.create(boxGraph, uuidOf(track.id), box => {
                box.collection.refer(rootBox.audioUnits)
                box.type.setValue(type)
                box.volume.setValue(readVolume(channel.volume))
                box.panning.setValue(readPan(channel.pan))
                box.mute.setValue(channel.mute?.value === true)
                box.solo.setValue(channel.solo === true)
            })
            const unit: Unit = {box, schema: track, channel}
            units.push(unit)
            if (isDefined(track.id)) {unitsById.set(track.id, unit)}
            if (isDefined(channel.id)) {unitsById.set(channel.id, unit)}
            registerParameter(channel.volume, box.volume)
            registerParameter(channel.pan, box.panning)
            registerParameter(channel.mute, box.mute)
            if (type === AudioUnitType.Instrument) {
                routes.push({destination: channel.destination, fallback: parentBus, unit})
                track.tracks.forEach(child => readTrack(child, parentBus, depth + 1))
                return
            }
            const bus = createAudioBus(channel, box, track.name ?? "", type, track.color)
            if (isDefined(channel.id)) {busesByChannel.set(channel.id, bus)}
            if (type === AudioUnitType.Output) {
                box.output.refer(rootBox.outputDevice)
                primary.bus = bus
                primary.unit = box
            } else {
                routes.push({destination: channel.destination, fallback: parentBus, unit})
            }
            track.tracks.forEach(child => readTrack(child, bus, depth + 1))
        }
        schema.structure.forEach(lane => {
            if (isInstanceOf(lane, TrackSchema)) {
                readTrack(lane, undefined, 0)
            } else if (isInstanceOf(lane, ChannelSchema)) {
                readTrack(Object.assign(Object.create(TrackSchema.prototype), {id: lane.id, name: lane.name, channel: lane, tracks: []}), undefined, 0)
            }
        })
        if (!isDefined(primary.unit) || !isDefined(primary.bus)) {
            const box = AudioUnitBox.create(boxGraph, UUID.generate(), box => {
                box.collection.refer(rootBox.audioUnits)
                box.type.setValue(AudioUnitType.Output)
                box.output.refer(rootBox.outputDevice)
            })
            primary.unit = box
            primary.bus = AudioBusBox.create(boxGraph, UUID.generate(), bus => {
                bus.collection.refer(rootBox.audioBusses)
                bus.label.setValue("Output")
                bus.icon.setValue(IconSymbol.toName(IconSymbol.SpeakerHeadphone))
                bus.color.setValue(ColorCodes.forAudioType(AudioUnitType.Output).toString())
                bus.enabled.setValue(true)
                bus.output.refer(box.input)
            })
        }
        const primaryBus: AudioBusBox = primary.bus
        const primaryUnit: AudioUnitBox = primary.unit
        routes.forEach(({destination, fallback, unit}) => {
            if (fromOpenDAW && !isDefined(destination)) {return}
            const target = isDefined(destination) ? busesByChannel.get(destination) : undefined
            if (isDefined(destination) && !isDefined(target)) {
                issues.push(`The output of '${unit.schema.name ?? ""}' could not be found, it plays into the master.`)
            }
            unit.box.output.refer((target ?? fallback ?? primaryBus).input)
        })
        if (!isDefined(timelineBox.tempoTrack.events.targetVertex.unwrapOrUndefined())) {
            ValueEventCollectionBox.create(boxGraph, UUID.generate(), box => timelineBox.tempoTrack.events.refer(box.owners))
        }
        if (isDefined(schema.transport?.tempo?.id)) {
            parameters.set(schema.transport.tempo.id, {field: timelineBox.bpm, schema: schema.transport.tempo})
        }
        const audioIds = UUID.newSet<UUID.Bytes>(uuid => uuid)
        const collectAudioFiles = (boxes: ReadonlyArray<Box>): void => boxes
            .filter((box): box is AudioFileBox => isInstanceOf(box, AudioFileBox))
            .forEach(box => {
                if (tryCatch(() => resources.fromUUID(box.address.uuid)).status === "success") {
                    audioIds.add(box.address.uuid, true)
                } else {
                    issues.push(`The sample '${box.fileName.getValue()}' is missing in the file.`)
                }
            })
        const hostOf = (unit: AudioUnitBox) => (pointer: PointerField): Option<Address> => {
            switch (pointer.pointerType) {
                case Pointers.InstrumentHost:
                    return Option.wrap(unit.input.address)
                case Pointers.AudioEffectHost:
                    return Option.wrap(unit.audioEffects.address)
                case Pointers.MIDIEffectHost:
                    return Option.wrap(unit.midiEffects.address)
                case Pointers.MasteringHost:
                    return Option.wrap(unit.mastering.address)
                default:
                    return Option.None
            }
        }
        const decodeState = (unit: Unit, path: Optional<string>): Option<Box> => {
            if (!isDefined(path)) {return Option.None}
            const resource = resourceOf(path).unwrapOrUndefined()
            if (!isDefined(resource) || !DeviceState.isDeviceState(resource.buffer)) {return Option.None}
            const decoded = tryCatch(() => DeviceState.decode(boxGraph, resource.buffer, hostOf(unit.box), [rootBox, timelineBox]))
            if (decoded.status === "failure") {
                issues.push(`A device of '${unit.schema.name ?? ""}' could not be restored (${decoded.error}).`)
                return Option.None
            }
            collectAudioFiles(decoded.value.boxes)
            return Option.wrap(decoded.value.device)
        }
        const registerDeviceParameters = (device: DeviceSchema, box: Box): void => {
            const enabled: unknown = Reflect.get(box, "enabled")
            if (isInstanceOf(enabled, BooleanField)) {registerParameter(device.enabled, enabled)}
            const bands = isInstanceOf(device, EqualizerSchema)
                ? device.bands.flatMap(band => [band.freq, band.gain, band.q, band.enabled]).filter(isDefined) : []
            const ownState = isDefined(device.state?.path) && device.deviceVendor === "openDAW"
            ;[...device.parameters, ...(ownState ? bands : [])].forEach(parameter => {
                if (!isDefined(parameter.id)) {return}
                const address = DawProjectIds.toAddress(parameter.id).unwrapOrUndefined()
                const field = isDefined(address) ? boxGraph.findVertex(address).unwrapOrUndefined() : undefined
                if (isDefined(field) && field.isField()) {
                    parameters.set(parameter.id, {field, schema: parameter})
                } else if (WclapBoxes.is(box) && isDefined(parameter.parameterID)) {
                    parameters.set(parameter.id, {field: wclapParameterOf(box, parameter).value, schema: parameter})
                }
            })
        }
        const wclapParameterOf = (box: WclapBoxes.Any, parameter: ParameterSchema): WclapParameterBox => {
            const clapId = parameter.parameterID ?? 0
            const existing = box.parameters.pointerHub.incoming()
                .map(({box}) => asInstanceOf(box, WclapParameterBox))
                .find(paramBox => paramBox.clapId.getValue() === clapId)
            if (isDefined(existing)) {return existing}
            const real = isInstanceOf(parameter, RealParameterSchema) ? parameter : undefined
            const min = real?.min ?? 0.0
            const max = real?.max ?? 1.0
            return WclapParameterBox.create(boxGraph, WclapParameters.parameterUuid(box.address.uuid, clapId), paramBox => {
                paramBox.owner.refer(box.parameters)
                paramBox.label.setValue(parameter.name ?? "")
                paramBox.clapId.setValue(clapId)
                paramBox.min.setValue(min)
                paramBox.max.setValue(max)
                const value = real?.value ?? 0.0
                paramBox.value.setValue(real?.unit === Unit.NORMALIZED ? min + value * (max - min) : value)
                paramBox.defaultValue.setValue(paramBox.value.getValue())
            })
        }
        const createClap = async (unit: Unit, device: ClapPluginSchema, field: Field, index: int): Promise<Option<Box>> => {
            const pluginId = device.deviceID
            const resolve = options.resolveClap
            if (!isDefined(pluginId) || !isDefined(resolve)) {return Option.None}
            const url = (await resolve(pluginId)).unwrapOrUndefined()
            if (!isDefined(url)) {return Option.None}
            const state = isDefined(device.state?.path)
                ? resourceOf(device.state.path).flatMap(({buffer}) => ClapPreset.decode(buffer)).unwrapOrUndefined()
                : undefined
            const setup = (box: WclapBoxes.Any) => {
                box.url.setValue(url)
                box.clapId.setValue(pluginId)
                box.label.setValue(nameOf(device))
                if (isDefined(state) && state.pluginId === pluginId) {box.pluginState.setValue(new Int8Array(state.state))}
                if (device.enabled?.value === false) {box.enabled.setValue(false)}
            }
            if (device.deviceRole === DeviceRole.INSTRUMENT) {
                const box = asInstanceOf(InstrumentFactories.Wclap.create(boxGraph, unit.box.input, nameOf(device), IconSymbol.WebClap), WclapInstrumentBox)
                setup(box)
                return Option.wrap(box)
            }
            if (device.deviceRole === DeviceRole.NOTE_FX) {
                return Option.wrap(WclapMidiEffectBox.create(boxGraph, UUID.generate(), box => {
                    box.host.refer(field)
                    box.index.setValue(index)
                    setup(box)
                }))
            }
            return Option.wrap(WclapDeviceBox.create(boxGraph, UUID.generate(), box => {
                box.host.refer(field)
                box.index.setValue(index)
                setup(box)
            }))
        }
        const createDevice = async (unit: Unit, device: DeviceSchema, field: Field, index: int): Promise<Option<Box>> => {
            const path = isInstanceOf(device, ClapPluginSchema) && isDefined(device.state?.path)
                ? `${device.state.path}${DawProjectExporter.ClapSidecarSuffix}` : device.state?.path
            const restored = decodeState(unit, path)
            if (restored.nonEmpty()) {return restored}
            if (isInstanceOf(device, ClapPluginSchema)) {
                const clap = await createClap(unit, device, field, index)
                if (clap.nonEmpty()) {return clap}
            }
            if (isInstanceOf(device, EqualizerSchema) && device.deviceRole !== DeviceRole.INSTRUMENT) {
                return Option.wrap(BuiltinDevices.equalizer(boxGraph, device, asEffectField(field), index))
            }
            const origin = isDefined(device.deviceVendor) ? `${nameOf(device)} by ${device.deviceVendor}` : nameOf(device)
            if (device.deviceRole === DeviceRole.INSTRUMENT) {
                issues.push(`'${origin}' on '${unit.schema.name ?? ""}' is not available in openDAW and was replaced.`)
                return Option.None
            }
            issues.push(`'${origin}' on '${unit.schema.name ?? ""}' is not available in openDAW, a placeholder keeps its place.`)
            const comment = `${device.deviceID ?? nameOf(device)}${isDefined(device.deviceVendor) ? ` from ${device.deviceVendor}` : ""} ⚠️`
            return Option.wrap<Box>(device.deviceRole === DeviceRole.NOTE_FX
                ? UnknownMidiEffectDeviceBox.create(boxGraph, UUID.generate(), box => {
                    box.host.refer(field)
                    box.index.setValue(index)
                    box.label.setValue(nameOf(device))
                    box.comment.setValue(comment)
                })
                : UnknownAudioEffectDeviceBox.create(boxGraph, UUID.generate(), box => {
                    box.host.refer(field)
                    box.index.setValue(index)
                    box.label.setValue(nameOf(device))
                    box.comment.setValue(comment)
                }))
        }
        for (const unit of units) {
            const type = unit.box.type.getValue()
            const devices = unit.channel.devices
            const createChain = async (role: DeviceRole, field: Field): Promise<void> => {
                const chain = devices.filter(device => device.deviceRole === role
                    || (role === DeviceRole.AUDIO_FX && device.deviceRole === DeviceRole.ANALYZER))
                const created: Array<Box> = []
                for (const device of chain) {
                    const box = (await createDevice(unit, device, field, created.length)).unwrapOrUndefined()
                    if (!isDefined(box)) {continue}
                    registerDeviceParameters(device, box)
                    if (IndexedBox.isIndexedBox(box) && DeviceBoxUtils.isEffectDeviceBox(box)
                        && box.host.targetAddress.mapOr(address => address.equals(field.address), false)) {
                        created.push(box)
                    }
                }
                created.forEach((box, index) => {if (IndexedBox.isIndexedBox(box)) {box.index.setValue(index)}})
            }
            await createChain(DeviceRole.NOTE_FX, unit.box.midiEffects)
            if (type === AudioUnitType.Instrument) {
                const device = devices.find(device => device.deviceRole === DeviceRole.INSTRUMENT)
                const instrument = isDefined(device) ? (await createDevice(unit, device, unit.box.input, 0)).unwrapOrUndefined() : undefined
                if (isDefined(device) && isDefined(instrument)) {registerDeviceParameters(device, instrument)}
                const box = instrument ?? fallbackInstrument(boxGraph, unit)
                const key = InstrumentFactories.keyOfBox(box)
                const trackType = isDefined(key) ? InstrumentFactories.Named[key].trackType : TrackType.Notes
                unit.box.capture.refer(trackType === TrackType.Audio
                    ? CaptureAudioBox.create(boxGraph, UUID.generate())
                    : CaptureMidiBox.create(boxGraph, UUID.generate()))
            }
            await createChain(DeviceRole.AUDIO_FX, unit.box.audioEffects)
        }
        units.forEach(unit => unit.channel.sends.forEach((send, index) => {
            if (send.enable?.value === false) {return}
            const target = isDefined(send.destination) ? busesByChannel.get(send.destination) : undefined
            if (!isDefined(target)) {
                issues.push(`A send of '${unit.schema.name ?? ""}' has no destination and was dropped.`)
                return
            }
            const box = AuxSendBox.create(boxGraph, uuidOf(send.id), box => {
                box.routing.setValue(send.type === SendType.PRE ? AudioSendRouting.Pre : AudioSendRouting.Post)
                box.sendGain.setValue(readGain(send.volume))
                box.sendPan.setValue(readPan(send.pan))
                box.audioUnit.refer(unit.box.auxSends)
                box.targetBus.refer(target.input)
                box.index.setValue(index)
            })
            registerParameter(send.volume, box.sendGain)
            registerParameter(send.pan, box.sendPan)
        }))
        const trackTypeOf = (unit: AudioUnitBox): TrackType => {
            if (unit.type.getValue() !== AudioUnitType.Instrument) {return TrackType.Undefined}
            const input = unit.input.pointerHub.incoming().at(0)?.box
            const key = isDefined(input) ? InstrumentFactories.keyOfBox(input) : undefined
            return isDefined(key) ? InstrumentFactories.Named[key].trackType : TrackType.Notes
        }
        const tracksByUnit = new Map<AudioUnitBox, Array<TrackBox>>()
        const ends = new Map<TrackBox, number>()
        const createTrack = (unit: AudioUnitBox, type: TrackType, id: Optional<string>, target?: Field): TrackBox => {
            const tracks = tracksByUnit.get(unit) ?? []
            tracksByUnit.set(unit, tracks)
            const track = TrackBox.create(boxGraph, uuidOf(id), box => {
                box.tracks.refer(unit.tracks)
                box.target.refer(target ?? unit)
                box.type.setValue(type)
                box.index.setValue(tracks.length)
            })
            tracks.push(track)
            return track
        }
        // an openDAW export keeps its tracks, clips of others that overlap go to the next free track of their kind
        const placeRegion = (unit: AudioUnitBox, first: TrackBox, position: number, end: number): TrackBox => {
            if (fromOpenDAW) {return first}
            const candidates = (tracksByUnit.get(unit) ?? []).filter(track =>
                track.type.getValue() === first.type.getValue()
                && track.target.targetAddress.equals(first.target.targetAddress))
            const track = candidates.find(track => (ends.get(track) ?? Number.NEGATIVE_INFINITY) <= position)
                ?? createTrack(unit, first.type.getValue(), undefined, targetFieldOf(first))
            ends.set(track, Math.max(ends.get(track) ?? Number.NEGATIVE_INFINITY, end))
            return track
        }
        const targetFieldOf = (track: TrackBox): Optional<Field> => {
            const address = track.target.targetAddress.unwrapOrUndefined()
            if (!isDefined(address) || address.isBox()) {return undefined}
            const vertex = boxGraph.findVertex(address).unwrapOrUndefined()
            return isDefined(vertex) && vertex.isField() ? vertex : undefined
        }
        const noteCollections = new Map<string, NoteEventCollectionBox>()
        const valueCollections = new Map<string, ValueEventCollectionBox>()
        const contentById = new Map<string, TimelineSchema>()
        const indexContent = (timeline: Optional<TimelineSchema>): void => {
            if (!isDefined(timeline)) {return}
            if (isDefined(timeline.id)) {contentById.set(timeline.id, timeline)}
            if (isInstanceOf(timeline, LanesSchema)) {timeline.lanes.forEach(indexContent)}
            if (isInstanceOf(timeline, ClipsSchema)) {timeline.clips.forEach(clip => indexContent(clip.content))}
            if (isInstanceOf(timeline, ClipSlotSchema)) {indexContent(timeline.clip?.content)}
            if (isInstanceOf(timeline, WarpsSchema)) {indexContent(timeline.content)}
        }
        indexContent(schema.arrangement?.lanes)
        schema.scenes.forEach(scene => indexContent(scene.content))
        const loopWindowOf = (clip: ClipSchema, duration: number, contentLength: number, what: string): LoopWindow => {
            const playStart = clip.playStart ?? 0.0
            if (isDefined(clip.loopEnd)) {
                const loopStart = clip.loopStart ?? 0.0
                if (playStart >= loopStart) {
                    return {shift: loopStart, loopOffset: playStart - loopStart, loopDuration: clip.loopEnd - loopStart}
                }
                issues.push(`${what} starts before its loop, openDAW plays it from the loop start.`)
                return {shift: loopStart, loopOffset: 0.0, loopDuration: clip.loopEnd - loopStart}
            }
            return {shift: 0.0, loopOffset: playStart, loopDuration: Math.max(contentLength, playStart + duration)}
        }
        // a clip holding a single clip at its start (Bitwig wraps audio like that) reads like that inner clip
        const unwrap = (clip: ClipSchema): { content: Optional<TimelineSchema>, inner: Optional<ClipSchema> } => {
            const content = clip.content
            if (isInstanceOf(content, ClipsSchema) && content.clips.length === 1) {
                const inner = content.clips[0]
                if (inner.time === 0 && (inner.playStart ?? 0) === 0 && !isDefined(inner.loopEnd)) {
                    return {content: inner.content, inner}
                }
            }
            if (isInstanceOf(content, ClipsSchema)) {
                issues.push(`Clip '${clip.name ?? ""}' holds clips openDAW cannot nest, only the first is read.`)
                const first = content.clips.at(0)
                return {content: first?.content, inner: first}
            }
            return {content, inner: undefined}
        }
        const kindOf = (clip: ClipSchema): TrackType => {
            const resolved = isDefined(clip.reference) ? contentById.get(clip.reference) : unwrap(clip).content
            if (isInstanceOf(resolved, NotesSchema)) {return TrackType.Notes}
            if (isInstanceOf(resolved, PointsSchema)) {return TrackType.Value}
            if (isInstanceOf(resolved, WarpsSchema) || isInstanceOf(resolved, AudioSchema)) {return TrackType.Audio}
            return TrackType.Undefined
        }
        const hueOf = (color: Optional<string>, type: TrackType): int =>
            isDefined(color) && /^#[0-9a-fA-F]{6}$/.test(color) ? DawProjectExporter.colorToHue(color) : ColorCodes.forTrackType(type)
        const noteCollectionOf = (clip: ClipSchema, inline: Optional<TimelineSchema>, shift: number): Optional<NoteEventCollectionBox> => {
            const content = isDefined(clip.reference) ? contentById.get(clip.reference) : inline
            if (!isInstanceOf(content, NotesSchema)) {
                if (isDefined(clip.reference)) {issues.push(`Clip '${clip.name ?? ""}' refers to missing notes.`)}
                return undefined
            }
            const key = `${content.id ?? ""}@${shift}`
            const known = isDefined(content.id) ? noteCollections.get(key) : undefined
            if (isDefined(known)) {return known}
            const collection = NoteEventCollectionBox.create(boxGraph, uuidOf(content.id))
            if (isDefined(content.id)) {noteCollections.set(key, collection)}
            content.notes.filter(note => [note.time, note.duration, note.key].every(Number.isFinite)).forEach(note => {
                const position = toPulsesInt(note.time - shift)
                NoteEventBox.create(boxGraph, UUID.generate(), box => {
                    box.position.setValue(position)
                    box.duration.setValue(Math.max(1, toPulsesInt(note.duration)))
                    box.pitch.setValue(clamp(note.key, 0, 127))
                    box.velocity.setValue(clamp(note.vel ?? 1.0, 0.0, 1.0))
                    const transpose = isInstanceOf(note.content, PointsSchema)
                        && note.content.target.expression === ExpressionType.TRANSPOSE
                        ? note.content.points.find((point): point is RealPointSchema => isInstanceOf(point, RealPointSchema))
                        : undefined
                    if (isDefined(transpose)) {box.cent.setValue(clamp(transpose.value * 100.0, -50.0, 50.0))}
                    box.events.refer(collection.events)
                })
            })
            return collection
        }
        const valueCollectionOf = (clip: ClipSchema, inline: Optional<PointsSchema>, target: ParameterTarget,
                                   shift: number): Optional<ValueEventCollectionBox> => {
            const points = isDefined(clip.reference) ? contentById.get(clip.reference) : inline
            if (!isInstanceOf(points, PointsSchema)) {
                if (isDefined(clip.reference)) {issues.push(`Clip '${clip.name ?? ""}' refers to missing automation.`)}
                return undefined
            }
            const key = `${points.id ?? ""}@${shift}`
            const known = isDefined(points.id) ? valueCollections.get(key) : undefined
            if (isDefined(known)) {return known}
            const collection = ValueEventCollectionBox.create(boxGraph, uuidOf(points.id))
            if (isDefined(points.id)) {valueCollections.set(key, collection)}
            writeValueEvents(boxGraph, collection, points, target, shift)
            return collection
        }
        const readAudio = (clip: ClipSchema, content: Optional<TimelineSchema>): Optional<{
            file: Provider<AudioFileBox>, warps: Optional<WarpsSchema>, audio: AudioSchema
        }> => {
            const warps = isInstanceOf(content, WarpsSchema) ? content : undefined
            const audio = isDefined(warps) ? warps.content : content
            if (!isInstanceOf(audio, AudioSchema)) {return undefined}
            if (!isDefined(audio.file?.path) || !Number.isFinite(audio.duration)) {
                issues.push(`Clip '${clip.name ?? ""}' has no audio file.`)
                return undefined
            }
            if (audio.file.external === true) {
                issues.push(`Clip '${clip.name ?? ""}' refers to an external file, which openDAW cannot read.`)
                return undefined
            }
            const resource = resourceOf(audio.file.path).unwrapOrUndefined()
            if (!isDefined(resource)) {
                issues.push(`The audio file '${audio.file.path}' is missing.`)
                return undefined
            }
            const file = (): AudioFileBox => {
                audioIds.add(resource.uuid, true)
                return boxGraph.findBox<AudioFileBox>(resource.uuid).unwrapOrElse(() =>
                    AudioFileBox.create(boxGraph, resource.uuid, box => {
                        box.fileName.setValue(resource.name.replace(/\.[^.]+$/, ""))
                        box.endInSeconds.setValue(audio.duration)
                    }))
            }
            return {file, warps, audio}
        }
        // the boxes are created once the placement turned out playable
        type AudioPlacement = {
            readonly file: Provider<AudioFileBox>, readonly playMode: Provider<Optional<Box>>, readonly seconds: boolean,
            readonly duration: number, readonly loopOffset: number, readonly loopDuration: number, readonly waveformOffset: number
        }
        const audioPlacementOf = (clip: ClipSchema, position: ppqn, durationInBeats: number): Optional<AudioPlacement> => {
            const {content, inner} = unwrap(clip)
            const read = readAudio(clip, content)
            if (!isDefined(read)) {return undefined}
            const {file, warps, audio} = read
            if (isDefined(warps)) {
                if (warps.contentTimeUnit !== TimeUnit.SECONDS) {
                    issues.push(`Clip '${clip.name ?? ""}' warps audio in beats, which openDAW cannot read.`)
                    return undefined
                }
                const markers = warps.warps.filter(warp => Number.isFinite(warp.time) && warp.contentTime >= 0.0)
                const span = (markers.at(-1)?.time ?? 0.0) - (markers.at(0)?.time ?? 0.0)
                const contentLength = inner?.duration ?? span
                const {shift, loopOffset, loopDuration} = loopWindowOf(clip, durationInBeats, contentLength, `Clip '${clip.name ?? ""}'`)
                if (markers.length < 2 || span <= 0.0) {
                    issues.push(`Clip '${clip.name ?? ""}' has too few warp markers.`)
                    return undefined
                }
                const playMode = (): Box => {
                    const mode = audio.algorithm === "repitch"
                        ? AudioPitchStretchBox.create(boxGraph, UUID.generate())
                        : AudioTimeStretchBox.create(boxGraph, UUID.generate())
                    markers.forEach(warp => WarpMarkerBox.create(boxGraph, UUID.generate(), box => {
                        box.owner.refer(mode.warpMarkers)
                        box.position.setValue(toPulsesInt(warp.time - shift))
                        box.seconds.setValue(warp.contentTime)
                    }))
                    return mode
                }
                return {
                    file, playMode, seconds: false, duration: toPulses(durationInBeats),
                    loopOffset: toPulses(loopOffset), loopDuration: toPulses(loopDuration), waveformOffset: 0.0
                }
            }
            const inSeconds = (clip.contentTimeUnit ?? TimeUnit.BEATS) === TimeUnit.SECONDS
            if (!inSeconds) {
                const {loopOffset, loopDuration} = loopWindowOf(clip, durationInBeats, 0.0, `Clip '${clip.name ?? ""}'`)
                return {
                    file, playMode: () => undefined, seconds: false, duration: toPulses(durationInBeats),
                    loopOffset: toPulses(loopOffset), loopDuration: toPulses(loopDuration), waveformOffset: 0.0
                }
            }
            const durationInSeconds = pulsesToSeconds(position, toPulses(durationInBeats))
            const playStart = clip.playStart ?? 0.0
            if (isDefined(clip.loopEnd)) {
                const loopStart = clip.loopStart ?? 0.0
                const loopEnd = clip.loopEnd
                return {
                    file, playMode: () => undefined, seconds: true, duration: durationInSeconds,
                    loopOffset: Math.max(0.0, playStart - loopStart), loopDuration: loopEnd - loopStart, waveformOffset: loopStart
                }
            }
            return {
                file, playMode: () => undefined, seconds: true, duration: durationInSeconds,
                loopOffset: 0.0, loopDuration: Math.max(audio.duration - playStart, durationInSeconds), waveformOffset: playStart
            }
        }
        const hasLength = (clip: ClipSchema, {duration, loopDuration}: AudioPlacement): boolean => {
            if (duration > 0.0 && loopDuration > 0.0) {return true}
            issues.push(`Clip '${clip.name ?? ""}' has no loop length and was skipped.`)
            return false
        }
        const readRegion = (unit: AudioUnitBox, first: TrackBox, clip: ClipSchema, target: Optional<ParameterTarget>): void => {
            if (!Number.isFinite(clip.time)) {
                issues.push(`Clip '${clip.name ?? ""}' has no time and was skipped.`)
                return
            }
            const position = toPulsesInt(clip.time)
            const durationInBeats = clip.duration ?? ((clip.playStop ?? 0.0) - (clip.playStart ?? 0.0))
            if (durationInBeats <= 0.0) {
                issues.push(`Clip '${clip.name ?? ""}' has no length and was skipped.`)
                return
            }
            const type = first.type.getValue()
            const hue = hueOf(clip.color, type)
            const label = clip.name ?? ""
            const mute = clip.enable === false
            const what = `Clip '${label}'`
            if (type === TrackType.Audio) {
                const placement = audioPlacementOf(clip, position, durationInBeats)
                if (!isDefined(placement) || !hasLength(clip, placement)) {return}
                const track = placeRegion(unit, first, position, position + toPulses(durationInBeats))
                const {seconds, duration, loopOffset, loopDuration, waveformOffset} = placement
                const file = placement.file()
                const playMode = placement.playMode()
                const events = ValueEventCollectionBox.create(boxGraph, UUID.generate())
                AudioRegionBox.create(boxGraph, UUID.generate(), box => {
                    box.position.setValue(position)
                    box.duration.setValue(duration)
                    box.loopOffset.setValue(loopOffset)
                    box.loopDuration.setValue(loopDuration)
                    box.timeBase.setValue(seconds ? "seconds" : "musical")
                    box.waveformOffset.setValue(waveformOffset)
                    box.label.setValue(label)
                    box.hue.setValue(hue)
                    box.mute.setValue(mute)
                    box.file.refer(file)
                    box.events.refer(events.owners)
                    if (isDefined(playMode)) {box.playMode.refer(playMode)}
                    const fade = (value: Optional<number>): number => !isDefined(value) ? 0.0
                        : clip.fadeTimeUnit === TimeUnit.SECONDS ? secondsToPulses(position, value) : toPulses(value)
                    box.fading.in.setValue(fade(clip.fadeInTime))
                    box.fading.out.setValue(fade(clip.fadeOutTime))
                    box.regions.refer(track.regions)
                })
                return
            }
            const {content} = unwrap(clip)
            const loop = loopWindowOf(clip, durationInBeats, 0.0, what)
            if (toPulsesInt(loop.loopDuration) < 1) {
                issues.push(`${what} has no loop length and was skipped.`)
                return
            }
            const track = placeRegion(unit, first, position, position + toPulsesInt(durationInBeats))
            if (type === TrackType.Notes) {
                const collection = noteCollectionOf(clip, content, loop.shift)
                if (!isDefined(collection)) {return}
                NoteRegionBox.create(boxGraph, UUID.generate(), box => {
                    box.position.setValue(position)
                    box.duration.setValue(toPulsesInt(durationInBeats))
                    box.loopOffset.setValue(toPulsesInt(loop.loopOffset))
                    box.loopDuration.setValue(toPulsesInt(loop.loopDuration))
                    box.label.setValue(label)
                    box.hue.setValue(hue)
                    box.mute.setValue(mute)
                    box.events.refer(collection.owners)
                    box.regions.refer(track.regions)
                })
            } else if (type === TrackType.Value && isDefined(target)) {
                const collection = valueCollectionOf(clip, isInstanceOf(content, PointsSchema) ? content : undefined, target, loop.shift)
                if (!isDefined(collection)) {return}
                ValueRegionBox.create(boxGraph, UUID.generate(), box => {
                    box.position.setValue(position)
                    box.duration.setValue(toPulsesInt(durationInBeats))
                    box.loopOffset.setValue(toPulsesInt(loop.loopOffset))
                    box.loopDuration.setValue(toPulsesInt(loop.loopDuration))
                    box.label.setValue(label)
                    box.hue.setValue(hue)
                    box.mute.setValue(mute)
                    box.events.refer(collection.owners)
                    box.regions.refer(track.regions)
                })
            }
        }
        const targetOfPoints = (points: PointsSchema, unitName: string): Optional<ParameterTarget> => {
            const parameter = points.target.parameter
            if (!isDefined(parameter)) {
                issues.push(`Automation of ${points.target.expression ?? "an expression"} on '${unitName}' is not supported.`)
                return undefined
            }
            const target = parameters.get(parameter)
            if (!isDefined(target)) {issues.push(`Automation on '${unitName}' controls an unknown parameter.`)}
            return target
        }
        const valueTrackOf = (unit: AudioUnitBox, target: ParameterTarget, id: Optional<string>): TrackBox => {
            const existing = (tracksByUnit.get(unit) ?? []).find(track => track.type.getValue() === TrackType.Value
                && track.target.targetAddress.mapOr(address => address.equals(target.field.address), false))
            return existing ?? createTrack(unit, TrackType.Value, id, target.field)
        }
        const readLane = (unit: Unit, timeline: TimelineSchema): void => {
            const unitName = unit.schema.name ?? ""
            if (isInstanceOf(timeline, LanesSchema)) {
                timeline.lanes.forEach(child => readLane(unitsById.get(child.track ?? "") ?? unit, child))
            } else if (isInstanceOf(timeline, ClipsSchema)) {
                const own = trackTypeOf(unit.box)
                const valueClips = timeline.clips.filter(clip => kindOf(clip) === TrackType.Value)
                const valueTracks = new Map<Field, { track: TrackBox, target: ParameterTarget }>()
                valueClips.forEach(clip => {
                    const content = isDefined(clip.reference) ? contentById.get(clip.reference) : unwrap(clip).content
                    const target = isInstanceOf(content, PointsSchema) ? targetOfPoints(content, unitName) : undefined
                    if (!isDefined(target)) {return}
                    const entry = valueTracks.get(target.field)
                        ?? {track: valueTrackOf(unit.box, target, valueTracks.size === 0 ? timeline.id : undefined), target}
                    valueTracks.set(target.field, entry)
                    readRegion(unit.box, entry.track, clip, target)
                })
                const playable = timeline.clips.filter(clip => kindOf(clip) === own)
                const foreign = timeline.clips.filter(clip => {
                    const kind = kindOf(clip)
                    return kind !== own && kind !== TrackType.Value && kind !== TrackType.Undefined
                })
                if (foreign.length > 0) {
                    issues.push(`'${unitName}' cannot play ${kindOf(foreign[0]) === TrackType.Audio ? "audio" : "notes"}, those clips were skipped.`)
                }
                if (own === TrackType.Undefined || (playable.length === 0 && timeline.clips.length > 0)) {return}
                const track = createTrack(unit.box, own, timeline.id)
                playable
                    .sort((left, right) => left.time - right.time)
                    .forEach(clip => readRegion(unit.box, track, clip, undefined))
            } else if (isInstanceOf(timeline, PointsSchema)) {
                const target = targetOfPoints(timeline, unitName)
                if (!isDefined(target)) {return}
                const track = valueTrackOf(unit.box, target, timeline.id)
                if (timeline.points.length === 0) {return}
                const last = timeline.points.reduce((max, point) => Math.max(max, point.time), 0.0)
                const duration = Math.max(PPQN.Bar, Math.ceil((toPulses(last) + 1) / PPQN.Bar) * PPQN.Bar)
                const collection = ValueEventCollectionBox.create(boxGraph, UUID.generate())
                writeValueEvents(boxGraph, collection, timeline, target, 0.0)
                ValueRegionBox.create(boxGraph, UUID.generate(), box => {
                    box.position.setValue(0)
                    box.duration.setValue(duration)
                    box.loopDuration.setValue(duration)
                    box.hue.setValue(ColorCodes.forTrackType(TrackType.Value))
                    box.events.refer(collection.owners)
                    box.regions.refer(track.regions)
                })
                ends.set(track, duration)
            } else {
                issues.push(`'${unitName}' holds content outside of clips, which openDAW cannot read.`)
            }
        }
        schema.arrangement?.lanes?.lanes.forEach(timeline => {
            const unit = unitsById.get(timeline.track ?? "")
            if (isDefined(unit)) {
                readLane(unit, timeline)
            } else if (isInstanceOf(timeline, LanesSchema)) {
                timeline.lanes.forEach(child => {
                    const owner = unitsById.get(child.track ?? "")
                    if (isDefined(owner)) {readLane(owner, child)}
                })
            }
        })
        const readSlotClip = (unit: Unit, clip: ClipSchema, index: int, nth: int): void => {
            const nthTrack = (tracksByUnit.get(unit.box) ?? []).at(nth)
            const kind = kindOf(clip)
            const {content} = unwrap(clip)
            const duration = clip.duration ?? ((clip.playStop ?? 0.0) - (clip.playStart ?? 0.0))
            const loop = isDefined(clip.loopEnd)
            const hue = hueOf(clip.color, kind)
            if (duration <= 0.0) {return}
            const setup = (box: NoteClipBox | ValueClipBox | AudioClipBox) => {
                box.index.setValue(index)
                box.label.setValue(clip.name ?? "")
                box.hue.setValue(hue)
                box.mute.setValue(clip.enable === false)
                box.triggerMode.loop.setValue(loop)
            }
            if (kind === TrackType.Notes && trackTypeOf(unit.box) === TrackType.Notes) {
                const track = nthTrack?.type.getValue() === TrackType.Notes ? nthTrack
                    : (tracksByUnit.get(unit.box) ?? []).find(track => track.type.getValue() === TrackType.Notes)
                    ?? createTrack(unit.box, TrackType.Notes, undefined)
                const collection = noteCollectionOf(clip, content, isDefined(clip.loopEnd) ? clip.loopStart ?? 0.0 : 0.0)
                if (!isDefined(collection)) {return}
                NoteClipBox.create(boxGraph, UUID.generate(), box => {
                    setup(box)
                    box.duration.setValue(toPulsesInt(duration))
                    box.events.refer(collection.owners)
                    box.clips.refer(track.clips)
                })
            } else if (kind === TrackType.Value) {
                const resolved = isDefined(clip.reference) ? contentById.get(clip.reference) : content
                const points = isInstanceOf(resolved, PointsSchema) ? resolved : undefined
                const target = isDefined(points) ? targetOfPoints(points, unit.schema.name ?? "") : undefined
                if (!isDefined(target)) {return}
                const track = valueTrackOf(unit.box, target, undefined)
                const collection = valueCollectionOf(clip, points, target, isDefined(clip.loopEnd) ? clip.loopStart ?? 0.0 : 0.0)
                if (!isDefined(collection)) {return}
                ValueClipBox.create(boxGraph, UUID.generate(), box => {
                    setup(box)
                    box.duration.setValue(toPulsesInt(duration))
                    box.events.refer(collection.owners)
                    box.clips.refer(track.clips)
                })
            } else if (kind === TrackType.Audio && trackTypeOf(unit.box) === TrackType.Audio) {
                const placement = audioPlacementOf(clip, 0, duration)
                if (!isDefined(placement) || !hasLength(clip, placement)) {return}
                const track = nthTrack?.type.getValue() === TrackType.Audio ? nthTrack
                    : (tracksByUnit.get(unit.box) ?? []).find(track => track.type.getValue() === TrackType.Audio)
                    ?? createTrack(unit.box, TrackType.Audio, undefined)
                const events = ValueEventCollectionBox.create(boxGraph, UUID.generate())
                const file = placement.file()
                const playMode = placement.playMode()
                AudioClipBox.create(boxGraph, UUID.generate(), box => {
                    setup(box)
                    box.duration.setValue(placement.duration)
                    box.timeBase.setValue(placement.seconds ? "seconds" : "musical")
                    box.waveformOffset.setValue(placement.waveformOffset)
                    box.file.refer(file)
                    box.events.refer(events.owners)
                    if (isDefined(playMode)) {box.playMode.refer(playMode)}
                    box.clips.refer(track.clips)
                })
            } else {
                issues.push(`Clip '${clip.name ?? ""}' in scene ${index + 1} cannot play on '${unit.schema.name ?? ""}'.`)
            }
        }
        // the n-th slot of a track in a scene belongs to its n-th track
        schema.scenes.forEach((scene, row) => {
            const slots = isInstanceOf(scene.content, LanesSchema) ? scene.content.lanes : [scene.content]
            const seen = new Map<Unit, int>()
            slots.forEach(slot => {
                if (!isInstanceOf(slot, ClipSlotSchema)) {return}
                const unit = unitsById.get(slot.track ?? "")
                if (!isDefined(unit)) {return}
                const nth = seen.get(unit) ?? 0
                seen.set(unit, nth + 1)
                if (isDefined(slot.clip)) {readSlotClip(unit, slot.clip, row, nth)}
            })
        })
        units.forEach(({box}) => {
            const type = trackTypeOf(box)
            if (type !== TrackType.Undefined && !isDefined(tracksByUnit.get(box))) {createTrack(box, type, undefined)}
        })
        // the lanes of the arrangement list the units in mixer order
        const laneOrder = new Map<AudioUnitBox, int>()
        schema.arrangement?.lanes?.lanes.forEach(timeline => {
            const unit = unitsById.get(timeline.track ?? "")
            if (isDefined(unit) && !laneOrder.has(unit.box)) {laneOrder.set(unit.box, laneOrder.size)}
        })
        const ordered = units.map(({box}) => box)
            .sort((left, right) => (AudioUnitOrdering[left.type.getValue()] ?? 0) - (AudioUnitOrdering[right.type.getValue()] ?? 0)
                || (laneOrder.get(left) ?? Number.MAX_SAFE_INTEGER) - (laneOrder.get(right) ?? Number.MAX_SAFE_INTEGER))
        const output = ordered.indexOf(primaryUnit) === -1 ? [...ordered, primaryUnit] : ordered
        output.forEach((box, index) => box.index.setValue(index))
        const firstUnit = output.at(0)
        if (isDefined(firstUnit)) {userInterfaceBox.editingDeviceChain.refer(firstUnit.editing)}
        boxGraph.endTransaction()
        boxGraph.verifyPointers()
        return {
            audioIds: audioIds.values(),
            issues: Array.from(new Set(issues)),
            skeleton: {
                boxGraph,
                mandatoryBoxes: {
                    rootBox,
                    timelineBox,
                    primaryAudioBusBox: primaryBus,
                    primaryAudioUnitBox: primaryUnit,
                    userInterfaceBoxes: [userInterfaceBox]
                }
            }
        }
    }

    const nameOf = (device: DeviceSchema): string => device.deviceName ?? device.name ?? device.deviceID ?? "Device"

    const iconOf = (type: AudioUnitType): IconSymbol => {
        switch (type) {
            case AudioUnitType.Output:
                return IconSymbol.SpeakerHeadphone
            case AudioUnitType.Aux:
                return IconSymbol.Effects
            default:
                return IconSymbol.AudioBus
        }
    }

    const hslStringOf = (hex: string): string => {
        const {h, s, l} = Color.hexToHsl(hex)
        return `hsl(${Math.round(h)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`
    }

    const unitTypeOf = (track: TrackSchema, channel: ChannelSchema, depth: int, hasPrimary: boolean): Optional<AudioUnitType> => {
        switch (channel.role ?? MixerRole.REGULAR) {
            case MixerRole.REGULAR:
                return track.contentType?.includes(ContentType.TRACKS) === true && track.tracks.length > 0
                    ? AudioUnitType.Bus : AudioUnitType.Instrument
            case MixerRole.EFFECT:
                return AudioUnitType.Aux
            case MixerRole.SUBMIX:
                return AudioUnitType.Bus
            case MixerRole.MASTER:
                return !hasPrimary && depth === 0 && !isDefined(channel.destination) && track.tracks.length === 0
                    ? AudioUnitType.Output : AudioUnitType.Bus
            default:
                return undefined
        }
    }

    const fallbackInstrument = (boxGraph: BoxGraph<BoxIO.TypeMap>, {box, schema}: Unit): Box => {
        const audio = schema.contentType?.includes(ContentType.AUDIO) === true
            && schema.contentType?.includes(ContentType.NOTES) !== true
        return audio
            ? InstrumentFactories.Tape.create(boxGraph, box.input, schema.name ?? "", IconSymbol.Waveform)
            : InstrumentFactories.Vaporisateur.create(boxGraph, box.input, schema.name ?? "", IconSymbol.Piano)
    }

    const readVolume = (parameter: Optional<RealParameterSchema>): number =>
        clamp(gainToDb(realValueOf(parameter, 1.0)), -96.0, 6.0)

    const readGain = (parameter: Optional<RealParameterSchema>): number => gainToDb(realValueOf(parameter, 1.0))

    const readPan = (parameter: Optional<RealParameterSchema>): number => {
        if (!isDefined(parameter) || !isDefined(parameter.value)) {return 0.0}
        const {value, min, max} = parameter
        const unit = parameter.unit === Unit.NORMALIZED || !isDefined(min) || !isDefined(max) || max <= min
            ? value : (value - min) / (max - min)
        return clamp(ValueMapping.bipolar().y(clamp(unit, 0.0, 1.0)), -1.0, 1.0)
    }

    const realValueOf = (parameter: Optional<RealParameterSchema>, fallback: number): number => {
        if (!isDefined(parameter) || !isDefined(parameter.value)) {return fallback}
        if (parameter.unit === Unit.DECIBEL) {return Math.pow(10.0, parameter.value / 20.0)}
        return parameter.value
    }

    const readTransport = (transport: Optional<TransportSchema>, {bpm, signature, tempoTrack}: TimelineBox): void => {
        const tempo = transport?.tempo
        if (isDefined(tempo?.value)) {bpm.setValue(clamp(tempo.value, TempoRange.min, TempoRange.max))}
        if (isDefined(tempo?.min) && Number.isFinite(tempo.min)) {tempoTrack.minBpm.setValue(clamp(Math.round(tempo.min), 30, 999))}
        if (isDefined(tempo?.max) && Number.isFinite(tempo.max)) {tempoTrack.maxBpm.setValue(clamp(Math.round(tempo.max), 31, 1000))}
        if (tempoTrack.minBpm.getValue() >= tempoTrack.maxBpm.getValue()) {
            tempoTrack.minBpm.setValue(60)
            tempoTrack.maxBpm.setValue(240)
        }
        const timeSignature = transport?.timeSignature
        if (isDefined(timeSignature?.numerator) && isDefined(timeSignature?.denominator)) {
            signature.nominator.setValue(timeSignature.numerator)
            signature.denominator.setValue(timeSignature.denominator)
        }
    }

    const readTempoAutomation = (schema: ProjectSchema, timelineBox: TimelineBox,
                                 boxGraph: BoxGraph): ReadonlyArray<ValueEvent> => {
        const points = (schema.arrangement?.tempoAutomation?.points ?? [])
            .filter((point): point is RealPointSchema => isInstanceOf(point, RealPointSchema))
            .filter(point => Number.isFinite(point.time) && Number.isFinite(point.value))
        if (points.length === 0) {return Arrays.empty()}
        const collectionBox = ValueEventCollectionBox.create(boxGraph, UUID.generate())
        timelineBox.tempoTrack.events.refer(collectionBox.owners)
        timelineBox.tempoTrack.enabled.setValue(true)
        const events: Array<ValueEvent> = []
        points.forEach((point, index) => {
            const position = toPulsesInt(point.time)
            const value = clamp(point.value, TempoRange.min, TempoRange.max)
            const interpolation = point.interpolation === Interpolation.HOLD ? DspInterpolation.None : DspInterpolation.Linear
            const sameTime = points.slice(0, index).filter(previous => toPulsesInt(previous.time) === position).length
            const eventBox = ValueEventBox.create(boxGraph, UUID.generate(), box => {
                box.position.setValue(position)
                box.index.setValue(sameTime)
                box.value.setValue(value)
                box.events.refer(collectionBox.events)
            })
            InterpolationFieldAdapter.write(eventBox.interpolation, interpolation)
            events.push({type: "value-event", position, index: sameTime, value, interpolation})
        })
        return events.sort(ValueEvent.Comparator)
    }

    const readSignatureAutomation = (schema: ProjectSchema, timelineBox: TimelineBox, boxGraph: BoxGraph): void => {
        const points = (schema.arrangement?.timeSignatureAutomation?.points ?? [])
            .filter((point): point is TimeSignaturePointSchema => isInstanceOf(point, TimeSignaturePointSchema))
            .filter(point => [point.time, point.numerator, point.denominator].every(Number.isFinite))
            .sort((left, right) => left.time - right.time)
        if (points.length === 0) {return}
        const [first] = points
        const atStart = first.time < 0.001
        if (atStart) {
            timelineBox.signature.nominator.setValue(first.numerator)
            timelineBox.signature.denominator.setValue(first.denominator)
        }
        const events = atStart ? points.slice(1) : points
        if (events.length === 0) {return}
        timelineBox.signatureTrack.enabled.setValue(true)
        events.reduce((state, point, index) => {
            const barDuration = PPQN.fromSignature(state.numerator, state.denominator)
            const relativePosition = Math.max(1, Math.round((toPulses(point.time) - state.position) / barDuration))
            SignatureEventBox.create(boxGraph, UUID.generate(), box => {
                box.index.setValue(index)
                box.relativePosition.setValue(relativePosition)
                box.nominator.setValue(point.numerator)
                box.denominator.setValue(point.denominator)
                box.events.refer(timelineBox.signatureTrack.events)
            })
            return {position: state.position + relativePosition * barDuration, numerator: point.numerator, denominator: point.denominator}
        }, {position: 0, numerator: timelineBox.signature.nominator.getValue(), denominator: timelineBox.signature.denominator.getValue()})
    }

    const readMarkers = (markers: Optional<MarkersSchema>, timelineBox: TimelineBox, boxGraph: BoxGraph): void =>
        markers?.markers.filter(marker => Number.isFinite(marker.time)).forEach(marker => MarkerBox.create(boxGraph, UUID.generate(), box => {
            box.position.setValue(toPulsesInt(marker.time))
            box.label.setValue(marker.name ?? "")
            if (isDefined(marker.color) && /^#[0-9a-fA-F]{6}$/.test(marker.color)) {
                box.hue.setValue(DawProjectExporter.colorToHue(marker.color))
            }
            box.track.refer(timelineBox.markerTrack.markers)
        }))

    const writeValueEvents = (boxGraph: BoxGraph, collection: ValueEventCollectionBox, points: PointsSchema,
                              target: ParameterTarget, shift: number): void => {
        const decode = valueDecoderOf(points, target)
        const positions = new Map<int, int>()
        points.points.filter(point => Number.isFinite(point.time)).forEach(point => {
            const position = toPulsesInt(point.time - shift)
            const decoded = decode(point)
            if (!isDefined(decoded)) {return}
            const index = positions.get(position) ?? 0
            positions.set(position, index + 1)
            const eventBox = ValueEventBox.create(boxGraph, UUID.generate(), box => {
                box.position.setValue(position)
                box.index.setValue(index)
                box.value.setValue(decoded.value)
                box.events.refer(collection.events)
            })
            InterpolationFieldAdapter.write(eventBox.interpolation, decoded.interpolation)
        })
    }

    type Decoded = { readonly value: number, readonly interpolation: DspInterpolation }

    const valueDecoderOf = (points: PointsSchema, {field, schema}: ParameterTarget): (point: unknown) => Optional<Decoded> => {
        const unit = points.unit ?? (isInstanceOf(schema, RealParameterSchema) ? schema.unit : undefined)
        const boolean = isInstanceOf(field, BooleanField)
        const gainMapping: Optional<ValueMapping<number>> =
            isInstanceOf(field.box, AudioUnitBox) && field === field.box.volume ? AudioUnitBoxAdapter.VolumeMapper
                : isInstanceOf(field.box, AuxSendBox) && field === field.box.sendGain ? ValueMapping.DefaultDecibel
                    : undefined
        const real = isInstanceOf(schema, RealParameterSchema) ? schema : undefined
        const normalize = (value: number): number => {
            if (isDefined(gainMapping) && (unit === Unit.LINEAR || unit === Unit.DECIBEL)) {
                return gainMapping.x(unit === Unit.DECIBEL ? value : gainToDb(value))
            }
            if (unit === Unit.NORMALIZED || !isDefined(real?.min) || !isDefined(real?.max) || real.max <= real.min) {return value}
            return (value - real.min) / (real.max - real.min)
        }
        return (point: unknown): Optional<Decoded> => {
            if (isInstanceOf(point, BoolPointSchema)) {return {value: point.value ? 1.0 : 0.0, interpolation: DspInterpolation.None}}
            if (isInstanceOf(point, IntegerPointSchema)) {return {value: clamp(normalize(point.value), 0.0, 1.0), interpolation: DspInterpolation.None}}
            if (isInstanceOf(point, RealPointSchema)) {
                if (!Number.isFinite(point.value)) {return undefined}
                const interpolation = boolean || point.interpolation === Interpolation.HOLD ? DspInterpolation.None : DspInterpolation.Linear
                return {value: clamp(normalize(point.value), 0.0, 1.0), interpolation}
            }
            return undefined
        }
    }

    const asEffectField = (field: Field): Field<Pointers.MIDIEffectHost> | Field<Pointers.AudioEffectHost> =>
        field as Field<Pointers.MIDIEffectHost> | Field<Pointers.AudioEffectHost>
}
