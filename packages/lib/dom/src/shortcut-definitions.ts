import {Shortcut} from "./shortcut-manager"
import {isAbsent, JSONValue} from "@opendaw/lib-std"

export type ShortcutDefinition = { shortcut: Shortcut, description: string }

export type ShortcutDefinitions = Record<string, ShortcutDefinition>

export namespace ShortcutDefinitions {
    export const copy = (defs: ShortcutDefinitions): ShortcutDefinitions => {
        const result: ShortcutDefinitions = {}
        for (const [key, {shortcut, description}] of Object.entries(defs)) {
            result[key] = {shortcut: shortcut.copy(), description}
        }
        return result
    }

    export const copyInto = (source: ShortcutDefinitions, target: ShortcutDefinitions): void => {
        for (const [key, {shortcut}] of Object.entries(source)) {
            target[key].shortcut.overrideWith(shortcut.copy())
        }
    }

    export const toJSON = (defs: ShortcutDefinitions): JSONValue => {
        const result: Record<string, JSONValue> = {}
        for (const [key, {shortcut}] of Object.entries(defs)) {
            result[key] = shortcut.toJSON()
        }
        return result
    }

    export const fromJSON = (defs: ShortcutDefinitions, values: JSONValue): void => {
        if (typeof values !== "object" || values === null || Array.isArray(values)) {return}
        for (const [key, value] of Object.entries(values) as Array<[string, JSONValue]>) {
            const def = defs[key]
            if (isAbsent(def)) {continue}
            Shortcut.fromJSON(value).ifSome(keys => def.shortcut.overrideWith(keys))
        }
    }
}

export namespace ShortcutValidator {
    export const validate = <T extends ShortcutDefinitions>(actions: T): T => {
        const entries = Object.entries(actions)
        for (let i = 0; i < entries.length; i++) {
            for (let j = i + 1; j < entries.length; j++) {
                if (entries[i][1].shortcut.equals(entries[j][1].shortcut)) {
                    alert(`Shortcut conflict: '${entries[i][0]}' and '${entries[j][0]}' both use ${entries[i][1].shortcut.format()}`)
                }
            }
        }
        return actions
    }
}