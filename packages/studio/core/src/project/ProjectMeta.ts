import {JSONValue} from "@moises-ai/lib-std"

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
}