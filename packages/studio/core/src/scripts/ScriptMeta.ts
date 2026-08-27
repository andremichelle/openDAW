import {isDefined, JSONValue} from "@opendaw/lib-std"

export type ScriptMeta = {
    name: string
    description: string
    created: Readonly<string>
    modified: string
    stock?: string
} & JSONValue

export namespace ScriptMeta {
    export const init = (name: string = "Untitled", description: string = ""): ScriptMeta => {
        const created = new Date().toISOString()
        return {name, description, created, modified: created}
    }

    export const copy = (meta: ScriptMeta): ScriptMeta => Object.assign({}, meta)

    export const fromJSON = (json: JSONValue): ScriptMeta => {
        if (!isDefined(json) || typeof json !== "object" || Array.isArray(json)) {return init()}
        return Object.assign(init(), json) as ScriptMeta
    }
}
