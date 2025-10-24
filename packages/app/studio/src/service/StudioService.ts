import {
    asInstanceOf,
    DefaultObservableValue,
    EmptyExec,
    Errors,
    Func,
    int,
    Notifier,
    Nullable,
    Observer,
    Option,
    Procedure,
    Provider,
    RuntimeNotifier,
    safeRead,
    Subscription,
    Terminable,
    Terminator,
    UUID
} from "@opendaw/lib-std"
import {populateStudioMenu} from "@/service/StudioMenu"
import {Snapping} from "@/ui/timeline/Snapping.ts"
import {PanelContents} from "@/ui/workspace/PanelContents.tsx"
import {createPanelFactory} from "@/ui/workspace/PanelFactory.tsx"
import {SpotlightDataSupplier} from "@/ui/spotlight/SpotlightDataSupplier.ts"
import {Workspace} from "@/ui/workspace/Workspace.ts"
import {PanelType} from "@/ui/workspace/PanelType.ts"
import {Dialogs} from "@/ui/components/dialogs.tsx"
import {BuildInfo} from "@/BuildInfo.ts"
import {SamplePlayback} from "@/service/SamplePlayback"
import {Shortcuts} from "@/service/Shortcuts"
import {ProjectProfileService} from "./ProjectProfileService"
import {StudioSignal} from "./StudioSignal"
import {AudioOutputDevice} from "@/audio/AudioOutputDevice"
import {FooterLabel} from "@/service/FooterLabel"
import {RouteLocation} from "@opendaw/lib-jsx"
import {PPQN} from "@opendaw/lib-dsp"
import {Browser, ConsoleCommands} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import {ExportStemsConfiguration} from "@opendaw/studio-adapters"
import {Address} from "@opendaw/lib-box"
import {
    AudioWorklets,
    CloudAuthManager,
    DawProjectService,
    DefaultSampleLoaderManager,
    DefaultSoundfontLoaderManager,
    EngineFacade,
    EngineWorklet,
    Preferences,
    Project,
    ProjectEnv,
    ProjectMeta,
    ProjectProfile,
    ProjectStorage,
    Recovery,
    RestartWorklet,
    SampleService,
    SoundfontService,
    TimelineRange
} from "@opendaw/studio-core"
import {ProjectDialogs} from "@/project/ProjectDialogs"
import {AudioUnitBox} from "@opendaw/studio-boxes"
import {AudioUnitType} from "@opendaw/studio-enums"
import {Surface} from "@/ui/surface/Surface"
import {SoftwareMIDIPanel} from "@/ui/software-midi/SoftwareMIDIPanel"
import {Mixdowns} from "@/service/Mixdowns"

/**
 * I am just piling stuff after stuff in here to boot the environment.
 * I suppose this gets cleaned up sooner or later.
 */

const range = new TimelineRange({padding: 12})
range.minimum = PPQN.fromSignature(3, 8)
range.maxUnits = PPQN.fromSignature(128, 1)
range.showUnitInterval(0, PPQN.fromSignature(16, 1))

const snapping = new Snapping(range)

export class StudioService implements ProjectEnv {
    readonly layout = {
        systemOpen: new DefaultObservableValue<boolean>(false),
        helpVisible: new DefaultObservableValue<boolean>(true),
        screen: new DefaultObservableValue<Nullable<Workspace.ScreenKeys>>("default")
    } as const
    readonly transport = {
        // TODO This does not respect the loop state of the timeline box.
        loop: new DefaultObservableValue<boolean>(false)
    } as const
    readonly timeline = {
        range,
        snapping,
        clips: {
            count: new DefaultObservableValue(3),
            visible: new DefaultObservableValue(true)
        },
        followPlaybackCursor: new DefaultObservableValue(true),
        primaryVisible: new DefaultObservableValue(true)
    } as const
    readonly menu = populateStudioMenu(this)
    readonly panelLayout = new PanelContents(createPanelFactory(this))
    readonly spotlightDataSupplier = new SpotlightDataSupplier()
    readonly samplePlayback: SamplePlayback
    // noinspection JSUnusedGlobalSymbols
    readonly _shortcuts = new Shortcuts(this) // TODO reference will be used later in a key-mapping configurator
    readonly recovery = new Recovery(() => this.#projectProfileService.getValue(), this)
    readonly engine = new EngineFacade()

    readonly #softwareKeyboardLifeCycle = new Terminator()
    readonly #signals = new Notifier<StudioSignal>()
    readonly #projectProfileService: ProjectProfileService
    readonly #sampleService: SampleService
    readonly #soundfontService: SoundfontService
    readonly #dawProjectService: DawProjectService

    #factoryFooterLabel: Option<Provider<FooterLabel>> = Option.None

    constructor(readonly audioContext: AudioContext,
                readonly audioWorklets: AudioWorklets,
                readonly audioDevices: AudioOutputDevice,
                readonly sampleManager: DefaultSampleLoaderManager,
                readonly soundfontManager: DefaultSoundfontLoaderManager,
                readonly cloudAuthManager: CloudAuthManager,
                readonly buildInfo: BuildInfo) {
        this.#sampleService = new SampleService(audioContext,
            sample => this.#signals.notify({type: "import-sample", sample}))
        this.#soundfontService = new SoundfontService(
            soundfont => this.#signals.notify({type: "import-soundfont", soundfont}))
        this.samplePlayback = new SamplePlayback()
        this.#dawProjectService = new DawProjectService(this.#sampleService)
        this.#projectProfileService = new ProjectProfileService({
            env: this,
            sampleService: this.#sampleService, sampleManager: this.sampleManager,
            soundfontService: this.#soundfontService, soundfontManager: this.soundfontManager
        })

        this.#listenProject()
        this.#installConsoleCommands()
        this.#populateSpotlightData()
        this.#configLocalStorage()
        this.#configBeforeUnload()
        this.#checkRecovery()
    }

    get sampleRate(): number {return this.audioContext.sampleRate}
    get sampleService(): SampleService {return this.#sampleService}
    get soundfontService(): SoundfontService {return this.#soundfontService}
    get projectProfileService(): ProjectProfileService {return this.#projectProfileService}

    panicEngine(): void {this.runIfProject(({engine}) => engine.panic())}

    async newProject() {
        if (this.hasProfile && !this.project.editing.isEmpty()) {
            const approved = await RuntimeNotifier.approve({
                headline: "Closing Project?",
                message: "You will lose all progress!"
            })
            if (!approved) {return}
        }
        this.#projectProfileService.setValue(Option.wrap(
            new ProjectProfile(UUID.generate(), Project.new(this), ProjectMeta.init("Untitled"), Option.None)))
    }

    async closeProject() {
        RouteLocation.get().navigateTo("/")
        if (!this.hasProfile) {
            this.switchScreen("dashboard")
            return
        }
        if (this.project.editing.isEmpty()) {
            this.#projectProfileService.setValue(Option.None)
        } else {
            const approved = await RuntimeNotifier.approve({
                headline: "Closing Project?",
                message: "You will lose all progress!"
            })
            if (approved) {this.#projectProfileService.setValue(Option.None)}
        }
    }

    async browseLocalProjects(): Promise<void> {
        const {status, value} = await Promises.tryCatch(ProjectDialogs.showBrowseDialog(this))
        if (status === "resolved") {
            const [uuid, meta] = value
            await this.#projectProfileService.load(uuid, meta)
        }
    }

    async loadTemplate(name: string): Promise<unknown> {return this.#projectProfileService.loadTemplate(name)}
    async exportBundle() {return this.#projectProfileService.exportBundle()}
    async importBundle() {return this.#projectProfileService.importBundle()}
    async deleteProject(uuid: UUID.Bytes, meta: ProjectMeta): Promise<void> {
        if (this.#projectProfileService.getValue().ifSome(profile => UUID.equals(profile.uuid, uuid)) === true) {
            await this.closeProject()
        }
        const {status} = await Promises.tryCatch(ProjectStorage.deleteProject(uuid))
        if (status === "resolved") {
            this.#signals.notify({type: "delete-project", meta})
        }
    }

    async exportMixdown() {
        return this.#projectProfileService.getValue()
            .ifSome(async (profile) => {
                await this.audioContext.suspend()
                await Mixdowns.exportMixdown(profile)
                this.audioContext.resume().then()
            })
    }

    async exportStems() {
        return this.#projectProfileService.getValue()
            .ifSome(async (profile) => {
                const {project} = profile
                if (project.rootBox.audioUnits.pointerHub.incoming()
                    .every(({box}) => asInstanceOf(box, AudioUnitBox).type.getValue() === AudioUnitType.Output)) {
                    return RuntimeNotifier.info({
                        headline: "Export Error",
                        message: "No stems to export"
                    })
                }
                const {status, error, value: config} =
                    await Promises.tryCatch(ProjectDialogs.showExportStemsDialog(project))
                if (status === "rejected") {
                    if (Errors.isAbort(error)) {return}
                    throw error
                }
                ExportStemsConfiguration.sanitizeExportNamesInPlace(config)
                await this.audioContext.suspend()
                await Mixdowns.exportStems(profile, config)
                this.audioContext.resume().then(EmptyExec, EmptyExec)
            })
    }

    async importDawproject() {
        (await this.#dawProjectService.importDawproject())
            .ifSome(skeleton => this.#projectProfileService
                .setProject(Project.skeleton(this, skeleton), "Dawproject"))
    }

    async exportDawproject(): Promise<void> {
        return this.#projectProfileService.getValue().ifSome(profile => this.#dawProjectService.exportDawproject(profile))
    }

    runIfProject<R>(procedure: Func<Project, R>): Option<R> {
        return this.#projectProfileService.getValue().map(({project}) => procedure(project))
    }

    get project(): Project {return this.profile.project}
    get profile(): ProjectProfile {return this.#projectProfileService.getValue().unwrap("No profile available")}
    get hasProfile(): boolean {return this.#projectProfileService.getValue().nonEmpty()}

    subscribeSignal<T extends StudioSignal["type"]>(
        observer: Observer<Extract<StudioSignal, { type: T }>>, type: T): Subscription {
        return this.#signals.subscribe(signal => {
            if (signal.type === type) {
                observer(signal as Extract<StudioSignal, { type: T }>)
            }
        })
    }

    switchScreen(key: Nullable<Workspace.ScreenKeys>): void {
        this.layout.screen.setValue(key)
        RouteLocation.get().navigateTo("/")
    }

    registerFooter(factory: Provider<FooterLabel>): void {
        this.#factoryFooterLabel = Option.wrap(factory)
    }

    factoryFooterLabel(): Option<Provider<FooterLabel>> {return this.#factoryFooterLabel}

    resetPeaks(): void {this.#signals.notify({type: "reset-peaks"})}

    async verifyProject() {
        if (!this.hasProfile) {return}
        const {boxGraph} = this.project
        const result = boxGraph.verifyPointers()
        await RuntimeNotifier.info({message: `Project is okay. All ${result.count} pointers are fine.`})
    }

    toggleSoftwareKeyboard(): void {
        if (this.isSoftwareKeyboardVisible()) {
            this.#softwareKeyboardLifeCycle.terminate()
        } else {
            const element = SoftwareMIDIPanel({
                lifecycle: this.#softwareKeyboardLifeCycle,
                service: this
            })
            Surface.get(window).floating.appendChild(element)
            this.#softwareKeyboardLifeCycle.own(Terminable.create(() => element.remove()))
        }
    }

    isSoftwareKeyboardVisible(): boolean {return this.#softwareKeyboardLifeCycle.nonEmpty()}

    #listenProject(): void {
        const lifeTime = new Terminator()
        const observer = (optProfile: Option<ProjectProfile>) => {
            const path = RouteLocation.get().path
            const isRoot = path === "/"
            if (isRoot) {this.layout.screen.setValue(null)}
            lifeTime.terminate()
            if (optProfile.nonEmpty()) {
                const profile = optProfile.unwrap()
                const {project, meta} = profile
                console.debug(`switch to %c${meta.name}%c`, "color: hsl(25, 69%, 63%)", "color: inherit")
                const {timelineBox, editing, userEditingManager} = project
                const loopState = this.transport.loop
                const loopEnabled = timelineBox.loopArea.enabled
                loopState.setValue(loopEnabled.getValue())
                lifeTime.ownAll(
                    project,
                    loopState.subscribe(value => editing.modify(() => loopEnabled.setValue(value.getValue()))),
                    userEditingManager.timeline.catchupAndSubscribe(option => option
                        .ifSome(() => this.panelLayout.showIfAvailable(PanelType.ContentEditor))),
                    timelineBox.durationInPulses.catchupAndSubscribe(owner => range.maxUnits = owner.getValue() + PPQN.Bar),
                    project.timelineBoxAdapter.catchupAndSubscribeSignature(signature => snapping.signature = signature)
                )
                range.showUnitInterval(0, PPQN.fromSignature(16, 1))

                // -------------------------------
                // Show views if content available
                // -------------------------------
                //
                // Markers
                if (timelineBox.markerTrack.markers.pointerHub.nonEmpty()) {
                    this.timeline.primaryVisible.setValue(true)
                }
                // Clips
                const maxClipIndex: int = project.rootBoxAdapter.audioUnits.adapters()
                    .reduce((max, unit) => Math.max(max, unit.tracks.values()
                        .reduce((max, track) => Math.max(max, track.clips.collection.getMinFreeIndex()), 0)), 0)
                if (maxClipIndex > 0 || Preferences.values["auto-open-clips"]) {
                    this.timeline.clips.count.setValue(Math.max(maxClipIndex + 1, 3))
                    this.timeline.clips.visible.setValue(true)
                } else {
                    this.timeline.clips.count.setValue(3)
                    this.timeline.clips.visible.setValue(false)
                }
                let screen: Nullable<Workspace.ScreenKeys> = null
                const restart: RestartWorklet = {
                    unload: async (event: unknown) => {
                        screen = this.layout.screen.getValue()
                        // we need to restart the screen to subscribe to new broadcaster instances
                        this.switchScreen(null)
                        this.engine.releaseWorklet()
                        return Dialogs.info({
                            headline: "Audio-Engine Error",
                            message: String(safeRead(event, "error", "message") ?? "Unknown error"),
                            okText: "Restart"
                        })
                    },
                    load: (engine: EngineWorklet) => {
                        this.engine.setWorklet(engine)
                        this.switchScreen(screen)
                    }
                }
                this.engine.setWorklet(project.startAudioWorklet(restart, {pauseOnLoopDisabled: false}))
                if (isRoot) {this.switchScreen("default")}
            } else {
                this.engine.releaseWorklet()
                range.maxUnits = PPQN.fromSignature(128, 1)
                range.showUnitInterval(0, PPQN.fromSignature(16, 1))
                this.layout.screen.setValue("dashboard")
            }
        }
        this.#projectProfileService.catchupAndSubscribe(owner => observer(owner.getValue()))
    }

    #installConsoleCommands(): void {
        ConsoleCommands.exportAccessor("box.graph.boxes",
            () => this.runIfProject(({boxGraph}) => boxGraph.debugBoxes()))
        ConsoleCommands.exportMethod("box.graph.lookup",
            (address: string) => this.runIfProject(({boxGraph}) => boxGraph.findVertex(Address.decode(address)).match({
                none: () => "not found",
                some: vertex => vertex.toString()
            })).match({none: () => "no project", some: value => value}))
        ConsoleCommands.exportAccessor("box.graph.dependencies",
            () => this.runIfProject(project => project.boxGraph.debugDependencies()))
    }

    #populateSpotlightData(): void {
        this.spotlightDataSupplier.registerAction("Create Synth", EmptyExec)
        this.spotlightDataSupplier.registerAction("Create Drumcomputer", EmptyExec)
        this.spotlightDataSupplier.registerAction("Create ModularSystem", EmptyExec)
    }

    #configLocalStorage(): void {
        const configLocalStorageBoolean = (value: DefaultObservableValue<boolean>,
                                           item: string,
                                           set: Procedure<boolean>,
                                           defaultValue: boolean = false) => {
            value.setValue((localStorage.getItem(item) ?? String(defaultValue)) === String(true))
            value.catchupAndSubscribe(owner => {
                const bool = owner.getValue()
                set(bool)
                try {localStorage.setItem(item, String(bool))} catch (_reason: any) {}
            })
        }

        configLocalStorageBoolean(this.layout.helpVisible, "help-visible",
            visible => document.body.classList.toggle("help-hidden", !visible), true)
    }

    #configBeforeUnload(): void {
        if (!Browser.isLocalHost()) {
            window.addEventListener("beforeunload", (event: Event) => {
                if (!navigator.onLine) {event.preventDefault()}
                if (this.hasProfile && (this.profile.hasChanges() || !this.project.editing.isEmpty())) {
                    event.preventDefault()
                }
            })
        }
    }

    #checkRecovery(): void {
        this.recovery.restoreProfile().then(optProfile => {
            if (optProfile.nonEmpty()) {
                this.#projectProfileService.setValue(optProfile)
            }
        }, EmptyExec)
    }
}