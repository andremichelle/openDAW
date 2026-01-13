import type {int} from "@moises-ai/lib-std"
import {Xml} from "@moises-ai/lib-xml"

export interface Nameable {
    name?: string
    color?: string
    comment?: string
}

export interface Referenceable extends Nameable {
    id?: string
}

// noinspection JSUnusedGlobalSymbols
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

// noinspection JSUnusedGlobalSymbols
export enum Interpolation {
    HOLD = "hold",
    LINEAR = "linear"
}

// noinspection JSUnusedGlobalSymbols
export enum TimeUnit {
    BEATS = "beats",
    SECONDS = "seconds"
}

// noinspection JSUnusedGlobalSymbols
export enum SendType {
    PRE = "pre",
    POST = "post"
}

// noinspection JSUnusedGlobalSymbols
export enum DeviceRole {
    NOTE_FX = "noteFX",
    INSTRUMENT = "instrument",
    AUDIO_FX = "audioFX"
}

// noinspection JSUnusedGlobalSymbols
export enum ChannelRole {
    REGULAR = "regular",
    MASTER = "master",
    EFFECT = "effect",
    SUBMIX = "submix",
    VCA = "vca"
}

// noinspection JSUnusedGlobalSymbols
export enum AudioAlgorithm {
    REPITCH = "repitch",
    STRETCH = "stretch"
}

@Xml.Class("MetaData")
export class MetaDataSchema {
    @Xml.Element("Title", String) readonly title?: string
    @Xml.Element("Artist", String) readonly artist?: string
    @Xml.Element("Album", String) readonly album?: string
    @Xml.Element("OriginalArtist", String) readonly originalArtist?: string
    @Xml.Element("Composer", String) readonly composer?: string
    @Xml.Element("Songwriter", String) readonly songwriter?: string
    @Xml.Element("Producer", String) readonly producer?: string
    @Xml.Element("Arranger", String) readonly arranger?: string
    @Xml.Element("Year", String) readonly year?: string
    @Xml.Element("Genre", String) readonly genre?: string
    @Xml.Element("Copyright", String) readonly copyright?: string
    @Xml.Element("Website", String) readonly website?: string
    @Xml.Element("Comment", String) readonly comment?: string
}

@Xml.Class("Application")
export class ApplicationSchema {
    @Xml.Attribute("name", Xml.StringRequired)
    readonly name!: string

    @Xml.Attribute("version", Xml.StringOptional)
    readonly version?: string
}

@Xml.Class("BooleanParameter")
export class BooleanParameterSchema implements Referenceable {
    @Xml.Attribute("value", Xml.BoolRequired)
    readonly value?: boolean

    @Xml.Attribute("id")
    readonly id?: string

    @Xml.Attribute("name")
    readonly name?: string
}

@Xml.Class("RealParameter")
export class RealParameterSchema implements Referenceable {
    @Xml.Attribute("id")
    readonly id!: string

    @Xml.Attribute("name")
    readonly name?: string

    @Xml.Attribute("value", Xml.NumberRequired)
    readonly value!: number

    @Xml.Attribute("unit", Xml.StringRequired)
    readonly unit!: Unit

    @Xml.Attribute("min", Xml.NumberOptional)
    readonly min?: number

    @Xml.Attribute("max", Xml.NumberOptional)
    readonly max?: number
}

@Xml.Class("TimeSignature")
export class TimeSignatureParameterSchema {
    @Xml.Attribute("numerator", Xml.NumberOptional)
    readonly numerator?: number

    @Xml.Attribute("denominator", Xml.NumberOptional)
    readonly denominator?: number
}

@Xml.Class("Parameter")
export class ParameterSchema implements Referenceable {
    @Xml.Attribute("id")
    readonly id?: string

    @Xml.Attribute("name")
    readonly name?: string

    @Xml.Attribute("value", Xml.NumberOptional)
    readonly value?: number

    @Xml.Attribute("unit")
    readonly unit?: Unit

    @Xml.Attribute("min", Xml.NumberOptional)
    readonly min?: number

    @Xml.Attribute("max", Xml.NumberOptional)
    readonly max?: number
}

@Xml.Class("State")
export class StateSchema {
    @Xml.Attribute("path")
    readonly path?: string
}

@Xml.Class("Send")
export class SendSchema {
    @Xml.Attribute("id")
    readonly id?: string

    @Xml.Attribute("destination")
    readonly destination?: string

    @Xml.Attribute("type")
    readonly type?: string

    @Xml.Element("Volume", RealParameterSchema)
    readonly volume!: RealParameterSchema

    @Xml.Element("Pan", RealParameterSchema)
    readonly pan?: RealParameterSchema

    @Xml.Element("Enable", BooleanParameterSchema)
    readonly enable?: BooleanParameterSchema
}

@Xml.Class("Transport")
export class TransportSchema {
    @Xml.Element("Tempo", RealParameterSchema)
    readonly tempo?: RealParameterSchema

    @Xml.Element("TimeSignature", TimeSignatureParameterSchema)
    readonly timeSignature?: TimeSignatureParameterSchema
}

@Xml.Class("Lane")
export class LaneSchema implements Referenceable {
    @Xml.Attribute("id")
    readonly id?: string
}

@Xml.Class("Timeline")
export class TimelineSchema implements Referenceable {
    @Xml.Attribute("id")
    readonly id?: string

    @Xml.Attribute("timeUnit")
    readonly timeUnit?: string

    @Xml.Attribute("track")
    readonly track?: string
}

@Xml.Class("Note")
export class NoteSchema {
    @Xml.Attribute("time", Xml.NumberRequired)
    readonly time!: number

    @Xml.Attribute("duration", Xml.NumberRequired)
    readonly duration!: number

    @Xml.Attribute("channel", Xml.NumberRequired)
    readonly channel!: int

    @Xml.Attribute("key", Xml.NumberRequired)
    readonly key!: int

    @Xml.Attribute("vel", Xml.NumberOptional)
    readonly vel?: number

    @Xml.Attribute("rel", Xml.NumberOptional)
    readonly rel?: number
}

@Xml.Class("Notes")
export class NotesSchema extends TimelineSchema {
    @Xml.ElementRef(NoteSchema, "Note")
    readonly notes!: ReadonlyArray<NoteSchema>
}

@Xml.Class("Clip")
export class ClipSchema implements Nameable {
    @Xml.Attribute("name")
    readonly name?: string

    @Xml.Attribute("color")
    readonly color?: string

    @Xml.Attribute("comment")
    readonly comment?: string

    @Xml.Attribute("time", Xml.NumberOptional)
    readonly time?: number

    @Xml.Attribute("duration", Xml.NumberOptional)
    readonly duration?: number

    @Xml.Attribute("contentTimeUnit")
    readonly contentTimeUnit?: string

    @Xml.Attribute("playStart", Xml.NumberOptional)
    readonly playStart?: number

    @Xml.Attribute("playStop", Xml.NumberOptional)
    readonly playStop?: number

    @Xml.Attribute("loopStart", Xml.NumberOptional)
    readonly loopStart?: number

    @Xml.Attribute("loopEnd", Xml.NumberOptional)
    readonly loopEnd?: number

    @Xml.Attribute("fadeTimeUnit")
    readonly fadeTimeUnit?: string

    @Xml.Attribute("fadeInTime", Xml.NumberOptional)
    readonly fadeInTime?: number

    @Xml.Attribute("fadeOutTime", Xml.NumberOptional)
    readonly fadeOutTime?: number

    @Xml.Attribute("enable", Xml.BoolOptional)
    readonly enable?: boolean

    @Xml.ElementRef(TimelineSchema)
    readonly content?: ReadonlyArray<TimelineSchema>

    @Xml.Attribute("reference")
    readonly reference?: string
}

@Xml.Class("Clips")
export class ClipsSchema extends TimelineSchema {
    @Xml.ElementRef(ClipSchema)
    readonly clips!: ReadonlyArray<ClipSchema>
}

@Xml.Class("ClipSlot")
export class ClipSlotSchema extends TimelineSchema {
    @Xml.Element("Clip", ClipSchema)
    readonly clip?: ClipSchema

    @Xml.Attribute("hasStop", Xml.BoolOptional)
    readonly hasStop?: boolean
}

@Xml.Class("Marker")
export class MarkerSchema implements Referenceable {
    @Xml.Attribute("id")
    readonly id?: string

    @Xml.Attribute("name")
    readonly name?: string

    @Xml.Attribute("color")
    readonly color?: string

    @Xml.Attribute("comment")
    readonly comment?: string

    @Xml.Attribute("time", Xml.NumberRequired)
    readonly time!: number
}

@Xml.Class("Markers")
export class MarkersSchema {
    @Xml.Element("Marker", Array)
    readonly marker!: ReadonlyArray<MarkerSchema>
}

@Xml.Class("Warp")
export class WarpSchema {
    @Xml.Attribute("time", Xml.NumberRequired)
    readonly time!: number

    @Xml.Attribute("contentTime", Xml.NumberRequired)
    readonly contentTime!: number
}

@Xml.Class("File")
export class FileReferenceSchema {
    @Xml.Attribute("path", Xml.StringRequired)
    readonly path!: string

    @Xml.Attribute("external", Xml.BoolOptional)
    readonly external?: boolean
}

@Xml.Class("MediaFile")
export class MediaFileSchema extends TimelineSchema {
    @Xml.Element("File", FileReferenceSchema)
    readonly file!: FileReferenceSchema

    @Xml.Attribute("duration", Xml.NumberRequired)
    readonly duration!: number
}

@Xml.Class("Audio")
export class AudioSchema extends MediaFileSchema {
    @Xml.Attribute("algorithm")
    readonly algorithm?: string

    @Xml.Attribute("channels", Xml.NumberRequired)
    readonly channels!: int

    @Xml.Attribute("sampleRate", Xml.NumberRequired)
    readonly sampleRate!: int
}

@Xml.Class("Warps")
export class WarpsSchema extends TimelineSchema {
    @Xml.ElementRef(TimelineSchema)
    readonly content?: ReadonlyArray<TimelineSchema>

    @Xml.ElementRef(WarpSchema)
    readonly warps!: ReadonlyArray<WarpSchema>

    @Xml.Attribute("contentTimeUnit")
    readonly contentTimeUnit!: string
}

@Xml.Class("Video")
export class VideoSchema extends MediaFileSchema {
    @Xml.Attribute("algorithm")
    readonly algorithm?: string

    @Xml.Attribute("channels", Xml.NumberRequired)
    readonly channels!: int

    @Xml.Attribute("sampleRate", Xml.NumberRequired)
    readonly sampleRate!: int
}

@Xml.Class("Target")
export class AutomationTargetSchema {
    @Xml.Attribute("parameter")
    readonly parameter?: string

    @Xml.Attribute("expression")
    readonly expression?: string

    @Xml.Attribute("channel", Xml.NumberOptional)
    readonly channel?: int

    @Xml.Attribute("key", Xml.NumberOptional)
    readonly key?: int

    @Xml.Attribute("controller", Xml.NumberOptional)
    readonly controller?: int
}

@Xml.Class("Point")
export class PointSchema {
    @Xml.Attribute("time")
    readonly time!: number
}

@Xml.Class("BoolPoint")
export class BoolPoint extends PointSchema {
    @Xml.Attribute("value", Xml.BoolOptional)
    readonly value!: boolean
}

@Xml.Class("RealPoint")
export class RealPointSchema extends PointSchema {
    @Xml.Attribute("value", Xml.NumberRequired)
    readonly value!: number

    @Xml.Attribute("interpolation")
    readonly interpolation?: Interpolation
}

@Xml.Class("IntegerPoint")
export class IntegerPointSchema extends PointSchema {
    @Xml.Attribute("value", Xml.NumberRequired)
    readonly value!: int
}

@Xml.Class("TimeSignaturePoint")
export class TimeSignaturePointSchema extends PointSchema {
    @Xml.Attribute("numerator", Xml.NumberRequired)
    readonly numerator!: int

    @Xml.Attribute("denominator", Xml.NumberRequired)
    readonly denominator!: int
}

@Xml.Class("Points")
export class PointsSchema extends TimelineSchema {
    @Xml.Element("Target", AutomationTargetSchema)
    readonly target?: AutomationTargetSchema

    @Xml.ElementRef(PointSchema)
    readonly points?: ReadonlyArray<PointSchema>

    @Xml.Attribute("unit")
    readonly unit?: Unit
}

@Xml.Class("Lanes")
export class LanesSchema extends TimelineSchema {
    @Xml.ElementRef(TimelineSchema)
    readonly lanes?: ReadonlyArray<TimelineSchema>
}

@Xml.Class("Arrangement")
export class ArrangementSchema implements Referenceable {
    @Xml.Attribute("id")
    readonly id?: string

    @Xml.Element("TimeSignatureAutomation", PointsSchema)
    readonly timeSignatureAutomation?: PointsSchema

    @Xml.Element("TempoAutomation", PointsSchema)
    readonly tempoAutomation?: PointsSchema

    @Xml.Element("Markers", MarkersSchema)
    readonly markers?: MarkerSchema

    @Xml.Element("Lanes", LanesSchema)
    readonly lanes?: LanesSchema
}

@Xml.Class("Scene")
export class SceneSchema implements Referenceable {
    @Xml.Attribute("id")
    readonly id?: string

    @Xml.ElementRef(TimelineSchema)
    readonly content?: ReadonlyArray<TimelineSchema>
}

@Xml.Class("Device")
export class DeviceSchema implements Referenceable {
    @Xml.Attribute("id")
    readonly id?: string

    @Xml.Element("Enabled", BooleanParameterSchema)
    readonly enabled?: BooleanParameterSchema

    @Xml.Attribute("deviceRole", Xml.StringRequired)
    readonly deviceRole!: string

    @Xml.Attribute("loaded", Xml.BoolOptional)
    readonly loaded?: boolean

    @Xml.Attribute("deviceName")
    readonly deviceName?: string

    @Xml.Attribute("deviceID")
    readonly deviceID?: string

    @Xml.Attribute("deviceVendor")
    readonly deviceVendor?: string

    @Xml.Element("State", FileReferenceSchema)
    readonly state?: FileReferenceSchema

    @Xml.Attribute("name")
    readonly name?: string

    @Xml.ElementRef(ParameterSchema, "Parameters")
    readonly automatedParameters?: ReadonlyArray<ParameterSchema>
}

@Xml.Class("BuiltinDevice")
export class BuiltinDeviceSchema extends DeviceSchema {}

// noinspection JSUnusedGlobalSymbols
export enum EqBandType {
    HIGH_PASS = "highPass",
    LOW_PASS = "lowPass",
    BAND_PASS = "bandPass",
    HIGH_SHELF = "highShelf",
    LOW_SHELF = "lowShelf",
    BELL = "bell",
    NOTCH = "notch"
}

@Xml.Class("Band")
export class BandSchema {
    @Xml.Attribute("type", Xml.StringRequired)
    readonly type!: EqBandType

    @Xml.Attribute("order", Xml.NumberOptional)
    readonly order?: int

    @Xml.Element("Freq", RealParameterSchema)
    readonly freq!: RealParameterSchema

    @Xml.Element("Gain", RealParameterSchema)
    readonly gain?: RealParameterSchema

    @Xml.Element("Q", RealParameterSchema)
    readonly Q?: RealParameterSchema

    @Xml.Element("Enabled", BooleanParameterSchema)
    readonly enabled?: BooleanParameterSchema
}

@Xml.Class("Equalizer")
export class EqualizerSchema extends BuiltinDeviceSchema {
    @Xml.ElementRef(BandSchema)
    readonly bands!: ReadonlyArray<BandSchema>
}

@Xml.Class("Plugin")
export class PluginSchema extends DeviceSchema {
    @Xml.Attribute("pluginVersion")
    readonly pluginVersion?: string
}

@Xml.Class("Channel")
export class ChannelSchema implements Referenceable {
    @Xml.Attribute("id")
    readonly id?: string

    @Xml.Attribute("role")
    readonly role?: ChannelRole

    @Xml.Attribute("audioChannels", Xml.NumberOptional)
    readonly audioChannels?: int

    @Xml.Attribute("destination")
    readonly destination?: string

    @Xml.Attribute("solo", Xml.BoolOptional)
    readonly solo?: boolean

    @Xml.ElementRef(DeviceSchema, "Devices")
    readonly devices?: ReadonlyArray<DeviceSchema>

    @Xml.Element("Volume", RealParameterSchema)
    readonly volume?: RealParameterSchema

    @Xml.Element("Pan", RealParameterSchema)
    readonly pan?: RealParameterSchema

    @Xml.Element("Mute", BooleanParameterSchema)
    readonly mute?: BooleanParameterSchema

    @Xml.ElementRef(SendSchema, "Sends")
    readonly sends?: SendSchema[]
}

@Xml.Class("Track")
export class TrackSchema extends LaneSchema {
    @Xml.Attribute("contentType")
    readonly contentType?: string

    @Xml.Attribute("name")
    readonly name?: string

    @Xml.Attribute("color")
    readonly color?: string

    @Xml.Attribute("loaded", Xml.BoolOptional)
    readonly loaded?: boolean

    @Xml.Element("Channel", ChannelSchema)
    readonly channel?: ChannelSchema

    @Xml.ElementRef(TrackSchema)
    readonly tracks?: ReadonlyArray<TrackSchema>
}

@Xml.Class("ClapPlugin")
export class ClapPluginSchema extends PluginSchema {}

@Xml.Class("Project")
export class ProjectSchema {
    @Xml.Attribute("version", Xml.StringRequired)
    readonly version!: "1.0"

    @Xml.Element("Application", ApplicationSchema)
    readonly application!: ApplicationSchema

    @Xml.Element("Transport", TransportSchema)
    readonly transport?: TransportSchema

    @Xml.ElementRef(LaneSchema, "Structure")
    readonly structure!: ReadonlyArray<LaneSchema>

    @Xml.Element("Arrangement", ArrangementSchema)
    readonly arrangement?: ArrangementSchema

    @Xml.ElementRef(SceneSchema, "Scenes")
    readonly scenes?: ReadonlyArray<SceneSchema>
}