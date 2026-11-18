import {
    Arrays,
    asInstanceOf,
    Color,
    int,
    isDefined,
    isInstanceOf,
    Optional,
    UUID,
    ValueMapping
} from "@opendaw/lib-std"
import {Xml} from "@opendaw/lib-xml"
import {dbToGain, ppqn, PPQN, seconds, TimeBase, ValueEvent, WavFile} from "@opendaw/lib-dsp"
import {Address, BooleanField, Box, Field, IndexedBox, Int32Field, StringField} from "@opendaw/lib-box"
import {
    ApplicationSchema,
    ArrangementSchema,
    AudioAlgorithm,
    AudioSchema,
    AutomationTargetSchema,
    BoolParameterSchema,
    BoolPointSchema,
    BuiltinDeviceSchema,
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
    FileReferenceSchema,
    Interpolation,
    LanesSchema,
    MarkerSchema,
    MarkersSchema,
    MixerRole,
    NoteSchema,
    NotesSchema,
    ParameterSchema,
    PointSchema,
    PointsSchema,
    ProjectSchema,
    RealParameterSchema,
    RealPointSchema,
    SceneSchema,
    SendSchema,
    SendType,
    TimelineSchema,
    TimeSignatureParameterSchema,
    TimeSignaturePointSchema,
    TimeUnit,
    TrackSchema,
    TransportSchema,
    Unit,
    WarpSchema,
    WarpsSchema
} from "@opendaw/lib-dawproject"
import {AudioSendRouting, AudioUnitType} from "@opendaw/studio-enums"
import {
    AudioBusBox,
    AudioClipBox,
    AudioFileBox,
    AudioPitchStretchBox,
    AudioRegionBox,
    AudioSignalsmithBox,
    AudioTimeStretchBox,
    AudioUnitBox,
    AuxSendBox,
    BoxVisitor,
    MarkerBox,
    NoteClipBox,
    NoteEventBox,
    NoteEventCollectionBox,
    NoteRegionBox,
    RevampDeviceBox,
    SignatureEventBox,
    TimelineBox,
    TrackBox,
    ValueClipBox,
    ValueEventBox,
    ValueEventCollectionBox,
    ValueRegionBox,
    WarpMarkerBox,
    WclapParameterBox
} from "@opendaw/studio-boxes"
import {
    AudioUnitBoxAdapter,
    ColorCodes,
    DeviceBoxUtils,
    InstrumentFactories,
    InterpolationFieldAdapter,
    ProjectSkeleton,
    SampleLoader,
    SampleLoaderManager,
    TempoGridCursor,
    TrackType
} from "@opendaw/studio-adapters"
import {AudioUnitExportLayout} from "./AudioUnitExportLayout"
import {BuiltinDevices} from "./BuiltinDevices"
import {DawProjectIds} from "./DawProjectIds"
import {DeviceState} from "./DeviceState"
import {WclapBoxes} from "../wclap/WclapBoxes"

export namespace DawProjectExporter {
    export interface ResourcePacker {write(path: string, buffer: ArrayBufferLike): FileReferenceSchema}

    export interface Options {
        readonly applicationVersion?: string
    }

    export interface Result {
        readonly project: ProjectSchema
        readonly issues: ReadonlyArray<string>
    }

    // the openDAW state of a WebCLAP device, next to the .clap-preset other applications read
    export const ClapSidecarSuffix = ".opendaw"

    export const samplePath = (box: AudioFileBox): string =>
        `samples/${UUID.toString(box.address.uuid)}/${fileNameOf(box.fileName.getValue().replace(/\.wav$/i, ""))}.wav`

    export const hueToColor = (hue: number): string => Color.hslToHex(hue, 1.0, 0.5)

    export const colorToHue = (color: string): number => Math.round(Color.hexToHsl(color).h) % 360

    export const write = (skeleton: ProjectSkeleton,
                          sampleManager: SampleLoaderManager,
                          resourcePacker: ResourcePacker): ProjectSchema =>
        writeWithReport(skeleton, sampleManager, resourcePacker).project

    const fileNameOf = (name: string): string => {
        const cleaned = name.replace(/[\u0000-\u001F/\\:*?"<>|]/g, "_").trim()
        return cleaned.length > 0 ? cleaned : "sample"
    }

    const toBeats = (pulses: number): number => pulses / PPQN.Quarter

    const toInterpolation = (event: ValueEventBox): Interpolation =>
        InterpolationFieldAdapter.read(event.interpolation).type === "none" ? Interpolation.HOLD : Interpolation.LINEAR

    const byPosition = <T extends { position: { getValue(): number } }>(left: T, right: T): number =>
        left.position.getValue() - right.position.getValue()

    const readTempoEvents = ({tempoTrack}: TimelineBox): ReadonlyArray<ValueEvent> => {
        if (!tempoTrack.enabled.getValue()) {return Arrays.empty()}
        return tempoTrack.events.targetVertex.mapOr(({box}) => asInstanceOf(box, ValueEventCollectionBox).events
            .pointerHub.incoming()
            .map(({box}) => asInstanceOf(box, ValueEventBox))
            .map((event): ValueEvent => ({
                type: "value-event", position: event.position.getValue(), index: event.index.getValue(),
                value: event.value.getValue(), interpolation: InterpolationFieldAdapter.read(event.interpolation)
            }))
            .sort(ValueEvent.Comparator), Arrays.empty<ValueEvent>())
    }

    const pluginStateOf = (box: WclapBoxes.Any): Uint8Array => {
        const bytes = box.pluginState.getValue()
        if (bytes.byteLength > 0) {return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)}
        const legacy = box.state.getValue()
        return legacy.length > 0 ? Uint8Array.from(atob(legacy), char => char.charCodeAt(0)) : new Uint8Array(0)
    }

    export const writeWithReport = (skeleton: ProjectSkeleton,
                                    sampleManager: SampleLoaderManager,
                                    resourcePacker: ResourcePacker,
                                    options: Options = {}): Result => {
        const issues: Array<string> = []
        const ids = new DawProjectIds()
        const {boxGraph, mandatoryBoxes: {timelineBox, rootBox}} = skeleton
        const audioUnits: ReadonlyArray<AudioUnitBox> = rootBox.audioUnits.pointerHub.incoming()
            .map(({box}) => asInstanceOf(box, AudioUnitBox))
            .sort((left, right) => left.index.getValue() - right.index.getValue())
        const tracksOf = (unit: AudioUnitBox): ReadonlyArray<TrackBox> => unit.tracks.pointerHub.incoming()
            .map(({box}) => asInstanceOf(box, TrackBox))
            .sort((left, right) => left.index.getValue() - right.index.getValue())
        const storageBpm = timelineBox.bpm.getValue()
        const tempoEvents = readTempoEvents(timelineBox)
        const tempoCursor = new TempoGridCursor()
        const secondsToPulses = (from: ppqn, duration: seconds): number => tempoEvents.length === 0
            ? PPQN.secondsToPulses(duration, storageBpm)
            : tempoCursor.advance(tempoEvents, from, 0.0, duration, storageBpm) - from
        const automatedTargets: ReadonlyArray<Address> = audioUnits
            .flatMap(tracksOf)
            .filter(track => track.type.getValue() === TrackType.Value)
            .flatMap(track => track.target.targetAddress.mapOr(address => [address], Arrays.empty<Address>()))
        boxGraph.boxes()
            .filter((box): box is AudioFileBox => isInstanceOf(box, AudioFileBox))
            .forEach(box => {
                const data = sampleManager.getOrCreate(box.address.uuid).data.unwrapOrUndefined()
                if (isDefined(data)) {
                    resourcePacker.write(samplePath(box), WavFile.encodeFloats(data))
                } else {
                    issues.push(`Sample '${box.fileName.getValue()}' is not loaded and could not be exported.`)
                }
            })
        const audioOf = (fileBox: AudioFileBox, algorithm: Optional<AudioAlgorithm>): AudioSchema => {
            const info = SampleLoader.infoOf(sampleManager.getOrCreate(fileBox.address.uuid))
            return Xml.element({
                id: ids.next(),
                duration: info.mapOr(({numberOfFrames, sampleRate}) => numberOfFrames / sampleRate,
                    fileBox.endInSeconds.getValue() - fileBox.startInSeconds.getValue()),
                channels: info.mapOr(({numberOfChannels}) => numberOfChannels, 2),
                sampleRate: info.mapOr(({sampleRate}) => Math.round(sampleRate), 44100),
                algorithm,
                file: Xml.element({path: samplePath(fileBox), external: false}, FileReferenceSchema)
            }, AudioSchema)
        }
        const anchors: ReadonlyArray<Box> = [rootBox, timelineBox]
        const tempoId = ids.of(timelineBox.bpm.address)
        const signatureId = ids.of(timelineBox.signature.address)
        const transport = Xml.element({
            tempo: Xml.element({
                id: tempoId, name: "Tempo", unit: Unit.BPM, value: storageBpm,
                min: timelineBox.tempoTrack.minBpm.getValue(), max: timelineBox.tempoTrack.maxBpm.getValue()
            }, RealParameterSchema),
            timeSignature: Xml.element({
                id: signatureId,
                numerator: timelineBox.signature.nominator.getValue(),
                denominator: timelineBox.signature.denominator.getValue()
            }, TimeSignatureParameterSchema)
        }, TransportSchema)
        const wclapParameter = (box: WclapParameterBox): Optional<ParameterSchema> => {
            const id = DawProjectIds.fromAddress(box.value.address)
            if (ids.has(id)) {return undefined}
            const min = box.min.getValue()
            const max = box.max.getValue()
            const value = box.value.getValue()
            return Xml.element({
                id: ids.of(box.value.address), name: box.label.getValue(), parameterID: box.clapId.getValue(),
                unit: Unit.NORMALIZED, min, max, value: max > min ? (value - min) / (max - min) : 0.0
            }, RealParameterSchema)
        }
        const parameterOf = (address: Address): Optional<ParameterSchema> => {
            if (ids.has(DawProjectIds.fromAddress(address))) {return undefined}
            const field = boxGraph.findVertex(address).unwrapOrUndefined()
            if (!isDefined(field) || !field.isField()) {return undefined}
            if (isInstanceOf(field.box, WclapParameterBox) && field === field.box.value) {return wclapParameter(field.box)}
            if (isInstanceOf(field, BooleanField)) {
                return Xml.element({id: ids.of(address), name: field.fieldName, value: field.getValue()}, BoolParameterSchema)
            }
            return Xml.element({id: ids.of(address), name: field.fieldName, unit: Unit.NORMALIZED, min: 0.0, max: 1.0},
                RealParameterSchema)
        }
        const writeDevice = (box: Box, deviceRole: DeviceRole): DeviceSchema => {
            const id = ids.of(box.address)
            const uuid = UUID.toString(box.address.uuid)
            const label: unknown = Reflect.get(box, "label")
            const deviceName = isInstanceOf(label, StringField) ? label.getValue() : box.name.replace(/(Device)?Box$/, "")
            const enabledField: unknown = Reflect.get(box, "enabled")
            const enabled = isInstanceOf(enabledField, BooleanField) ? Xml.element({
                id: ids.of(enabledField.address), name: "On/Off", value: enabledField.getValue()
            }, BoolParameterSchema) : undefined
            const stateUuids = UUID.newSet<UUID.Bytes>(uuid => uuid)
            stateUuids.addMany(DeviceState.boxesOf(box).map(dependency => dependency.address.uuid))
            const automated = automatedTargets.filter(address => stateUuids.hasKey(address.uuid))
            if (WclapBoxes.is(box)) {
                const pluginId = box.clapId.getValue()
                const path = `plugins/${uuid}.clap-preset`
                resourcePacker.write(`${path}${ClapSidecarSuffix}`, DeviceState.encode(box, anchors))
                const parameters = automated.map(parameterOf).filter(isDefined)
                return Xml.element({
                    id, deviceName, deviceRole, deviceID: pluginId, loaded: true, parameters, enabled,
                    state: resourcePacker.write(path, ClapPreset.encode({pluginId, state: pluginStateOf(box)}))
                }, ClapPluginSchema)
            }
            const state = resourcePacker.write(`devices/${uuid}.odd`, DeviceState.encode(box, anchors))
            const common = {id, deviceName, deviceRole, deviceID: box.name, deviceVendor: "openDAW", loaded: true, enabled, state}
            if (isInstanceOf(box, RevampDeviceBox)) {
                const bands = BuiltinDevices.revampBands(box, ids)
                return Xml.element({...common, bands, parameters: automated.map(parameterOf).filter(isDefined)}, EqualizerSchema)
            }
            return Xml.element({...common, parameters: automated.map(parameterOf).filter(isDefined)}, BuiltinDeviceSchema)
        }
        const writeEffects = (field: Field, deviceRole: DeviceRole): ReadonlyArray<DeviceSchema> =>
            IndexedBox.collectIndexedBoxes(field).map(box => writeDevice(box, deviceRole))
        const busOf = (unit: AudioUnitBox): Optional<AudioBusBox> => {
            const input = unit.input.pointerHub.incoming().at(0)?.box
            return isInstanceOf(input, AudioBusBox) ? input : undefined
        }
        const colorOf = (type: AudioUnitType, bus: Optional<AudioBusBox>): string => {
            const stored = bus?.color.getValue() ?? ""
            if (/^#[0-9a-fA-F]{6}$/.test(stored)) {return stored.toLowerCase()}
            if (/^hsl\(/.test(stored)) {return Color.hslStringToHex(stored)}
            return Color.hslStringToHex(ColorCodes.forAudioType(type).toString())
        }
        const contentTypeOf = (unit: AudioUnitBox, hasChildren: boolean): ReadonlyArray<ContentType> => {
            const type = unit.type.getValue()
            if (type === AudioUnitType.Output) {return [ContentType.AUDIO, ContentType.NOTES]}
            if (type === AudioUnitType.Bus && hasChildren) {return [ContentType.TRACKS]}
            if (type !== AudioUnitType.Instrument) {return [ContentType.AUDIO]}
            const instrument = unit.input.pointerHub.incoming().at(0)?.box
            const key = isDefined(instrument) ? InstrumentFactories.keyOfBox(instrument) : undefined
            const trackType = isDefined(key) ? InstrumentFactories.Named[key].trackType : TrackType.Notes
            const automation = tracksOf(unit).some(track => track.type.getValue() === TrackType.Value)
            return [trackType === TrackType.Audio ? ContentType.AUDIO : ContentType.NOTES,
                ...(automation ? [ContentType.AUTOMATION] : [])]
        }
        const roleOf = (type: AudioUnitType): MixerRole => {
            switch (type) {
                case AudioUnitType.Output:
                    return MixerRole.MASTER
                case AudioUnitType.Aux:
                    return MixerRole.EFFECT
                case AudioUnitType.Bus:
                    return MixerRole.SUBMIX
                default:
                    return MixerRole.REGULAR
            }
        }
        const writeSend = (send: AuxSendBox): SendSchema => Xml.element({
            id: ids.of(send.address),
            destination: send.targetBus.targetVertex.mapOr(vertex => isInstanceOf(vertex.box, AudioBusBox)
                ? DawProjectIds.fromAddress(vertex.box.address) : undefined, undefined),
            type: send.routing.getValue() === AudioSendRouting.Pre ? SendType.PRE : SendType.POST,
            enable: Xml.element({value: true}, BoolParameterSchema),
            pan: Xml.element({
                id: ids.of(send.sendPan.address), name: "Pan", unit: Unit.NORMALIZED, min: 0.0, max: 1.0,
                value: (send.sendPan.getValue() + 1.0) / 2.0
            }, RealParameterSchema),
            volume: Xml.element({
                id: ids.of(send.sendGain.address), name: "Send", unit: Unit.LINEAR, min: 0.0, max: 2.0,
                value: dbToGain(send.sendGain.getValue())
            }, RealParameterSchema)
        }, SendSchema)
        const writeTrack = ({audioUnit: unit, children}: AudioUnitExportLayout.Track): TrackSchema => {
            const type = unit.type.getValue() as AudioUnitType
            const bus = busOf(unit)
            const input = unit.input.pointerHub.incoming().at(0)?.box
            const instrument = isDefined(input) && !isDefined(bus) ? input : undefined
            const name = isDefined(bus)
                ? bus.label.getValue()
                : isDefined(instrument) ? DeviceBoxUtils.lookupLabelField(instrument).getValue() : ""
            return Xml.element({
                id: ids.of(unit.address),
                name,
                color: colorOf(type, bus),
                loaded: true,
                contentType: contentTypeOf(unit, children.length > 0),
                channel: Xml.element({
                    id: isDefined(bus) ? ids.of(bus.address) : ids.of(unit.input.address),
                    role: roleOf(type),
                    audioChannels: 2,
                    destination: unit.output.targetVertex.mapOr(vertex => {
                        const target = vertex.box
                        return isInstanceOf(target, AudioBusBox) ? DawProjectIds.fromAddress(target.address) : undefined
                    }, undefined),
                    solo: unit.solo.getValue(),
                    devices: [
                        ...writeEffects(unit.midiEffects, DeviceRole.NOTE_FX),
                        ...(isDefined(instrument) ? [writeDevice(instrument, DeviceRole.INSTRUMENT)] : []),
                        ...writeEffects(unit.audioEffects, DeviceRole.AUDIO_FX),
                        ...unit.mastering.pointerHub.incoming().map(({box}) => writeDevice(box, DeviceRole.AUDIO_FX))
                    ],
                    mute: Xml.element({id: ids.of(unit.mute.address), name: "Mute", value: unit.mute.getValue()},
                        BoolParameterSchema),
                    pan: Xml.element({
                        id: ids.of(unit.panning.address), name: "Pan", unit: Unit.NORMALIZED, min: 0.0, max: 1.0,
                        value: (unit.panning.getValue() + 1.0) / 2.0
                    }, RealParameterSchema),
                    sends: unit.auxSends.pointerHub.incoming()
                        .map(({box}) => asInstanceOf(box, AuxSendBox))
                        .sort((left, right) => left.index.getValue() - right.index.getValue())
                        .map(writeSend),
                    volume: Xml.element({
                        id: ids.of(unit.volume.address), name: "Volume", unit: Unit.LINEAR, min: 0.0, max: 2.0,
                        value: dbToGain(unit.volume.getValue())
                    }, RealParameterSchema)
                }, ChannelSchema),
                tracks: children.map(writeTrack)
            }, TrackSchema)
        }
        const structure = AudioUnitExportLayout.layout(audioUnits).map(writeTrack)
        const writtenContent = UUID.newSet<UUID.Bytes>(uuid => uuid)
        const contentOf = (collection: Box, create: () => TimelineSchema): { content?: TimelineSchema, reference?: string } => {
            if (writtenContent.hasKey(collection.address.uuid)) {return {reference: DawProjectIds.fromAddress(collection.address)}}
            writtenContent.add(collection.address.uuid)
            return {content: create()}
        }
        const clipLook = (label: string, hue: int, mute: boolean) =>
            ({name: label.length > 0 ? label : undefined, color: hueToColor(hue), enable: !mute})
        const writeNote = (event: NoteEventBox): NoteSchema => {
            const cent = event.cent.getValue()
            return Xml.element({
                time: toBeats(event.position.getValue()),
                duration: toBeats(event.duration.getValue()),
                channel: 0,
                key: event.pitch.getValue(),
                vel: event.velocity.getValue(),
                content: cent === 0.0 ? undefined : Xml.element({
                    unit: Unit.SEMITONES,
                    target: Xml.element({expression: ExpressionType.TRANSPOSE}, AutomationTargetSchema),
                    points: [Xml.element({time: 0.0, value: cent / 100.0}, RealPointSchema)]
                }, PointsSchema)
            }, NoteSchema)
        }
        const notesOf = (collection: NoteEventCollectionBox) => contentOf(collection, () => Xml.element({
            id: ids.of(collection.address),
            notes: collection.events.pointerHub.incoming()
                .map(({box}) => asInstanceOf(box, NoteEventBox))
                .sort((left, right) => byPosition(left, right) || left.pitch.getValue() - right.pitch.getValue())
                .map(writeNote)
        }, NotesSchema))
        type ValueEncoder = { unit: Optional<Unit>, encode: (event: ValueEventBox) => PointSchema }
        const valueEncoderOf = (target: Address): ValueEncoder => {
            const field = boxGraph.findVertex(target).unwrapOrUndefined()
            const gainMapping: Optional<ValueMapping<number>> =
                isDefined(field) && isInstanceOf(field.box, AudioUnitBox) && field === field.box.volume
                    ? AudioUnitBoxAdapter.VolumeMapper
                    : isDefined(field) && isInstanceOf(field.box, AuxSendBox) && field === field.box.sendGain
                        ? ValueMapping.DefaultDecibel : undefined
            const time = (event: ValueEventBox) => toBeats(event.position.getValue())
            if (isDefined(gainMapping)) {
                return {
                    unit: Unit.LINEAR, encode: event => Xml.element({
                        time: time(event), value: dbToGain(gainMapping.y(event.value.getValue())),
                        interpolation: toInterpolation(event)
                    }, RealPointSchema)
                }
            }
            if (isInstanceOf(field, BooleanField)) {
                return {unit: undefined, encode: event => Xml.element({time: time(event), value: event.value.getValue() >= 0.5}, BoolPointSchema)}
            }
            return {
                unit: Unit.NORMALIZED, encode: event => Xml.element({
                    time: time(event), value: event.value.getValue(), interpolation: toInterpolation(event)
                }, RealPointSchema)
            }
        }
        const pointsOf = (collection: ValueEventCollectionBox, target: Address, parameter: string) => {
            const {unit, encode} = valueEncoderOf(target)
            return contentOf(collection, () => Xml.element({
                id: ids.of(collection.address), unit,
                target: Xml.element({parameter}, AutomationTargetSchema),
                points: collection.events.pointerHub.incoming()
                    .map(({box}) => asInstanceOf(box, ValueEventBox))
                    .sort((left, right) => byPosition(left, right) || left.index.getValue() - right.index.getValue())
                    .map(encode)
            }, PointsSchema))
        }
        type AudioProps = {
            fileBox: AudioFileBox, playMode: Optional<Box>, timeBase: TimeBase, position: ppqn, duration: number,
            loopOffset: number, loopDuration: number, loop: boolean, waveformOffset: seconds
        }
        const audioClipTiming = (props: AudioProps): Optional<Partial<ClipSchema>> => {
            const {fileBox, playMode, timeBase, position, duration, loopOffset, loopDuration, loop, waveformOffset} = props
            const isSeconds = timeBase === TimeBase.Seconds
            const pulses = (value: number): number => isSeconds ? secondsToPulses(position, value) : value
            const warping = isInstanceOf(playMode, AudioPitchStretchBox)
                || isInstanceOf(playMode, AudioTimeStretchBox) || isInstanceOf(playMode, AudioSignalsmithBox)
            if (warping) {
                const markers = playMode.warpMarkers.pointerHub.incoming()
                    .map(({box}) => asInstanceOf(box, WarpMarkerBox))
                    .sort(byPosition)
                const last = markers.at(-1)
                if (markers.length < 2 || !isDefined(last)) {
                    issues.push(`Audio '${fileBox.fileName.getValue()}' has no warp markers and was not exported.`)
                    return undefined
                }
                const algorithm = isInstanceOf(playMode, AudioPitchStretchBox) ? AudioAlgorithm.REPITCH : AudioAlgorithm.STRETCH
                return {
                    duration: toBeats(pulses(duration)), contentTimeUnit: TimeUnit.BEATS, playStart: toBeats(pulses(loopOffset)),
                    loopStart: loop ? 0.0 : undefined, loopEnd: loop ? toBeats(pulses(loopDuration)) : undefined,
                    content: Xml.element({
                        id: ids.next(),
                        clips: [Xml.element({
                            time: 0.0, duration: toBeats(last.position.getValue()), contentTimeUnit: TimeUnit.BEATS, playStart: 0.0,
                            content: Xml.element({
                                id: ids.next(), timeUnit: TimeUnit.BEATS, contentTimeUnit: TimeUnit.SECONDS,
                                content: audioOf(fileBox, algorithm),
                                warps: markers.map(marker => Xml.element({
                                    time: toBeats(marker.position.getValue()), contentTime: marker.seconds.getValue() + waveformOffset
                                }, WarpSchema))
                            }, WarpsSchema)
                        }, ClipSchema)]
                    }, ClipsSchema)
                }
            }
            if (!isSeconds) {
                if (waveformOffset !== 0.0) {
                    issues.push(`The waveform offset of '${fileBox.fileName.getValue()}' could not be exported.`)
                }
                return {
                    duration: toBeats(duration), contentTimeUnit: TimeUnit.BEATS, playStart: toBeats(loopOffset),
                    loopStart: loop ? 0.0 : undefined, loopEnd: loop ? toBeats(loopDuration) : undefined,
                    content: audioOf(fileBox, undefined)
                }
            }
            return {
                duration: toBeats(secondsToPulses(position, duration)),
                contentTimeUnit: TimeUnit.SECONDS,
                playStart: waveformOffset + loopOffset,
                loopStart: loop ? waveformOffset : undefined,
                loopEnd: loop ? waveformOffset + loopDuration : undefined,
                content: audioOf(fileBox, undefined)
            }
        }
        const writeAudioRegion = (region: AudioRegionBox): Optional<ClipSchema> => {
            const timing = audioClipTiming({
                fileBox: asInstanceOf(region.file.targetVertex.unwrap("No file at region").box, AudioFileBox),
                playMode: region.playMode.targetVertex.mapOr(({box}) => box, undefined),
                timeBase: region.timeBase.getValue() as TimeBase,
                position: region.position.getValue(),
                duration: region.duration.getValue(),
                loopOffset: region.loopOffset.getValue(),
                loopDuration: region.loopDuration.getValue(),
                loop: true,
                waveformOffset: region.waveformOffset.getValue()
            })
            if (!isDefined(timing)) {return undefined}
            return Xml.element({
                ...clipLook(region.label.getValue(), region.hue.getValue(), region.mute.getValue()),
                ...timing,
                time: toBeats(region.position.getValue()),
                fadeTimeUnit: TimeUnit.BEATS,
                fadeInTime: toBeats(region.fading.in.getValue()),
                fadeOutTime: toBeats(region.fading.out.getValue())
            }, ClipSchema)
        }
        const writeNoteRegion = (region: NoteRegionBox): ClipSchema => Xml.element({
            ...clipLook(region.label.getValue(), region.hue.getValue(), region.mute.getValue()),
            ...notesOf(asInstanceOf(region.events.targetVertex.unwrap("No notes in region").box, NoteEventCollectionBox)),
            time: toBeats(region.position.getValue()),
            duration: toBeats(region.duration.getValue()),
            contentTimeUnit: TimeUnit.BEATS,
            playStart: toBeats(region.loopOffset.getValue()),
            loopStart: 0.0,
            loopEnd: toBeats(region.loopDuration.getValue())
        }, ClipSchema)
        const writeValueRegion = (region: ValueRegionBox, target: Address, parameter: string): ClipSchema => Xml.element({
            ...clipLook(region.label.getValue(), region.hue.getValue(), region.mute.getValue()),
            ...pointsOf(asInstanceOf(region.events.targetVertex.unwrap("No events in region").box, ValueEventCollectionBox),
                target, parameter),
            time: toBeats(region.position.getValue()),
            duration: toBeats(region.duration.getValue()),
            contentTimeUnit: TimeUnit.BEATS,
            playStart: toBeats(region.loopOffset.getValue()),
            loopStart: 0.0,
            loopEnd: toBeats(region.loopDuration.getValue())
        }, ClipSchema)
        const targetOf = (track: TrackBox): Optional<{ address: Address, parameter: string }> => {
            const address = track.target.targetAddress.unwrapOrUndefined()
            if (!isDefined(address)) {return undefined}
            const parameter = DawProjectIds.fromAddress(address)
            return ids.has(parameter) ? {address, parameter} : undefined
        }
        const unitNameOf = (unit: AudioUnitBox): string => {
            const input = unit.input.pointerHub.incoming().at(0)?.box
            return isDefined(input) ? DeviceBoxUtils.lookupLabelField(input).getValue() : "Unknown"
        }
        const writeTrackLane = (unit: AudioUnitBox, track: TrackBox): ReadonlyArray<TimelineSchema> => {
            const regions = track.regions.pointerHub.incoming().map(({box}) => box)
                .sort((left, right) => regionPosition(left) - regionPosition(right))
            if (track.type.getValue() === TrackType.Value) {
                const target = targetOf(track)
                if (!isDefined(target)) {
                    issues.push(`An automation track of '${unitNameOf(unit)}' controls a parameter DAWproject cannot address and was not exported.`)
                    return []
                }
                if (regions.length === 0) {
                    return [Xml.element({
                        id: ids.of(track.address), unit: valueEncoderOf(target.address).unit,
                        target: Xml.element({parameter: target.parameter}, AutomationTargetSchema)
                    }, PointsSchema)]
                }
                return [Xml.element({
                    id: ids.of(track.address),
                    clips: regions.filter((box): box is ValueRegionBox => isInstanceOf(box, ValueRegionBox))
                        .map(region => writeValueRegion(region, target.address, target.parameter))
                }, ClipsSchema)]
            }
            return [Xml.element({
                id: ids.of(track.address),
                clips: regions.map(box => box.accept<BoxVisitor<Optional<ClipSchema>>>({
                    visitNoteRegionBox: writeNoteRegion,
                    visitAudioRegionBox: writeAudioRegion
                })).filter((clip): clip is ClipSchema => isDefined(clip))
            }, ClipsSchema)]
        }
        const writeTempoAutomation = (): Optional<PointsSchema> => {
            const {tempoTrack} = timelineBox
            if (!tempoTrack.enabled.getValue()) {return undefined}
            const events = tempoTrack.events.targetVertex.mapOr(({box}) => asInstanceOf(box, ValueEventCollectionBox).events
                .pointerHub.incoming().map(({box}) => asInstanceOf(box, ValueEventBox)), Arrays.empty<ValueEventBox>())
            if (events.length === 0) {return undefined}
            return Xml.element({
                unit: Unit.BPM,
                target: Xml.element({parameter: tempoId}, AutomationTargetSchema),
                points: [...events]
                    .sort((left, right) => byPosition(left, right) || left.index.getValue() - right.index.getValue())
                    .map(event => Xml.element({
                        time: toBeats(event.position.getValue()), value: event.value.getValue(), interpolation: toInterpolation(event)
                    }, RealPointSchema))
            }, PointsSchema)
        }
        const writeSignatureAutomation = (): Optional<PointsSchema> => {
            const {signatureTrack, signature} = timelineBox
            if (!signatureTrack.enabled.getValue()) {return undefined}
            const events = signatureTrack.events.pointerHub.incoming()
                .map(({box}) => asInstanceOf(box, SignatureEventBox))
                .sort((left, right) => left.index.getValue() - right.index.getValue())
            if (events.length === 0) {return undefined}
            const points: Array<TimeSignaturePointSchema> = [Xml.element({
                time: 0.0, numerator: signature.nominator.getValue(), denominator: signature.denominator.getValue()
            }, TimeSignaturePointSchema)]
            events.reduce((state, event) => {
                const position = state.position + PPQN.fromSignature(state.numerator, state.denominator) * event.relativePosition.getValue()
                const numerator = event.nominator.getValue()
                const denominator = event.denominator.getValue()
                points.push(Xml.element({time: toBeats(position), numerator, denominator}, TimeSignaturePointSchema))
                return {position, numerator, denominator}
            }, {position: 0, numerator: signature.nominator.getValue(), denominator: signature.denominator.getValue()})
            return Xml.element({target: Xml.element({parameter: signatureId}, AutomationTargetSchema), points}, PointsSchema)
        }
        const writeMarkers = (): Optional<MarkersSchema> => {
            const markers = timelineBox.markerTrack.markers.pointerHub.incoming()
                .map(({box}) => asInstanceOf(box, MarkerBox))
                .sort(byPosition)
            if (markers.length === 0) {return undefined}
            return Xml.element({
                id: ids.next(),
                markers: markers.map(marker => Xml.element({
                    time: toBeats(marker.position.getValue()),
                    name: marker.label.getValue(),
                    color: hueToColor(marker.hue.getValue())
                }, MarkerSchema))
            }, MarkersSchema)
        }
        const arrangement = Xml.element({
            id: ids.next(),
            lanes: Xml.element({
                id: ids.next(),
                timeUnit: TimeUnit.BEATS,
                lanes: audioUnits.map(unit => Xml.element({
                    id: ids.next(),
                    track: DawProjectIds.fromAddress(unit.address),
                    lanes: tracksOf(unit).flatMap(track => writeTrackLane(unit, track))
                }, LanesSchema))
            }, LanesSchema),
            markers: writeMarkers(),
            tempoAutomation: writeTempoAutomation(),
            timeSignatureAutomation: writeSignatureAutomation()
        }, ArrangementSchema)
        const writeSlotClip = (clip: Box, track: TrackBox): Optional<ClipSchema> => clip.accept<BoxVisitor<Optional<ClipSchema>>>({
            visitNoteClipBox: (box: NoteClipBox) => Xml.element({
                ...clipLook(box.label.getValue(), box.hue.getValue(), box.mute.getValue()),
                ...notesOf(asInstanceOf(box.events.targetVertex.unwrap("No notes in clip").box, NoteEventCollectionBox)),
                time: 0.0, duration: toBeats(box.duration.getValue()), contentTimeUnit: TimeUnit.BEATS, playStart: 0.0,
                loopStart: box.triggerMode.loop.getValue() ? 0.0 : undefined,
                loopEnd: box.triggerMode.loop.getValue() ? toBeats(box.duration.getValue()) : undefined
            }, ClipSchema),
            visitValueClipBox: (box: ValueClipBox) => {
                const target = targetOf(track)
                if (!isDefined(target)) {return undefined}
                return Xml.element({
                    ...clipLook(box.label.getValue(), box.hue.getValue(), box.mute.getValue()),
                    ...pointsOf(asInstanceOf(box.events.targetVertex.unwrap("No events in clip").box, ValueEventCollectionBox),
                        target.address, target.parameter),
                    time: 0.0, duration: toBeats(box.duration.getValue()), contentTimeUnit: TimeUnit.BEATS, playStart: 0.0,
                    loopStart: box.triggerMode.loop.getValue() ? 0.0 : undefined,
                    loopEnd: box.triggerMode.loop.getValue() ? toBeats(box.duration.getValue()) : undefined
                }, ClipSchema)
            },
            visitAudioClipBox: (box: AudioClipBox) => {
                const loop = box.triggerMode.loop.getValue()
                const timing = audioClipTiming({
                    fileBox: asInstanceOf(box.file.targetVertex.unwrap("No file at clip").box, AudioFileBox),
                    playMode: box.playMode.targetVertex.mapOr(({box}) => box, undefined),
                    timeBase: box.timeBase.getValue() as TimeBase,
                    position: 0, duration: box.duration.getValue(), loopOffset: 0, loopDuration: box.duration.getValue(),
                    loop, waveformOffset: box.waveformOffset.getValue()
                })
                if (!isDefined(timing)) {return undefined}
                return Xml.element({
                    ...clipLook(box.label.getValue(), box.hue.getValue(), box.mute.getValue()),
                    ...timing,
                    time: 0.0
                }, ClipSchema)
            }
        }) ?? undefined
        const slotIndexOf = (box: Box): int => IndexedBox.isIndexedBox(box) ? box.index.getValue() : 0
        const sceneCount = audioUnits.flatMap(tracksOf)
            .flatMap(track => track.clips.pointerHub.incoming().map(({box}) => slotIndexOf(box) + 1))
            .reduce((max, count) => Math.max(max, count), 0)
        // every track has a slot in every scene, in track order, so a slot finds its track again
        const scenes: ReadonlyArray<SceneSchema> = Array.from({length: sceneCount}, (_, row) => Xml.element({
            id: ids.next(),
            content: Xml.element({
                id: ids.next(),
                lanes: audioUnits.flatMap(unit => tracksOf(unit).map(track => {
                    const clip = track.clips.pointerHub.incoming().map(({box}) => box).find(box => slotIndexOf(box) === row)
                    return Xml.element({
                        id: ids.next(),
                        track: DawProjectIds.fromAddress(unit.address),
                        hasStop: true,
                        clip: isDefined(clip) ? writeSlotClip(clip, track) : undefined
                    }, ClipSlotSchema)
                }))
            }, LanesSchema)
        }, SceneSchema))
        const project = Xml.element({
            version: "1.0",
            application: Xml.element({name: "openDAW", version: options.applicationVersion ?? "1.0"}, ApplicationSchema),
            transport,
            structure,
            arrangement,
            scenes
        }, ProjectSchema)
        return {project, issues}
    }

    const regionPosition = (box: Box): number => {
        const position: unknown = Reflect.get(box, "position")
        return isInstanceOf(position, Int32Field) ? position.getValue() : 0
    }
}
