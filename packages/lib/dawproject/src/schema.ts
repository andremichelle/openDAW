// Generated from Project.xsd and MetaData.xsd by generator/SchemaGenerator.ts, do not edit.
import type {int} from "@opendaw/lib-std"
import {Xml} from "@opendaw/lib-xml"
import {DawCodecs} from "./DawCodecs"

export enum Unit {
    LINEAR = "linear",
    NORMALIZED = "normalized",
    PERCENT = "percent",
    DECIBEL = "decibel",
    HERTZ = "hertz",
    SEMITONES = "semitones",
    SECONDS = "seconds",
    BEATS = "beats",
    BPM = "bpm"
}

export enum TimeUnit {
    BEATS = "beats",
    SECONDS = "seconds"
}

export enum DeviceRole {
    INSTRUMENT = "instrument",
    NOTE_FX = "noteFX",
    AUDIO_FX = "audioFX",
    ANALYZER = "analyzer"
}

export enum EqBandType {
    HIGH_PASS = "highPass",
    LOW_PASS = "lowPass",
    BAND_PASS = "bandPass",
    HIGH_SHELF = "highShelf",
    LOW_SHELF = "lowShelf",
    BELL = "bell",
    NOTCH = "notch"
}

export enum MixerRole {
    REGULAR = "regular",
    MASTER = "master",
    EFFECT = "effect",
    SUBMIX = "submix",
    VCA = "vca"
}

export enum SendType {
    PRE = "pre",
    POST = "post"
}

export enum ContentType {
    AUDIO = "audio",
    AUTOMATION = "automation",
    NOTES = "notes",
    VIDEO = "video",
    MARKERS = "markers",
    TRACKS = "tracks"
}

export enum Interpolation {
    HOLD = "hold",
    LINEAR = "linear"
}

export enum ExpressionType {
    GAIN = "gain",
    PAN = "pan",
    TRANSPOSE = "transpose",
    TIMBRE = "timbre",
    FORMANT = "formant",
    PRESSURE = "pressure",
    CHANNEL_CONTROLLER = "channelController",
    CHANNEL_PRESSURE = "channelPressure",
    POLY_PRESSURE = "polyPressure",
    PITCH_BEND = "pitchBend",
    PROGRAM_CHANGE = "programChange"
}

@Xml.Class("Project")
export class ProjectSchema {
    @Xml.Attribute("version", Xml.StringRequired) declare readonly version: string
    @Xml.Child(() => ApplicationSchema, {name: "Application", required: true}) declare readonly application: ApplicationSchema
    @Xml.Child(() => TransportSchema, {name: "Transport"}) declare readonly transport?: TransportSchema
    @Xml.Children(() => [TrackSchema, ChannelSchema], {wrapper: "Structure"}) declare readonly structure: ReadonlyArray<LaneSchema>
    @Xml.Child(() => ArrangementSchema) declare readonly arrangement?: ArrangementSchema
    @Xml.Children(() => SceneSchema, {wrapper: "Scenes"}) declare readonly scenes: ReadonlyArray<SceneSchema>
}

export class ApplicationSchema {
    @Xml.Attribute("name", Xml.StringRequired) declare readonly name: string
    @Xml.Attribute("version", Xml.StringRequired) declare readonly version: string
}

export class TransportSchema {
    @Xml.Child(() => RealParameterSchema, {name: "Tempo"}) declare readonly tempo?: RealParameterSchema
    @Xml.Child(() => TimeSignatureParameterSchema, {name: "TimeSignature"}) declare readonly timeSignature?: TimeSignatureParameterSchema
}

export abstract class NameableSchema {
    @Xml.Attribute("name", Xml.StringOptional) declare readonly name?: string
    @Xml.Attribute("color", Xml.StringOptional) declare readonly color?: string
    @Xml.Attribute("comment", Xml.StringOptional) declare readonly comment?: string
}

export abstract class ReferenceableSchema extends NameableSchema {
    @Xml.Attribute("id", Xml.StringOptional) declare readonly id?: string
}

@Xml.Class("parameter")
export abstract class ParameterSchema extends ReferenceableSchema {
    @Xml.Attribute("parameterID", Xml.IntOptional) declare readonly parameterID?: int
}

@Xml.Class("RealParameter")
export class RealParameterSchema extends ParameterSchema {
    @Xml.Attribute("max", DawCodecs.DoubleOptional) declare readonly max?: number
    @Xml.Attribute("min", DawCodecs.DoubleOptional) declare readonly min?: number
    @Xml.Attribute("unit", Xml.Enum(Unit, true)) declare readonly unit: Unit
    @Xml.Attribute("value", DawCodecs.DoubleOptional) declare readonly value?: number
}

@Xml.Class("BoolParameter")
export class BoolParameterSchema extends ParameterSchema {
    @Xml.Attribute("value", Xml.BoolOptional) declare readonly value?: boolean
}

@Xml.Class("IntegerParameter")
export class IntegerParameterSchema extends ParameterSchema {
    @Xml.Attribute("max", Xml.IntOptional) declare readonly max?: int
    @Xml.Attribute("min", Xml.IntOptional) declare readonly min?: int
    @Xml.Attribute("value", Xml.IntOptional) declare readonly value?: int
}

@Xml.Class("EnumParameter")
export class EnumParameterSchema extends ParameterSchema {
    @Xml.Attribute("count", Xml.IntRequired) declare readonly count: int
    @Xml.Attribute("labels", Xml.List(Xml.StringRequired, false)) declare readonly labels?: ReadonlyArray<string>
    @Xml.Attribute("value", Xml.IntOptional) declare readonly value?: int
}

@Xml.Class("TimeSignatureParameter")
export class TimeSignatureParameterSchema extends ParameterSchema {
    @Xml.Attribute("denominator", Xml.IntRequired) declare readonly denominator: int
    @Xml.Attribute("numerator", Xml.IntRequired) declare readonly numerator: int
}

export abstract class LaneSchema extends ReferenceableSchema {
}

@Xml.Class("Arrangement")
export class ArrangementSchema extends ReferenceableSchema {
    @Xml.Child(() => LanesSchema) declare readonly lanes?: LanesSchema
    @Xml.Child(() => MarkersSchema, {name: "Markers"}) declare readonly markers?: MarkersSchema
    @Xml.Child(() => PointsSchema, {name: "TempoAutomation"}) declare readonly tempoAutomation?: PointsSchema
    @Xml.Child(() => PointsSchema, {name: "TimeSignatureAutomation"}) declare readonly timeSignatureAutomation?: PointsSchema
}

@Xml.Class("Timeline")
export abstract class TimelineSchema extends ReferenceableSchema {
    @Xml.Attribute("timeUnit", Xml.Enum(TimeUnit, false)) declare readonly timeUnit?: TimeUnit
    @Xml.Attribute("track", Xml.StringOptional) declare readonly track?: string
}

@Xml.Class("Lanes")
export class LanesSchema extends TimelineSchema {
    @Xml.Children(() => [TimelineSchema, LanesSchema, NotesSchema, ClipsSchema, ClipSlotSchema, MarkersSchema, WarpsSchema, AudioSchema, VideoSchema, PointsSchema]) declare readonly lanes: ReadonlyArray<TimelineSchema>
}

@Xml.Class("Track")
export class TrackSchema extends LaneSchema {
    @Xml.Attribute("contentType", Xml.List(Xml.Enum(ContentType, true), false)) declare readonly contentType?: ReadonlyArray<ContentType>
    @Xml.Attribute("loaded", Xml.BoolOptional) declare readonly loaded?: boolean
    @Xml.Child(() => ChannelSchema) declare readonly channel?: ChannelSchema
    @Xml.Children(() => TrackSchema) declare readonly tracks: ReadonlyArray<TrackSchema>
}

@Xml.Class("Channel")
export class ChannelSchema extends LaneSchema {
    @Xml.Attribute("audioChannels", Xml.IntOptional) declare readonly audioChannels?: int
    @Xml.Attribute("destination", Xml.StringOptional) declare readonly destination?: string
    @Xml.Attribute("role", Xml.Enum(MixerRole, false)) declare readonly role?: MixerRole
    @Xml.Attribute("solo", Xml.BoolOptional) declare readonly solo?: boolean
    @Xml.Children(() => [DeviceSchema, Vst2PluginSchema, Vst3PluginSchema, ClapPluginSchema, BuiltinDeviceSchema, EqualizerSchema, CompressorSchema, NoiseGateSchema, LimiterSchema, AuPluginSchema], {wrapper: "Devices"}) declare readonly devices: ReadonlyArray<DeviceSchema>
    @Xml.Child(() => BoolParameterSchema, {name: "Mute"}) declare readonly mute?: BoolParameterSchema
    @Xml.Child(() => RealParameterSchema, {name: "Pan"}) declare readonly pan?: RealParameterSchema
    @Xml.Children(() => SendSchema, {name: "Send", wrapper: "Sends"}) declare readonly sends: ReadonlyArray<SendSchema>
    @Xml.Child(() => RealParameterSchema, {name: "Volume"}) declare readonly volume?: RealParameterSchema
}

@Xml.Class("Device")
export class DeviceSchema extends ReferenceableSchema {
    @Xml.Attribute("deviceID", Xml.StringOptional) declare readonly deviceID?: string
    @Xml.Attribute("deviceName", Xml.StringRequired) declare readonly deviceName: string
    @Xml.Attribute("deviceRole", Xml.Enum(DeviceRole, true)) declare readonly deviceRole: DeviceRole
    @Xml.Attribute("deviceVendor", Xml.StringOptional) declare readonly deviceVendor?: string
    @Xml.Attribute("loaded", Xml.BoolOptional) declare readonly loaded?: boolean
    @Xml.Children(() => [ParameterSchema, RealParameterSchema, BoolParameterSchema, IntegerParameterSchema, EnumParameterSchema, TimeSignatureParameterSchema], {wrapper: "Parameters"}) declare readonly parameters: ReadonlyArray<ParameterSchema>
    @Xml.Child(() => BoolParameterSchema, {name: "Enabled"}) declare readonly enabled?: BoolParameterSchema
    @Xml.Child(() => FileReferenceSchema, {name: "State"}) declare readonly state?: FileReferenceSchema
}

export class FileReferenceSchema {
    @Xml.Attribute("path", Xml.StringRequired) declare readonly path: string
    @Xml.Attribute("external", Xml.BoolOptional) declare readonly external?: boolean
}

export abstract class PluginSchema extends DeviceSchema {
    @Xml.Attribute("pluginVersion", Xml.StringOptional) declare readonly pluginVersion?: string
}

@Xml.Class("Vst2Plugin")
export class Vst2PluginSchema extends PluginSchema {
}

@Xml.Class("Vst3Plugin")
export class Vst3PluginSchema extends PluginSchema {
}

@Xml.Class("ClapPlugin")
export class ClapPluginSchema extends PluginSchema {
}

@Xml.Class("BuiltinDevice")
export class BuiltinDeviceSchema extends DeviceSchema {
}

@Xml.Class("Equalizer")
export class EqualizerSchema extends BuiltinDeviceSchema {
    @Xml.Children(() => EqBandSchema, {name: "Band"}) declare readonly bands: ReadonlyArray<EqBandSchema>
    @Xml.Child(() => RealParameterSchema, {name: "InputGain"}) declare readonly inputGain?: RealParameterSchema
    @Xml.Child(() => RealParameterSchema, {name: "OutputGain"}) declare readonly outputGain?: RealParameterSchema
}

export class EqBandSchema {
    @Xml.Attribute("type", Xml.Enum(EqBandType, true)) declare readonly type: EqBandType
    @Xml.Attribute("order", Xml.IntOptional) declare readonly order?: int
    @Xml.Child(() => RealParameterSchema, {name: "Freq", required: true}) declare readonly freq: RealParameterSchema
    @Xml.Child(() => RealParameterSchema, {name: "Gain"}) declare readonly gain?: RealParameterSchema
    @Xml.Child(() => RealParameterSchema, {name: "Q"}) declare readonly q?: RealParameterSchema
    @Xml.Child(() => BoolParameterSchema, {name: "Enabled"}) declare readonly enabled?: BoolParameterSchema
}

@Xml.Class("Compressor")
export class CompressorSchema extends BuiltinDeviceSchema {
    @Xml.Child(() => RealParameterSchema, {name: "Attack"}) declare readonly attack?: RealParameterSchema
    @Xml.Child(() => BoolParameterSchema, {name: "AutoMakeup"}) declare readonly autoMakeup?: BoolParameterSchema
    @Xml.Child(() => RealParameterSchema, {name: "InputGain"}) declare readonly inputGain?: RealParameterSchema
    @Xml.Child(() => RealParameterSchema, {name: "OutputGain"}) declare readonly outputGain?: RealParameterSchema
    @Xml.Child(() => RealParameterSchema, {name: "Ratio"}) declare readonly ratio?: RealParameterSchema
    @Xml.Child(() => RealParameterSchema, {name: "Release"}) declare readonly release?: RealParameterSchema
    @Xml.Child(() => RealParameterSchema, {name: "Threshold"}) declare readonly threshold?: RealParameterSchema
}

@Xml.Class("NoiseGate")
export class NoiseGateSchema extends BuiltinDeviceSchema {
    @Xml.Child(() => RealParameterSchema, {name: "Attack"}) declare readonly attack?: RealParameterSchema
    @Xml.Child(() => RealParameterSchema, {name: "Range"}) declare readonly range?: RealParameterSchema
    @Xml.Child(() => RealParameterSchema, {name: "Ratio"}) declare readonly ratio?: RealParameterSchema
    @Xml.Child(() => RealParameterSchema, {name: "Release"}) declare readonly release?: RealParameterSchema
    @Xml.Child(() => RealParameterSchema, {name: "Threshold"}) declare readonly threshold?: RealParameterSchema
}

@Xml.Class("Limiter")
export class LimiterSchema extends BuiltinDeviceSchema {
    @Xml.Child(() => RealParameterSchema, {name: "Attack"}) declare readonly attack?: RealParameterSchema
    @Xml.Child(() => RealParameterSchema, {name: "InputGain"}) declare readonly inputGain?: RealParameterSchema
    @Xml.Child(() => RealParameterSchema, {name: "OutputGain"}) declare readonly outputGain?: RealParameterSchema
    @Xml.Child(() => RealParameterSchema, {name: "Release"}) declare readonly release?: RealParameterSchema
    @Xml.Child(() => RealParameterSchema, {name: "Threshold"}) declare readonly threshold?: RealParameterSchema
}

@Xml.Class("AuPlugin")
export class AuPluginSchema extends PluginSchema {
}

export class SendSchema extends ReferenceableSchema {
    @Xml.Attribute("destination", Xml.StringOptional) declare readonly destination?: string
    @Xml.Attribute("type", Xml.Enum(SendType, false)) declare readonly type?: SendType
    @Xml.Child(() => BoolParameterSchema, {name: "Enable"}) declare readonly enable?: BoolParameterSchema
    @Xml.Child(() => RealParameterSchema, {name: "Pan"}) declare readonly pan?: RealParameterSchema
    @Xml.Child(() => RealParameterSchema, {name: "Volume", required: true}) declare readonly volume: RealParameterSchema
}

@Xml.Class("Note")
export class NoteSchema {
    @Xml.Attribute("time", DawCodecs.DoubleRequired) declare readonly time: number
    @Xml.Attribute("duration", DawCodecs.DoubleRequired) declare readonly duration: number
    @Xml.Attribute("channel", Xml.IntRequired) declare readonly channel: int
    @Xml.Attribute("key", Xml.IntRequired) declare readonly key: int
    @Xml.Attribute("vel", DawCodecs.DoubleOptional) declare readonly vel?: number
    @Xml.Attribute("rel", DawCodecs.DoubleOptional) declare readonly rel?: number
    @Xml.Child(() => [TimelineSchema, LanesSchema, NotesSchema, ClipsSchema, ClipSlotSchema, MarkersSchema, WarpsSchema, AudioSchema, VideoSchema, PointsSchema]) declare readonly content?: TimelineSchema
}

@Xml.Class("Notes")
export class NotesSchema extends TimelineSchema {
    @Xml.Children(() => NoteSchema) declare readonly notes: ReadonlyArray<NoteSchema>
}

@Xml.Class("Clip")
export class ClipSchema extends NameableSchema {
    @Xml.Attribute("time", Xml.NumberRequired) declare readonly time: number
    @Xml.Attribute("duration", Xml.NumberOptional) declare readonly duration?: number
    @Xml.Attribute("contentTimeUnit", Xml.Enum(TimeUnit, false)) declare readonly contentTimeUnit?: TimeUnit
    @Xml.Attribute("playStart", Xml.NumberOptional) declare readonly playStart?: number
    @Xml.Attribute("playStop", Xml.NumberOptional) declare readonly playStop?: number
    @Xml.Attribute("loopStart", Xml.NumberOptional) declare readonly loopStart?: number
    @Xml.Attribute("loopEnd", Xml.NumberOptional) declare readonly loopEnd?: number
    @Xml.Attribute("fadeTimeUnit", Xml.Enum(TimeUnit, false)) declare readonly fadeTimeUnit?: TimeUnit
    @Xml.Attribute("fadeInTime", Xml.NumberOptional) declare readonly fadeInTime?: number
    @Xml.Attribute("fadeOutTime", Xml.NumberOptional) declare readonly fadeOutTime?: number
    @Xml.Attribute("enable", Xml.BoolOptional) declare readonly enable?: boolean
    @Xml.Attribute("reference", Xml.StringOptional) declare readonly reference?: string
    @Xml.Child(() => [TimelineSchema, LanesSchema, NotesSchema, ClipsSchema, ClipSlotSchema, MarkersSchema, WarpsSchema, AudioSchema, VideoSchema, PointsSchema]) declare readonly content?: TimelineSchema
}

@Xml.Class("Clips")
export class ClipsSchema extends TimelineSchema {
    @Xml.Children(() => ClipSchema) declare readonly clips: ReadonlyArray<ClipSchema>
}

@Xml.Class("ClipSlot")
export class ClipSlotSchema extends TimelineSchema {
    @Xml.Attribute("hasStop", Xml.BoolOptional) declare readonly hasStop?: boolean
    @Xml.Child(() => ClipSchema) declare readonly clip?: ClipSchema
}

@Xml.Class("Marker")
export class MarkerSchema extends NameableSchema {
    @Xml.Attribute("time", Xml.NumberRequired) declare readonly time: number
}

@Xml.Class("markers")
export class MarkersSchema extends TimelineSchema {
    @Xml.Children(() => MarkerSchema, {required: true}) declare readonly markers: ReadonlyArray<MarkerSchema>
}

@Xml.Class("Warps")
export class WarpsSchema extends TimelineSchema {
    @Xml.Attribute("contentTimeUnit", Xml.Enum(TimeUnit, true)) declare readonly contentTimeUnit: TimeUnit
    @Xml.Child(() => [TimelineSchema, LanesSchema, NotesSchema, ClipsSchema, ClipSlotSchema, MarkersSchema, WarpsSchema, AudioSchema, VideoSchema, PointsSchema], {required: true}) declare readonly content: TimelineSchema
    @Xml.Children(() => WarpSchema, {required: true}) declare readonly warps: ReadonlyArray<WarpSchema>
}

@Xml.Class("Warp")
export class WarpSchema {
    @Xml.Attribute("time", Xml.NumberRequired) declare readonly time: number
    @Xml.Attribute("contentTime", Xml.NumberRequired) declare readonly contentTime: number
}

export class MediaFileSchema extends TimelineSchema {
    @Xml.Attribute("duration", Xml.NumberRequired) declare readonly duration: number
    @Xml.Child(() => FileReferenceSchema, {name: "File", required: true}) declare readonly file: FileReferenceSchema
}

@Xml.Class("Audio")
export class AudioSchema extends MediaFileSchema {
    @Xml.Attribute("algorithm", Xml.StringOptional) declare readonly algorithm?: string
    @Xml.Attribute("channels", Xml.IntRequired) declare readonly channels: int
    @Xml.Attribute("sampleRate", Xml.IntRequired) declare readonly sampleRate: int
}

@Xml.Class("Video")
export class VideoSchema extends MediaFileSchema {
    @Xml.Attribute("algorithm", Xml.StringOptional) declare readonly algorithm?: string
    @Xml.Attribute("channels", Xml.IntRequired) declare readonly channels: int
    @Xml.Attribute("sampleRate", Xml.IntRequired) declare readonly sampleRate: int
}

@Xml.Class("Point")
export abstract class PointSchema {
    @Xml.Attribute("time", DawCodecs.DoubleRequired) declare readonly time: number
}

@Xml.Class("RealPoint")
export class RealPointSchema extends PointSchema {
    @Xml.Attribute("value", DawCodecs.DoubleRequired) declare readonly value: number
    @Xml.Attribute("interpolation", Xml.Enum(Interpolation, false)) declare readonly interpolation?: Interpolation
}

@Xml.Class("EnumPoint")
export class EnumPointSchema extends PointSchema {
    @Xml.Attribute("value", Xml.IntRequired) declare readonly value: int
}

@Xml.Class("BoolPoint")
export class BoolPointSchema extends PointSchema {
    @Xml.Attribute("value", Xml.BoolRequired) declare readonly value: boolean
}

@Xml.Class("IntegerPoint")
export class IntegerPointSchema extends PointSchema {
    @Xml.Attribute("value", Xml.IntRequired) declare readonly value: int
}

@Xml.Class("TimeSignaturePoint")
export class TimeSignaturePointSchema extends PointSchema {
    @Xml.Attribute("numerator", Xml.IntRequired) declare readonly numerator: int
    @Xml.Attribute("denominator", Xml.IntRequired) declare readonly denominator: int
}

@Xml.Class("Points")
export class PointsSchema extends TimelineSchema {
    @Xml.Attribute("unit", Xml.Enum(Unit, false)) declare readonly unit?: Unit
    @Xml.Child(() => AutomationTargetSchema, {name: "Target", required: true}) declare readonly target: AutomationTargetSchema
    @Xml.Children(() => [PointSchema, RealPointSchema, EnumPointSchema, BoolPointSchema, IntegerPointSchema, TimeSignaturePointSchema]) declare readonly points: ReadonlyArray<PointSchema>
}

export class AutomationTargetSchema {
    @Xml.Attribute("parameter", Xml.StringOptional) declare readonly parameter?: string
    @Xml.Attribute("expression", Xml.Enum(ExpressionType, false)) declare readonly expression?: ExpressionType
    @Xml.Attribute("channel", Xml.IntOptional) declare readonly channel?: int
    @Xml.Attribute("key", Xml.IntOptional) declare readonly key?: int
    @Xml.Attribute("controller", Xml.IntOptional) declare readonly controller?: int
}

@Xml.Class("Scene")
export class SceneSchema extends ReferenceableSchema {
    @Xml.Child(() => [TimelineSchema, LanesSchema, NotesSchema, ClipsSchema, ClipSlotSchema, MarkersSchema, WarpsSchema, AudioSchema, VideoSchema, PointsSchema], {required: true}) declare readonly content: TimelineSchema
}

@Xml.Class("MetaData")
export class MetaDataSchema {
    @Xml.Text("Title") declare readonly title?: string
    @Xml.Text("Artist") declare readonly artist?: string
    @Xml.Text("Album") declare readonly album?: string
    @Xml.Text("OriginalArtist") declare readonly originalArtist?: string
    @Xml.Text("Composer") declare readonly composer?: string
    @Xml.Text("Songwriter") declare readonly songwriter?: string
    @Xml.Text("Producer") declare readonly producer?: string
    @Xml.Text("Arranger") declare readonly arranger?: string
    @Xml.Text("Year") declare readonly year?: string
    @Xml.Text("Genre") declare readonly genre?: string
    @Xml.Text("Copyright") declare readonly copyright?: string
    @Xml.Text("Website") declare readonly website?: string
    @Xml.Text("Comment") declare readonly comment?: string
}
