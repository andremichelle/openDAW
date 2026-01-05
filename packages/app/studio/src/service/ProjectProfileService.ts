import {
    DefaultObservableValue,
    Errors,
    MutableObservableOption,
    Observer,
    Option,
    RuntimeNotifier,
    Terminable,
    UUID
} from "@opendaw/lib-std"
import {ProjectDialogs} from "@/project/ProjectDialogs"
import {Dialogs} from "@/ui/components/dialogs"
import {Promises} from "@opendaw/lib-runtime"
import {Files} from "@opendaw/lib-dom"
import {
    FilePickerAcceptTypes,
    Project,
    ProjectBundle,
    ProjectEnv,
    ProjectMeta,
    ProjectProfile,
    ProjectStorage,
    SampleService,
    SoundfontService
} from "@opendaw/studio-core"
import {SampleLoaderManager, SoundfontLoaderManager} from "@opendaw/studio-adapters"

export class ProjectProfileService {
    readonly #profile: MutableObservableOption<ProjectProfile>

    readonly #env: ProjectEnv
    readonly #sampleService: SampleService
    readonly #sampleManager: SampleLoaderManager
    readonly #soundfontService: SoundfontService
    readonly #soundfontManager: SoundfontLoaderManager

    constructor({env, sampleService, sampleManager, soundfontService, soundfontManager}: {
        env: ProjectEnv,
        sampleService: SampleService,
        sampleManager: SampleLoaderManager,
        soundfontService: SoundfontService,
        soundfontManager: SoundfontLoaderManager
    }) {
        this.#env = env
        this.#sampleService = sampleService
        this.#sampleManager = sampleManager
        this.#soundfontService = soundfontService
        this.#soundfontManager = soundfontManager
        this.#profile = new MutableObservableOption<ProjectProfile>()
    }

    getValue(): Option<ProjectProfile> {return this.#profile}
    setValue(value: Option<ProjectProfile>): void {this.#profile.wrapOption(value)}
    subscribe(observer: Observer<Option<ProjectProfile>>): Terminable {
        return this.#profile.subscribe(observer)
    }
    catchupAndSubscribe(observer: Observer<Option<ProjectProfile>>): Terminable {
        observer(this.#profile)
        return this.#profile.subscribe(observer)
    }

    async save(): Promise<void> {
        return this.#profile.ifSome(profile => profile.saved() ? profile.save() : this.saveAs())
    }

    async saveAs(): Promise<void> {
        return this.#profile.ifSome(async profile => {
            const {status, value: meta} = await Promises.tryCatch(ProjectDialogs.showSaveDialog({
                headline: "Save Project",
                meta: profile.meta
            }))
            if (status === "rejected") {return}
            const optProfile = await profile.saveAs(meta)
            optProfile.ifSome(profile => this.#profile.wrap(profile))
        })
    }

    async load(uuid: UUID.Bytes, meta: ProjectMeta) {
        const project: Project = await ProjectStorage.loadProject(uuid).then(buffer => Project.loadAnyVersion(this.#env, buffer))
        await this.#sampleService.replaceMissingFiles(project.boxGraph, this.#sampleManager)
        await this.#soundfontService.replaceMissingFiles(project.boxGraph, this.#soundfontManager)
        const cover = await ProjectStorage.loadCover(uuid)
        this.#setProfile(uuid, project, meta, cover, true)
    }

    async exportBundle() {
        return this.#profile.ifSome(async profile => {
            const progressValue = new DefaultObservableValue(0.0)
            const processDialog = RuntimeNotifier.progress({headline: "Bundling Project...", progress: progressValue})
            const {status, value: arrayBuffer, error} = await Promises.tryCatch(
                ProjectBundle.encode(profile, progress => progressValue.setValue(progress)))
            processDialog.terminate()
            if (status === "rejected") {
                await RuntimeNotifier.info({headline: "Export Failed", message: String(error)})
                return
            }
            const {status: approveStatus} = await Promises.tryCatch(Dialogs.approve({
                headline: "Save Project Bundle",
                message: "",
                approveText: "Save"
            }))
            if (approveStatus === "rejected") {return}
            try {
                await Files.save(arrayBuffer, {
                    suggestedName: `${profile.meta.name}.odb`,
                    types: [FilePickerAcceptTypes.ProjectBundleFileType],
                    startIn: "desktop"
                })
            } catch (error) {
                if (!Errors.isAbort(error)) {
                    Dialogs.info({headline: "Could not export project", message: String(error)}).finally()
                }
            }
        })
    }

    async importBundle() {
        try {
            const [file] = await Files.open({types: [FilePickerAcceptTypes.ProjectBundleFileType]})
            const arrayBuffer = await file.arrayBuffer()
            const exclude = this.#profile.map(({uuid}) => uuid).unwrapOrUndefined()
            const profile = await ProjectBundle.decode(this.#env, arrayBuffer, exclude)
            this.#profile.wrap(profile)
        } catch (error) {
            if (!Errors.isAbort(error)) {
                Dialogs.info({headline: "Could not load project", message: String(error)}).finally()
            }
        }
    }

    async saveFile() {
        this.#profile.ifSome(async profile => {
            const arrayBuffer = profile.project.toArrayBuffer() as ArrayBuffer
            try {
                const fileName = await Files.save(arrayBuffer, {
                    suggestedName: "project.od",
                    types: [FilePickerAcceptTypes.ProjectFileType]
                })
                Dialogs.info({message: `Project '${fileName}' saved successfully!`}).finally()
            } catch (error) {
                if (!Errors.isAbort(error)) {
                    Dialogs.info({message: `Error saving project: ${error}`}).finally()
                }
            }
        })
    }

    async loadFile() {
        try {
            const [file] = await Files.open({types: [FilePickerAcceptTypes.ProjectFileType]})
            const project = await Project.loadAnyVersion(this.#env, await file.arrayBuffer())
            this.#setProfile(UUID.generate(), project, ProjectMeta.init(file.name), Option.None)
        } catch (error) {
            if (!Errors.isAbort(error)) {
                Dialogs.info({headline: "Could not load project", message: String(error)}).finally()
            }
        }
    }

    setProject(project: Project, name: string): void {
        this.#setProfile(UUID.generate(), project, ProjectMeta.init(name), Option.None)
    }

    #setProfile(...args: ConstructorParameters<typeof ProjectProfile>): void {
        this.#profile.wrap(this.#createProfile(...args))
    }

    #createProfile(...args: ConstructorParameters<typeof ProjectProfile>): ProjectProfile {
        return new ProjectProfile(...args)
    }
}