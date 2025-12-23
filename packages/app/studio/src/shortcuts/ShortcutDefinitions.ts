import {Shortcut} from "@opendaw/lib-dom"
import {ShortcutDefinition} from "@/shortcuts/ShortcutDefinition"
import {isAbsent, JSONValue} from "@opendaw/lib-std"

export type ShortcutDefinitions = Record<string, ShortcutDefinition>

export namespace ShortcutDefinitions {
    export const copy = (defs: ShortcutDefinitions): ShortcutDefinitions => {
        const result: ShortcutDefinitions = {}
        for (const [key, {keys, description}] of Object.entries(defs)) {
            result[key] = {keys: keys.copy(), description}
        }
        return result
    }

    export const copyInto = (source: ShortcutDefinitions, target: ShortcutDefinitions): void => {
        for (const [key, {keys}] of Object.entries(source)) {
            target[key].keys.overrideWith(keys.copy())
        }
    }

    export const toJSON = (defs: ShortcutDefinitions): JSONValue => {
        const result: Record<string, JSONValue> = {}
        for (const [key, {keys}] of Object.entries(defs)) {
            result[key] = keys.toJSON()
        }
        return result
    }

    export const fromJSON = (defs: ShortcutDefinitions, values: JSONValue): void => {
        if (typeof values !== "object" || values === null || Array.isArray(values)) {return}
        for (const [key, value] of Object.entries(values) as Array<[string, JSONValue]>) {
            const def = defs[key]
            if (isAbsent(def)) {continue}
            Shortcut.fromJSON(value).ifSome(keys => def.keys.overrideWith(keys))
        }
    }
}