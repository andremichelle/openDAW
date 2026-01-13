import {Option, Provider, UUID} from "@moises-ai/lib-std"
import {Promises} from "@moises-ai/lib-runtime"
import {Project, ProjectEnv, ProjectMeta, ProjectProfile, Workers} from "../"

export class Recovery {
    static readonly #RESTORE_FILE_PATH = ".backup"

    readonly #projectProfileProvider: Provider<Option<ProjectProfile>>
    readonly #env: ProjectEnv

    constructor(projectProfileService: Provider<Option<ProjectProfile>>, env: ProjectEnv) {
        this.#projectProfileProvider = projectProfileService
        this.#env = env
    }

    async restoreProfile(): Promise<Option<ProjectProfile>> {
        const backupResult = await Promises.tryCatch(Workers.Opfs.list(Recovery.#RESTORE_FILE_PATH))
        if (backupResult.status === "rejected" || backupResult.value.length === 0) {return Option.None}
        const readResult = await Promises.tryCatch(Promise.all([
            Workers.Opfs.read(`${Recovery.#RESTORE_FILE_PATH}/uuid`)
                .then(x => UUID.validateBytes(x)),
            Workers.Opfs.read(`${Recovery.#RESTORE_FILE_PATH}/project.od`)
                .then(x => Project.load(this.#env, x.buffer as ArrayBuffer)),
            Workers.Opfs.read(`${Recovery.#RESTORE_FILE_PATH}/meta.json`)
                .then(x => JSON.parse(new TextDecoder().decode(x.buffer as ArrayBuffer)) as ProjectMeta),
            Workers.Opfs.read(`${Recovery.#RESTORE_FILE_PATH}/saved`)
                .then(x => x.at(0) === 1)
        ]))
        const deleteResult = await Promises.tryCatch(Workers.Opfs.delete(Recovery.#RESTORE_FILE_PATH))
        console.debug(`delete backup: "${deleteResult.status}"`)
        if (readResult.status === "rejected") {return Option.None}
        const [uuid, project, meta, saved] = readResult.value
        const profile = new ProjectProfile(uuid, project, meta, Option.None, saved)
        console.debug(`restore ${profile}, saved: ${saved}`)
        return Option.wrap(profile)
    }

    createBackupCommand(): Option<Provider<Promise<void>>> {
        return this.#projectProfileProvider().map((profile: ProjectProfile) => async () => {
            console.debug("backup project")
            const {project, meta, uuid} = profile
            return Promises.tryCatch(Promise.all([
                Workers.Opfs.write(`${Recovery.#RESTORE_FILE_PATH}/uuid`,
                    uuid),
                Workers.Opfs.write(`${Recovery.#RESTORE_FILE_PATH}/project.od`,
                    new Uint8Array(project.toArrayBuffer())),
                Workers.Opfs.write(`${Recovery.#RESTORE_FILE_PATH}/meta.json`,
                    new TextEncoder().encode(JSON.stringify(meta))),
                Workers.Opfs.write(`${Recovery.#RESTORE_FILE_PATH}/saved`,
                    new Uint8Array([profile.saved() ? 1 : 0]))
            ])).then(result => console.debug(`backup result: ${result.status}`))
        })
    }
}