import {
    asInstanceOf,
    EmptyExec,
    isNull,
    Notifier,
    Observer,
    Option,
    Provider,
    Subscription,
    tryCatch,
    UUID
} from "@opendaw/lib-std"
import {Update} from "@opendaw/lib-box"
import {ProjectMetaBox} from "@opendaw/studio-boxes"
import {ProjectMeta} from "./ProjectMeta"
import {Project} from "./Project"
import {Workers} from "../Workers"
import {ProjectPaths} from "./ProjectPaths"

export class ProjectProfile {
    readonly #uuid: UUID.Bytes
    readonly #project: Project
    readonly #meta: ProjectMeta

    #cover: Option<ArrayBuffer>

    readonly #metaUpdated: Notifier<ProjectMeta>
    readonly #coverUpdated: Notifier<Option<ArrayBuffer>>
    readonly #coverIdUpdated: Notifier<string>
    readonly #metaBox: ProjectMetaBox

    #saved: boolean
    #hasChanges: boolean = false
    #applyingLocal: boolean = false

    constructor(uuid: UUID.Bytes,
                project: Project,
                meta: ProjectMeta,
                cover: Option<ArrayBuffer>,
                hasBeenSaved: boolean = false) {
        this.#uuid = uuid
        this.#project = project
        this.#meta = meta
        this.#cover = cover
        this.#saved = hasBeenSaved
        this.#metaUpdated = new Notifier<ProjectMeta>()
        this.#coverUpdated = new Notifier<Option<ArrayBuffer>>()
        this.#coverIdUpdated = new Notifier<string>()
        const existing = project.rootBox.projectMeta.targetVertex
        if (existing.nonEmpty()) {
            this.#metaBox = asInstanceOf(existing.unwrap(), ProjectMetaBox)
            this.#readMeta()
        } else {
            this.#metaBox = this.#createMetaBox()
        }
        project.own(project.boxGraph.subscribeToAllUpdates({onUpdate: update => this.#onBoxUpdate(update)}))
    }

    get uuid(): UUID.Bytes {return this.#uuid}
    get project(): Project {return this.#project}
    get meta(): ProjectMeta {return this.#meta}
    get cover(): Option<ArrayBuffer> {return this.#cover}
    get coverId(): string {return this.#metaBox.coverId.getValue()}

    async save(): Promise<void> {
        this.updateModifyDate()
        this.#project.editing.mark()
        return this.#saved
            ? ProjectProfile.#writeFiles(this).then(() => {
                this.#hasChanges = false
                this.#project.editing.markSaved()
            })
            : Promise.reject("Project has not been saved")
    }

    async saveAs(meta: ProjectMeta): Promise<Option<ProjectProfile>> {
        Object.assign(this.meta, meta)
        this.updateModifyDate()
        this.#runLocal(() => this.#writeMetaFields(this.#metaBox))
        if (this.#saved) {
            // Copy project
            const uuid = UUID.generate()
            const project = this.project.copy()
            const meta = ProjectMeta.copy(this.meta)
            const profile = new ProjectProfile(uuid, project, meta, this.#cover, true)
            await ProjectProfile.#writeFiles(profile)
            return Option.wrap(profile)
        } else {
            this.#project.editing.mark()
            return ProjectProfile.#writeFiles(this).then(() => {
                this.#saved = true
                this.#hasChanges = false
                this.#project.editing.markSaved()
                this.#metaUpdated.notify(this.meta)
                return Option.None
            })
        }
    }

    saved(): boolean {return this.#saved}
    hasUnsavedChanges(): boolean {return this.#project.editing.hasUnsavedChanges() || this.#hasChanges}

    subscribeMetaData(observer: Observer<ProjectMeta>): Subscription {
        return this.#metaUpdated.subscribe(observer)
    }

    subscribeCover(observer: Observer<Option<ArrayBuffer>>): Subscription {
        return this.#coverUpdated.subscribe(observer)
    }

    /** Notifies whenever the shared cover-id changes (a peer set a different cover). */
    subscribeCoverId(observer: Observer<string>): Subscription {
        return this.#coverIdUpdated.subscribe(observer)
    }

    updateCover(cover: Option<ArrayBuffer>): void {
        const next = cover.unwrapOrNull()
        if (next === this.#cover.unwrapOrNull()) {return}
        this.#cover = isNull(next) ? Option.None : Option.wrap(next)
        this.#hasChanges = true
        const coverId = isNull(next) ? "" : UUID.toString(UUID.generate())
        this.#runLocal(() => this.#metaBox.coverId.setValue(coverId))
    }

    /** Stores cover bytes fetched over P2P for the current cover-id (does not change the shared id). */
    setFetchedCover(cover: ArrayBuffer): void {
        this.#cover = Option.wrap(cover)
        this.#coverUpdated.notify(this.#cover)
    }

    updateMetaData<KEY extends keyof ProjectMeta>(key: KEY, value: ProjectMeta[KEY]): void {
        if (this.meta[key] === value) {return}
        this.meta[key] = value
        this.#hasChanges = true
        if (key !== "radioToken") {this.#runLocal(() => this.#writeMetaField(this.#metaBox, key))}
        this.#metaUpdated.notify(this.meta)
    }

    updateModifyDate(): void {
        this.meta.modified = new Date().toISOString()
        this.#runLocal(() => this.#metaBox.modified.setValue(this.meta.modified))
    }

    copyForUpload(): ProjectProfile {
        const meta = ProjectMeta.copy(this.meta)
        delete meta.radioToken // we do not expose this
        return new ProjectProfile(this.uuid, this.project, meta, this.cover)
    }

    toString(): string {
        return `{uuid: ${UUID.toString(this.uuid)}, meta: ${JSON.stringify(this.meta)}}`
    }

    #createMetaBox(): ProjectMetaBox {
        const {rootBox, boxGraph} = this.#project
        return this.#runLocal(() => {
            const box = ProjectMetaBox.create(boxGraph, UUID.generate())
            rootBox.projectMeta.refer(box)
            this.#writeMetaFields(box)
            box.coverId.setValue(this.#cover.isEmpty() ? "" : UUID.toString(UUID.generate()))
            return box
        })
    }

    #runLocal<R>(procedure: Provider<R>): R {
        const {boxGraph} = this.#project
        this.#applyingLocal = true
        let result: R
        if (boxGraph.inTransaction()) {
            result = procedure()
        } else {
            boxGraph.beginTransaction()
            result = procedure()
            boxGraph.endTransaction()
        }
        this.#applyingLocal = false
        return result
    }

    #onBoxUpdate(update: Update): void {
        if (this.#applyingLocal) {return}
        if (update.type !== "primitive" && update.type !== "pointer") {return}
        if (!UUID.equals(update.address.uuid, this.#metaBox.address.uuid)) {return}
        const {fieldKeys} = update.address
        if (fieldKeys[fieldKeys.length - 1] === this.#metaBox.coverId.address.fieldKeys[0]) {
            this.#cover = Option.None
            this.#coverUpdated.notify(this.#cover)
            this.#coverIdUpdated.notify(this.#metaBox.coverId.getValue())
        } else {
            this.#readMeta()
            this.#metaUpdated.notify(this.#meta)
        }
    }

    #readMeta(): void {
        const box = this.#metaBox
        const meta = this.#meta
        meta.name = box.projectName.getValue()
        meta.artist = box.artist.getValue()
        meta.description = box.description.getValue()
        meta.tags = this.#parseTags(box.tagList.getValue())
        const notepad = box.notepad.getValue()
        meta.notepad = notepad.length === 0 ? undefined : notepad
        meta.created = box.created.getValue()
        meta.modified = box.modified.getValue()
    }

    #writeMetaFields(box: ProjectMetaBox): void {
        const meta = this.#meta
        box.projectName.setValue(meta.name ?? "")
        box.artist.setValue(meta.artist ?? "")
        box.description.setValue(meta.description ?? "")
        box.tagList.setValue(JSON.stringify(meta.tags ?? []))
        box.notepad.setValue(meta.notepad ?? "")
        box.created.setValue(meta.created ?? "")
        box.modified.setValue(meta.modified ?? "")
    }

    #writeMetaField<KEY extends keyof ProjectMeta>(box: ProjectMetaBox, key: KEY): void {
        const meta = this.#meta
        switch (key) {
            case "name": return box.projectName.setValue(meta.name ?? "")
            case "artist": return box.artist.setValue(meta.artist ?? "")
            case "description": return box.description.setValue(meta.description ?? "")
            case "tags": return box.tagList.setValue(JSON.stringify(meta.tags ?? []))
            case "notepad": return box.notepad.setValue(meta.notepad ?? "")
            case "created": return box.created.setValue(meta.created ?? "")
            case "modified": return box.modified.setValue(meta.modified ?? "")
        }
    }

    #parseTags(json: string): Array<string> {
        const {status, value} = tryCatch(() => JSON.parse(json))
        return status === "success" && Array.isArray(value)
            ? value.filter((tag): tag is string => typeof tag === "string")
            : []
    }

    static async #writeFiles({uuid, project, meta, cover}: ProjectProfile): Promise<void> {
        return Promise.all([
            Workers.Opfs.write(ProjectPaths.projectFile(uuid), new Uint8Array(project.toArrayBuffer())),
            Workers.Opfs.write(ProjectPaths.projectMeta(uuid), new TextEncoder().encode(JSON.stringify(meta))),
            cover.match({
                none: () => Promise.resolve(),
                some: x => Workers.Opfs.write(ProjectPaths.projectCover(uuid), new Uint8Array(x))
            })
        ]).then(EmptyExec)
    }
}