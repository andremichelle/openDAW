import {
    Arrays,
    Func,
    isDefined,
    panic,
    Procedure,
    RuntimeNotifier,
    safeExecute,
    SortedSet,
    Terminable,
    TerminableOwner,
    Terminator,
    UUID
} from "@opendaw/lib-std"
import {BoxEditing, BoxGraph, DeleteUpdate, NewUpdate} from "@opendaw/lib-box"
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
    AnyRegionBoxAdapter,
    AudioUnitBoxAdapter,
    BoxAdapters,
    BoxAdaptersContext,
    ClipSequencing,
    DeviceBoxAdapter,
    DeviceBoxUtils,
    Devices,
    FilteredSelection,
    isVertexOfBox,
    ParameterFieldAdapters,
    ProcessorOptions,
    ProjectMandatoryBoxes,
    ProjectSkeleton,
    RegionAdapters,
    RootBoxAdapter,
    SampleLoaderManager,
    SoundfontLoaderManager,
    TimelineBoxAdapter,
    UnionBoxTypes,
    UserEditingManager,
    VaryingTempoMap,
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
import {ppqn, TempoMap, TimeBase} from "@opendaw/lib-dsp"
import {MidiData} from "@opendaw/lib-midi"
import {StudioPreferences} from "../StudioPreferences"
import {RegionOverlapResolver, TimelineFocus} from "../ui"
import {SampleStorage} from "../samples"

export type RestartWorklet = { unload: Func<unknown, Promise<unknown>>, load: Procedure<EngineWorklet> }

export type ProjectCreateOptions = {
    noDefaultUser?: boolean
}

// Main Entry Point for a Project
export class Project implements BoxAdaptersContext, Terminable, TerminableOwner {
    static new(env: ProjectEnv, options?: ProjectCreateOptions): Project {
        const createDefaultUser = options?.noDefaultUser !== true
        const createOutputCompressor = StudioPreferences.settings.engine["auto-create-output-compressor"]
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
    readonly #sampleRegistrations: SortedSet<UUID.Bytes, { uuid: UUID.Bytes, terminable: Terminable }>
    readonly #userCreatedSamples: SortedSet<UUID.Bytes, UUID.Bytes> = UUID.newSet(uuid => uuid)

    readonly #env: ProjectEnv
    readonly boxGraph: BoxGraph<BoxIO.TypeMap>

    readonly rootBox: RootBox
    readonly userInterfaceBoxes: ReadonlyArray<UserInterfaceBox>
    readonly primaryAudioBusBox: AudioBusBox
    readonly primaryAudioUnitBox: AudioUnitBox
    readonly timelineBox: TimelineBox

    readonly api: ProjectApi
    readonly captureDevices: CaptureDevices
    readonly editing: BoxEditing
    readonly selection: VertexSelection
    readonly deviceSelection: FilteredSelection<DeviceBoxAdapter>
    readonly regionSelection: FilteredSelection<AnyRegionBoxAdapter>
    readonly boxAdapters: BoxAdapters
    readonly userEditingManager: UserEditingManager
    readonly parameterFieldAdapters: ParameterFieldAdapters
    readonly liveStreamReceiver: LiveStreamReceiver
    readonly midiLearning: MIDILearning
    readonly mixer: Mixer
    readonly tempoMap: TempoMap
    readonly overlapResolver: RegionOverlapResolver
    readonly timelineFocus: TimelineFocus
    readonly engine = new EngineFacade()

    readonly #rootBoxAdapter: RootBoxAdapter
    readonly #timelineBoxAdapter: TimelineBoxAdapter

    private constructor(env: ProjectEnv, boxGraph: BoxGraph, {
        rootBox,
        userInterfaceBoxes,
        primaryAudioBusBox,
        primaryAudioUnitBox,
        timelineBox
    }: ProjectMandatoryBoxes) {
        this.#env = env
        this.boxGraph = boxGraph
        this.rootBox = rootBox
        this.userInterfaceBoxes = userInterfaceBoxes
        this.primaryAudioBusBox = primaryAudioBusBox
        this.primaryAudioUnitBox = primaryAudioUnitBox
        this.timelineBox = timelineBox

        this.api = new ProjectApi(this)
        this.editing = new BoxEditing(this.boxGraph)
        this.selection = new VertexSelection(this.editing, this.boxGraph)
        this.parameterFieldAdapters = new ParameterFieldAdapters()
        this.boxAdapters = this.#terminator.own(new BoxAdapters(this))
        this.deviceSelection = this.#terminator.own(this.selection.createFilteredSelection(
            isVertexOfBox(DeviceBoxUtils.isDeviceBox),
            {
                fx: (adapter: DeviceBoxAdapter) => adapter.box,
                fy: vertex => this.boxAdapters.adapterFor(vertex.box, Devices.isAny)
            }
        ))
        this.regionSelection = this.#terminator.own(this.selection.createFilteredSelection(
            isVertexOfBox(UnionBoxTypes.isRegionBox),
            {
                fx: (adapter: AnyRegionBoxAdapter) => adapter.box,
                fy: vertex => RegionAdapters.for(this.boxAdapters, vertex.box)
            }
        ))
        this.#timelineBoxAdapter = this.boxAdapters.adapterFor(this.timelineBox, TimelineBoxAdapter)
        this.tempoMap = this.#terminator.own(new VaryingTempoMap(this.#timelineBoxAdapter))
        this.userEditingManager = new UserEditingManager(this.editing)
        this.liveStreamReceiver = this.#terminator.own(new LiveStreamReceiver())
        this.midiLearning = this.#terminator.own(new MIDILearning(this))
        this.captureDevices = this.#terminator.own(new CaptureDevices(this))
        this.#rootBoxAdapter = this.boxAdapters.adapterFor(this.rootBox, RootBoxAdapter)
        this.mixer = new Mixer(this.#rootBoxAdapter.audioUnits)
        this.overlapResolver = new RegionOverlapResolver(this.editing, this.api, this.boxAdapters)
        this.timelineFocus = this.#terminator.own(new TimelineFocus())

        console.debug(`Project was created on ${this.rootBoxAdapter.created.toString()}`)

        this.#sampleRegistrations = UUID.newSet(({uuid}) => uuid)

        for (const box of this.boxGraph.boxes()) {
            if (box instanceof AudioFileBox) {
                this.#registerSample(box.address.uuid)
            }
        }
        this.#terminator.own(this.boxGraph.subscribeToAllUpdates({
            onUpdate: (update) => {
                if (update instanceof NewUpdate && update.name === AudioFileBox.ClassName) {
                    this.#registerSample(update.uuid)
                } else if (update instanceof DeleteUpdate && update.name === AudioFileBox.ClassName) {
                    this.#unregisterSample(update.uuid)
                    this.#deleteUserCreatedSample(update.uuid)
                }
            }
        }))
    }

    startAudioWorklet(restart?: RestartWorklet, options?: ProcessorOptions): EngineWorklet {
        console.debug(`start AudioWorklet`)
        const lifecycle = this.#terminator.spawn()
        const worklet: EngineWorklet = lifecycle.own(this.#env.audioWorklets.createEngine({project: this, options}))
        const handler = async (event: unknown) => {
            console.warn(event)
            // we will only accept the first error
            worklet.removeEventListener("error", handler)
            worklet.removeEventListener("processorerror", handler)
            lifecycle.terminate()
            await safeExecute(restart?.unload, event)
            safeExecute(restart?.load, this.startAudioWorklet(restart))
        }
        worklet.addEventListener("error", handler)
        worklet.addEventListener("processorerror", handler)
        worklet.connect(worklet.context.destination)
        this.engine.setWorklet(worklet)
        return worklet
    }

    handleCpuOverload(): void {
        if (!StudioPreferences.settings.engine["stop-playback-when-overloading"]) {return}
        this.engine.sleep()
        RuntimeNotifier.info({
            headline: "CPU Overload Detected",
            message: "Playback has been stopped. Try removing heavy plugins or effects."
        }).finally()
    }

    startRecording(countIn: boolean = true) {
        this.engine.assertWorklet()
        if (Recording.isRecording) {return}
        Recording.start(this, countIn).finally()
    }

    stopRecording(): void {
        this.engine.stopRecording()
        this.editing.mark()
    }

    isRecording(): boolean {return Recording.isRecording}

    follow(box: UserInterfaceBox): void {
        this.userEditingManager.follow(box)
        this.midiLearning.followUser(box.midiControllers)
        this.selection.switch(box.selection)
    }

    own<T extends Terminable>(terminable: T): T {return this.#terminator.own<T>(terminable)}
    ownAll<T extends Terminable>(...terminables: Array<T>): void {return this.#terminator.ownAll<T>(...terminables)}
    spawn(): Terminator {return this.#terminator.spawn()}

    get env(): ProjectEnv {return this.#env}
    get rootBoxAdapter(): RootBoxAdapter {return this.#rootBoxAdapter}
    get timelineBoxAdapter(): TimelineBoxAdapter {return this.#timelineBoxAdapter}
    get sampleManager(): SampleLoaderManager {return this.#env.sampleManager}
    get soundfontManager(): SoundfontLoaderManager {return this.#env.soundfontManager}
    get clipSequencing(): ClipSequencing {return panic("Only available in audio context")}
    get isAudioContext(): boolean {return false}
    get isMainThread(): boolean {return true}
    get primaryAudioUnitBoxAdapter(): AudioUnitBoxAdapter {
        return this.boxAdapters.adapterFor(this.primaryAudioUnitBox, AudioUnitBoxAdapter)
    }
    get liveStreamBroadcaster(): LiveStreamBroadcaster {return panic("Only available in audio context")}

    get skeleton(): ProjectSkeleton {
        return {
            boxGraph: this.boxGraph,
            mandatoryBoxes: {
                rootBox: this.rootBox,
                timelineBox: this.timelineBox,
                primaryAudioBusBox: this.primaryAudioBusBox,
                primaryAudioUnitBox: this.primaryAudioUnitBox,
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

    restartRecording(): void {
        if (this.engine.isRecording.getValue()) {
            const countingIn = Recording.wasCountingIn()
            this.engine.stopRecording()
            this.editing.modify(() => this.captureDevices.filterArmed()
                .forEach(capture => {
                    capture.recordedRegions().forEach(region => region.box.delete())
                    capture.clearRecordedRegions()
                }), false)
            this.engine.stop(true)
            this.engine.setPosition(Recording.wasStartingAt())
            const subscription = this.engine.isRecording.catchupAndSubscribe(owner => {
                if (!owner.getValue()) {
                    queueMicrotask(() => subscription.terminate())
                    this.startRecording(countingIn)
                }
            })
        } else {
            this.startRecording()
        }
    }

    toArrayBuffer(): ArrayBufferLike {return ProjectSkeleton.encode(this.boxGraph)}

    copy(env?: Partial<ProjectEnv>): Project {
        return Project.load({...this.#env, ...env}, this.toArrayBuffer() as ArrayBuffer)
    }

    invalid(): boolean {
        const now = performance.now()
        const result = this.boxGraph.boxes().some(box => box.accept<BoxVisitor<boolean>>({
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
        if (performance.now() - now > 5) {
            console.warn("Evaluation of invalid project takes more than 5ms")
        }
        return result
    }

    lastRegionAction(): ppqn {
        return this.rootBoxAdapter.audioUnits.adapters()
            .flatMap(audioUnitAdapter => audioUnitAdapter.tracks.values()
                .map(trackAdapter => trackAdapter.regions.collection.asArray().at(-1)))
            .filter(isDefined).reduce((position, region) => Math.max(position, region.complete), 0)
    }

    trackUserCreatedSample(uuid: UUID.Bytes): void {
        this.#userCreatedSamples.add(uuid)
    }

    terminate(): void {
        this.#sampleRegistrations.forEach(({terminable}) => terminable.terminate())
        this.#sampleRegistrations.clear()
        this.#terminator.terminate()
    }

    #registerSample(uuid: UUID.Bytes): void {
        const terminable = this.sampleManager.register(uuid)
        this.#sampleRegistrations.add({uuid, terminable})
    }

    #unregisterSample(uuid: UUID.Bytes): void {
        this.#sampleRegistrations.removeByKey(uuid).terminable.terminate()
    }

    async #deleteUserCreatedSample(uuid: UUID.Bytes): Promise<void> {
        if (!this.#userCreatedSamples.hasKey(uuid)) {return}
        this.#userCreatedSamples.removeByKey(uuid)
        const autoDelete = StudioPreferences.settings.storage["auto-delete-orphaned-samples"]
        if (!autoDelete && await RuntimeNotifier.approve({
            headline: "Keep Sample?",
            message: "The sample is no longer used. Do you want to keep it in storage? Deletion of samples cannot be undone!",
            approveText: "Keep",
            cancelText: "Delete"
        })) {return}
        SampleStorage.get().deleteItem(uuid).catch((reason: unknown) =>
            console.warn("Failed to delete sample from storage", reason))
    }
}