import {
    Arrays,
    Func,
    panic,
    Procedure,
    safeExecute,
    Terminable,
    TerminableOwner,
    Terminator,
    UUID
} from "@opendaw/lib-std"
import {BoxEditing, BoxGraph} from "@opendaw/lib-box"
import {
    AudioBusBox,
    AudioFileBox,
    AudioRegionBox,
    AudioUnitBox,
    BoxIO,
    BoxVisitor,
    RootBox,
    TimelineBox,
    TrackBox,
    UserInterfaceBox
} from "@opendaw/studio-boxes"
import {
    BoxAdapters,
    BoxAdaptersContext,
    ClipSequencing,
    ParameterFieldAdapters,
    ProcessorOptions,
    ProjectMandatoryBoxes,
    ProjectSkeleton,
    RootBoxAdapter,
    SampleLoaderManager,
    SoundfontLoaderManager,
    TimelineBoxAdapter,
    UnionBoxTypes,
    UserEditingManager,
    VertexSelection
} from "@opendaw/studio-adapters"
import {LiveStreamBroadcaster, LiveStreamReceiver} from "@opendaw/lib-fusion"
import {ProjectEnv} from "./ProjectEnv"
import {Mixer} from "../Mixer"
import {ProjectApi} from "./ProjectApi"
import {ProjectMigration} from "./ProjectMigration"
import {CaptureDevices, Recording} from "../capture"
import {EngineFacade} from "../EngineFacade"
import {EngineWorklet} from "../EngineWorklet"
import {MidiDevices, MIDILearning} from "../midi"
import {ProjectValidation} from "./ProjectValidation"
import {Preferences} from "../Preferences"
import {ConstantTempoMap, PPQN, ppqn, TempoMap, TimeBase} from "@opendaw/lib-dsp"
import {MidiData} from "@opendaw/lib-midi"

export type RestartWorklet = { unload: Func<unknown, Promise<unknown>>, load: Procedure<EngineWorklet> }

export type ProjectCreateOptions = {
    noDefaultUser?: boolean
}

// Main Entry Point for a Project
export class Project implements BoxAdaptersContext, Terminable, TerminableOwner {
    static new(env: ProjectEnv, options?: ProjectCreateOptions): Project {
        const createDefaultUser = options?.noDefaultUser !== true
        const createOutputCompressor = Preferences.values["auto-create-output-compressor"]
        const {boxGraph, mandatoryBoxes} = ProjectSkeleton.empty({
            createOutputCompressor,
            createDefaultUser
        })
        const project = new Project(env, boxGraph, mandatoryBoxes)
        if (createDefaultUser) {project.follow(mandatoryBoxes.userInterfaceBoxes[0])}
        return project
    }

    static load(env: ProjectEnv, arrayBuffer: ArrayBuffer): Project {
        return this.fromSkeleton(env, ProjectSkeleton.decode(arrayBuffer))
    }

    static async loadAnyVersion(env: ProjectEnv, arrayBuffer: ArrayBuffer): Promise<Project> {
        console.debug("loadAnyVersion")
        const skeleton = ProjectSkeleton.decode(arrayBuffer)
        await ProjectMigration.migrate(env, skeleton)
        return this.fromSkeleton(env, skeleton)
    }

    static fromSkeleton(env: ProjectEnv, skeleton: ProjectSkeleton, followFirstUser: boolean = true): Project {
        ProjectValidation.validate(skeleton)
        const project = new Project(env, skeleton.boxGraph, skeleton.mandatoryBoxes)
        if (followFirstUser) {project.follow(project.userInterfaceBoxes[0])}
        return project
    }

    readonly #terminator = new Terminator()

    readonly #env: ProjectEnv
    readonly boxGraph: BoxGraph<BoxIO.TypeMap>

    readonly rootBox: RootBox
    readonly userInterfaceBoxes: ReadonlyArray<UserInterfaceBox>
    readonly masterBusBox: AudioBusBox
    readonly masterAudioUnit: AudioUnitBox
    readonly timelineBox: TimelineBox

    readonly api: ProjectApi
    readonly captureDevices: CaptureDevices
    readonly editing: BoxEditing
    readonly selection: VertexSelection
    readonly boxAdapters: BoxAdapters
    readonly userEditingManager: UserEditingManager
    readonly parameterFieldAdapters: ParameterFieldAdapters
    readonly liveStreamReceiver: LiveStreamReceiver
    readonly midiLearning: MIDILearning
    readonly mixer: Mixer
    readonly tempoMap: TempoMap
    readonly engine = new EngineFacade()

    private constructor(env: ProjectEnv, boxGraph: BoxGraph, {
        rootBox,
        userInterfaceBoxes,
        primaryAudioBus,
        primaryAudioOutputUnit,
        timelineBox
    }: ProjectMandatoryBoxes) {
        this.#env = env
        this.boxGraph = boxGraph
        this.rootBox = rootBox
        this.userInterfaceBoxes = userInterfaceBoxes
        this.masterBusBox = primaryAudioBus
        this.masterAudioUnit = primaryAudioOutputUnit
        this.timelineBox = timelineBox

        this.api = new ProjectApi(this)
        this.editing = new BoxEditing(this.boxGraph)
        this.selection = new VertexSelection(this.editing, this.boxGraph)
        this.parameterFieldAdapters = new ParameterFieldAdapters()
        this.tempoMap = new ConstantTempoMap(this.timelineBox.bpm)
        this.boxAdapters = this.#terminator.own(new BoxAdapters(this))
        this.userEditingManager = new UserEditingManager(this.editing)
        this.liveStreamReceiver = this.#terminator.own(new LiveStreamReceiver())
        this.midiLearning = this.#terminator.own(new MIDILearning(this))
        this.captureDevices = this.#terminator.own(new CaptureDevices(this))
        this.mixer = new Mixer(this.rootBoxAdapter.audioUnits)

        // TODO We are probably doing that from the outside
        if (this.userInterfaceBoxes.length === 1) {
            this.follow(this.userInterfaceBoxes[0])
        }

        console.debug(`Project was created on ${this.rootBoxAdapter.created.toString()}`)
    }

    startAudioWorklet(restart?: RestartWorklet, options?: ProcessorOptions): EngineWorklet {
        console.debug(`start AudioWorklet`)
        const lifecycle = this.#terminator.spawn()
        const engine: EngineWorklet = lifecycle.own(this.#env.audioWorklets.createEngine({project: this, options}))
        const handler = async (event: unknown) => {
            console.warn(event)
            // we will only accept the first error
            engine.removeEventListener("error", handler)
            engine.removeEventListener("processorerror", handler)
            lifecycle.terminate()
            await safeExecute(restart?.unload, event)
            safeExecute(restart?.load, this.startAudioWorklet(restart))
        }
        engine.addEventListener("error", handler)
        engine.addEventListener("processorerror", handler)
        engine.connect(engine.context.destination)
        this.engine.setWorklet(engine)
        return engine
    }

    startRecording(countIn: boolean = true) {
        this.engine.assertWorklet()
        if (Recording.isRecording) {return}
        Recording.start(this, countIn).finally()
    }

    follow(box: UserInterfaceBox): void {
        this.userEditingManager.follow(box)
        this.selection.switch(box.selection)
    }

    own<T extends Terminable>(terminable: T): T {return this.#terminator.own<T>(terminable)}
    ownAll<T extends Terminable>(...terminables: Array<T>): void {return this.#terminator.ownAll<T>(...terminables)}
    spawn(): Terminator {return this.#terminator.spawn()}

    get env(): ProjectEnv {return this.#env}
    get rootBoxAdapter(): RootBoxAdapter {return this.boxAdapters.adapterFor(this.rootBox, RootBoxAdapter)}
    get timelineBoxAdapter(): TimelineBoxAdapter {return this.boxAdapters.adapterFor(this.timelineBox, TimelineBoxAdapter)}
    get sampleManager(): SampleLoaderManager {return this.#env.sampleManager}
    get soundfontManager(): SoundfontLoaderManager {return this.#env.soundfontManager}
    get clipSequencing(): ClipSequencing {return panic("Only available in audio context")}
    get isAudioContext(): boolean {return false}
    get isMainThread(): boolean {return true}
    get liveStreamBroadcaster(): LiveStreamBroadcaster {return panic("Only available in audio context")}
    get signatureDuration(): ppqn {
        const {nominator, denominator} = this.timelineBox.signature
        return PPQN.fromSignature(nominator.getValue(), denominator.getValue())
    }

    get skeleton(): ProjectSkeleton {
        return {
            boxGraph: this.boxGraph,
            mandatoryBoxes: {
                rootBox: this.rootBox,
                timelineBox: this.timelineBox,
                primaryAudioBus: this.masterBusBox,
                primaryAudioOutputUnit: this.masterAudioUnit,
                userInterfaceBoxes: this.userInterfaceBoxes
            }
        }
    }

    receivedMIDIFromEngine(midiDeviceId: string, data: Uint8Array, relativeTimeInMs: number): void {
        const debug = false
        if (debug) {
            console.debug("receivedMIDIFromEngine", MidiData.debug(data), relativeTimeInMs)
        }
        const timestamp = performance.now() + relativeTimeInMs
        MidiDevices.findOutputDeviceById(midiDeviceId).ifSome(midiOutputDevice => {
            try {
                midiOutputDevice?.send(data, timestamp)
            } catch (reason) {
                console.warn("Failed to send MIDI message", reason)
            }
        })
    }

    collectSampleUUIDs(): ReadonlyArray<UUID.Bytes> {
        return this.boxGraph.boxes()
            .filter(box => box.accept<BoxVisitor<boolean>>({visitAudioFileBox: (_box: AudioFileBox): boolean => true}))
            .map(box => box.address.uuid)
    }

    toArrayBuffer(): ArrayBufferLike {
        return ProjectSkeleton.encode(this.boxGraph)
    }

    copy(env?: Partial<ProjectEnv>): Project {
        return Project.load({...this.#env, ...env}, this.toArrayBuffer() as ArrayBuffer)
    }

    invalid(): boolean {
        // TODO Optimise. Flag changes somewhere.
        return this.boxGraph.boxes().some(box => box.accept<BoxVisitor<boolean>>({
            visitTrackBox: (box: TrackBox): boolean => {
                for (const [current, next] of Arrays.iterateAdjacent(box.regions.pointerHub.incoming()
                    .map(({box}) => UnionBoxTypes.asRegionBox(box))
                    .sort(({position: a}, {position: b}) => a.getValue() - b.getValue()))) {
                    if (current instanceof AudioRegionBox && current.timeBase.getValue() === TimeBase.Seconds) {
                        return false
                    }
                    if (current.position.getValue() + current.duration.getValue() > next.position.getValue()) {
                        return true
                    }
                }
                return false
            }
        }) ?? false)
    }

    terminate(): void {
        console.debug("Project terminated")
        this.#terminator.terminate()
    }
}