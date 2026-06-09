import {isDefined, JSONValue} from "@opendaw/lib-std"

export type ProjectMeta = {
    name: string
    artist: string
    description: string
    tags: Array<string>
    created: Readonly<string>
    modified: string
    notepad?: string
    radioToken?: string
} & JSONValue

export namespace ProjectMeta {
    const created = new Date().toISOString()
    export const init = (name: string = "Untitled"): ProjectMeta => ({
        artist: "",
        name,
        description: "",
        tags: [],
        created,
        modified: created
    })

    export const copy = (meta: ProjectMeta): ProjectMeta => Object.assign({}, meta)

    // Stored meta from older projects can lack fields (e.g. artist). A bare cast leaves them undefined,
    // which later writes undefined into ProjectMetaBox StringFields and breaks serialization. Merge over defaults.
    export const fromJSON = (json: JSONValue): ProjectMeta => {
        if (!isDefined(json) || typeof json !== "object" || Array.isArray(json)) {return init()}
        return Object.assign(init(), json) as ProjectMeta
    }
}