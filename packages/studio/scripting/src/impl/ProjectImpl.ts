import {AudioUnitBox, GrooveShuffleBox, ProjectMetaBox} from "@opendaw/studio-boxes"
import {ppqn} from "@opendaw/lib-dsp"
import {AudioUnitType, Colors, IconSymbol} from "@opendaw/studio-enums"
import {ProjectSkeleton, Validator} from "@opendaw/studio-adapters"
import {asInstanceOf, clamp, float, isDefined, isNull, Nullable, panic, tryCatch, UUID} from "@opendaw/lib-std"
import {
    AnyAudioUnit,
    AnyModulator,
    AudioUnitProps,
    AuxAudioUnit,
    BusAudioUnitProps,
    DeepPartial,
    GrooveShuffle,
    GroupAudioUnit,
    InstrumentAudioUnit,
    Instruments,
    LoopArea,
    Marker,
    MarkerProps,
    Modulators,
    OutputAudioUnit,
    Project,
    ProjectMeta,
    SignatureTrack,
    TempoTrack,
    TimeSignature
} from "../Api"
import {Context} from "./Context"
import {Props} from "./Common"
import {Fields} from "./Fields"
import {Guard} from "./Guard"
import {AudioUnitImpls, AuxAudioUnitImpl, GroupAudioUnitImpl, InstrumentAudioUnitImpl} from "./AudioUnits"
import {GrooveShuffleImpl} from "./GrooveShuffleImpl"
import {MarkerImpl, Markers} from "./timeline/Markers"
import {TempoTrackImpl} from "./timeline/TempoTrackImpl"
import {SignatureTrackImpl} from "./timeline/SignatureTrackImpl"
import {ModulatorImpls} from "./Modulators"
import {Regions} from "./timeline/Regions"
import {ScriptHostProtocol} from "../ScriptHostProtocol"

class TimeSignatureImpl implements TimeSignature {
    readonly #context: Context

    constructor(context: Context) {this.#context = context}

    get numerator(): number {return this.#context.skeleton.mandatoryBoxes.timelineBox.signature.nominator.getValue()}
    set numerator(value: number) {this.#write(value, this.denominator)}
    get denominator(): number {return this.#context.skeleton.mandatoryBoxes.timelineBox.signature.denominator.getValue()}
    set denominator(value: number) {this.#write(this.numerator, value)}

    #write(numerator: unknown, denominator: unknown): void {
        const [validNumerator, validDenominator] = Validator.isTimeSignatureValid(
            Guard.integer(numerator, "timeSignature.numerator"), Guard.integer(denominator, "timeSignature.denominator"))
            .result()
        this.#context.edit(() => {
            const {signature} = this.#context.skeleton.mandatoryBoxes.timelineBox
            signature.nominator.setValue(validNumerator)
            signature.denominator.setValue(validDenominator)
        })
    }
}

class ProjectMetaImpl implements ProjectMeta {
    readonly #context: Context

    constructor(context: Context) {this.#context = context}

    get artist(): string {return this.#read(box => box.artist.getValue())}
    set artist(value: string) {this.#write(box => box.artist.setValue(Guard.string(value, "meta.artist")))}
    get description(): string {return this.#read(box => box.description.getValue())}
    set description(value: string) {this.#write(box => box.description.setValue(Guard.string(value, "meta.description")))}
    get notepad(): string {return this.#read(box => box.notepad.getValue())}
    set notepad(value: string) {this.#write(box => box.notepad.setValue(Guard.string(value, "meta.notepad")))}
    get tags(): ReadonlyArray<string> {
        const parsed = tryCatch(() => JSON.parse(this.#read(box => box.tagList.getValue(), "[]")))
        return parsed.status === "success" && Array.isArray(parsed.value)
            ? parsed.value.filter(entry => typeof entry === "string") : []
    }
    set tags(value: ReadonlyArray<string>) {
        if (!Array.isArray(value)) {panic(new TypeError("meta.tags: expected an array of strings"))}
        const tags = value.map((tag, index) => Guard.string(tag, `meta.tags.${index}`))
        this.#write(box => box.tagList.setValue(JSON.stringify(tags)))
    }

    #box(): Nullable<ProjectMetaBox> {
        const {rootBox} = this.#context.skeleton.mandatoryBoxes
        return rootBox.projectMeta.targetVertex.mapOr(vertex => asInstanceOf(vertex.box, ProjectMetaBox), null)
    }

    #read(reader: (box: ProjectMetaBox) => string, fallback: string = ""): string {
        const box = this.#box()
        return isDefined(box) ? reader(box) : fallback
    }

    #write(writer: (box: ProjectMetaBox) => void): void {
        this.#context.edit(() => {
            const {rootBox} = this.#context.skeleton.mandatoryBoxes
            const box = this.#box() ?? ProjectMetaBox.create(this.#context.boxGraph, UUID.generate(), box => {
                box.created.setValue(new Date().toISOString())
                rootBox.projectMeta.refer(box)
            })
            writer(box)
            box.modified.setValue(new Date().toISOString())
        })
    }
}

export class ProjectImpl implements Project {
    readonly #context: Context
    readonly #protocol: ScriptHostProtocol
    readonly #timeSignature: TimeSignatureImpl
    readonly #meta: ProjectMetaImpl
    readonly #tempoTrack: TempoTrackImpl
    readonly #signatureTrack: SignatureTrackImpl
    #name: string

    declare bpm: number
    declare baseFrequency: float
    declare duration: ppqn
    declare readonly loop: LoopArea

    constructor(protocol: ScriptHostProtocol, skeleton: ProjectSkeleton, name: string) {
        this.#context = new Context(skeleton)
        this.#protocol = protocol
        this.#name = name
        this.#timeSignature = new TimeSignatureImpl(this.#context)
        this.#meta = new ProjectMetaImpl(this.#context)
        const {timelineBox, rootBox} = skeleton.mandatoryBoxes
        this.#tempoTrack = new TempoTrackImpl(this.#context, timelineBox)
        this.#signatureTrack = new SignatureTrackImpl(this.#context, timelineBox)
        Fields.bind(this.#context, this, {
            bpm: timelineBox.bpm,
            baseFrequency: rootBox.baseFrequency,
            duration: timelineBox.durationInPulses,
            loop: {enabled: timelineBox.loopArea.enabled, from: timelineBox.loopArea.from, to: timelineBox.loopArea.to}
        })
    }

    get context(): Context {return this.#context}

    get name(): string {return this.#name}
    set name(value: string) {this.#name = Guard.string(value, "name")}

    get timeSignature(): TimeSignature {return this.#timeSignature}
    set timeSignature(value: TimeSignature) {
        if (typeof value !== "object" || isNull(value)) {panic(new TypeError("timeSignature: expected {numerator, denominator}"))}
        const numerator = Guard.integer(value.numerator, "timeSignature.numerator")
        const denominator = Guard.integer(value.denominator, "timeSignature.denominator")
        const [validNumerator, validDenominator] = Validator.isTimeSignatureValid(numerator, denominator).result()
        this.#context.edit(() => {
            const {signature} = this.#context.skeleton.mandatoryBoxes.timelineBox
            signature.nominator.setValue(validNumerator)
            signature.denominator.setValue(validDenominator)
        })
    }

    get meta(): ProjectMeta {return this.#meta}

    get groove(): GrooveShuffle {
        const {rootBox} = this.#context.skeleton.mandatoryBoxes
        return GrooveShuffleImpl.wrap(this.#context, asInstanceOf(rootBox.groove.targetVertex.unwrap("project has no groove").box, GrooveShuffleBox))
    }

    get output(): OutputAudioUnit {
        return AudioUnitImpls.wrap(this.#context, this.#context.skeleton.mandatoryBoxes.primaryAudioUnitBox) as OutputAudioUnit
    }

    get audioUnits(): ReadonlyArray<AnyAudioUnit> {return AudioUnitImpls.list(this.#context)}
    get instrumentUnits(): ReadonlyArray<InstrumentAudioUnit> {
        return this.audioUnits.filter((unit): unit is InstrumentAudioUnitImpl => unit instanceof InstrumentAudioUnitImpl)
    }
    get auxUnits(): ReadonlyArray<AuxAudioUnit> {
        return this.audioUnits.filter((unit): unit is AuxAudioUnitImpl => unit instanceof AuxAudioUnitImpl)
    }
    get groupUnits(): ReadonlyArray<GroupAudioUnit> {
        return this.audioUnits.filter((unit): unit is GroupAudioUnitImpl => unit instanceof GroupAudioUnitImpl)
    }

    findAudioUnit(label: string): Nullable<AnyAudioUnit> {
        const name = Guard.string(label, "label")
        return this.audioUnits.find(unit => unit.label === name) ?? null
    }

    addInstrumentUnit<K extends keyof Instruments>(key: K, props?: AudioUnitProps, instrument?: DeepPartial<Instruments[K]>): InstrumentAudioUnit<K> {
        return this.#context.edit(() => {
            const unit = AudioUnitImpls.createInstrumentUnit(this.#context, key, props?.label)
            const rest = Props.without(props, "label")
            Props.apply(unit, rest)
            Props.apply(unit.instrument, instrument, "instrument")
            return unit as unknown as InstrumentAudioUnit<K>
        })
    }

    addAuxUnit(props?: BusAudioUnitProps): AuxAudioUnit {
        return this.#context.edit(() => {
            const unit = AudioUnitImpls.createBusUnit(this.#context, AudioUnitType.Aux, props?.label, IconSymbol.Effects, Colors.purple.toString())
            const rest = Props.without(props, "label")
            return Props.apply(unit, rest) as AuxAudioUnit
        })
    }

    addGroupUnit(props?: BusAudioUnitProps): GroupAudioUnit {
        return this.#context.edit(() => {
            const unit = AudioUnitImpls.createBusUnit(this.#context, AudioUnitType.Bus, props?.label, IconSymbol.AudioBus, Colors.orange.toString())
            const rest = Props.without(props, "label")
            return Props.apply(unit, rest) as GroupAudioUnit
        })
    }

    get markers(): ReadonlyArray<Marker> {
        return Markers.list(this.#context, this.#context.skeleton.mandatoryBoxes.timelineBox.markerTrack)
    }

    addMarker(props?: MarkerProps): Marker {
        return Markers.create(this.#context, this.#context.skeleton.mandatoryBoxes.timelineBox.markerTrack, props)
    }

    get tempoTrack(): TempoTrack {return this.#tempoTrack}
    get signatureTrack(): SignatureTrack {return this.#signatureTrack}

    get modulators(): ReadonlyArray<AnyModulator> {return ModulatorImpls.list(this.#context)}

    addModulator<K extends keyof Modulators>(kind: K, props?: DeepPartial<Modulators[K]>): Modulators[K] {
        return ModulatorImpls.create(this.#context, kind, props)
    }

    validate(): void {
        const {boxGraph, mandatoryBoxes: {rootBox}} = this.#context.skeleton
        boxGraph.verifyPointers()
        const overlaps: Array<string> = []
        Regions.forEachRegion(this.#context, region => {
            const siblings = Regions.list(this.#context, region.trackBox)
            const next = siblings[siblings.indexOf(region) + 1]
            if (isDefined(next) && region.complete > next.position
                && region.box.name !== "AudioRegionBox" && next.box.name !== "AudioRegionBox") {
                overlaps.push(`'${region.label}' [${region.position}, ${region.complete}] and '${next.label}' [${next.position}, ${next.complete}]`)
            }
        })
        if (Validator.hasOverlappingRegions(boxGraph)) {
            return panic(new RangeError(`Project contains overlapping regions: ${overlaps.join("; ")}`))
        }
        const orphans = boxGraph.findOrphans(rootBox)
        if (orphans.length > 0) {
            console.warn(`Project contains ${orphans.length} orphan box(es):`, orphans.map(box => box.name).join(", "))
        }
    }

    openInStudio(): void {
        this.validate()
        const {boxGraph, mandatoryBoxes: {rootBox, userInterfaceBoxes}} = this.#context.skeleton
        const defaultUser = userInterfaceBoxes.at(0)
        if (isDefined(defaultUser) && defaultUser.editingDeviceChain.isEmpty()) {
            const first = rootBox.audioUnits.pointerHub.incoming()
                .map(({box}) => asInstanceOf(box, AudioUnitBox))
                .sort((a, b) => a.index.getValue() - b.index.getValue())
                .at(0)
            if (isDefined(first)) {this.#context.edit(() => defaultUser.editingDeviceChain.refer(first.editing))}
        }
        const origin = this.#context.origin
        if (isNull(origin)) {
            this.#protocol.openProject(boxGraph.toArrayBuffer(), this.#name)
        } else {
            this.#protocol.applyUpdates(this.#context.takeUpdates(), origin)
        }
    }

    static clampBpm(value: number): number {return clamp(value, 30, 1000)}
}
