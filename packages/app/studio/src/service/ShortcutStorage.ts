import {isAbsent, isDefined, JSONValue, Objects, tryCatch} from "@opendaw/lib-std"
import {ShortcutDefinitions} from "@opendaw/lib-dom"

export type ShortcutContexts = Record<string, Readonly<{ factory: ShortcutDefinitions, workingDefinition: ShortcutDefinitions }>>
export type ShortcutStore = Pick<Storage, "getItem" | "setItem" | "removeItem">

export namespace ShortcutStorage {
    export const StorageKey = "custom-shortcuts"
    export const LegacyStorageKey = "shortcuts"

    // legacy snapshots hold every shortcut, including the defaults these had before 76569d459
    const LegacyMoved: Readonly<Record<string, ReadonlyArray<string>>> = {
        global: [
            "workspace-screen-modulation", "workspace-screen-piano",
            "workspace-screen-project", "workspace-screen-shadertoy"
        ]
    }

    const isRecord = (value: JSONValue | undefined): value is Record<string, JSONValue> =>
        typeof value === "object" && !isAbsent(value) && !Array.isArray(value)

    const contextOf = (stored: JSONValue, name: string, legacy: boolean): JSONValue => {
        if (!isRecord(stored)) {return null}
        const values = stored[name]
        if (!isRecord(values)) {return null}
        if (!legacy) {return values}
        const moved = LegacyMoved[name] ?? []
        return Object.fromEntries(Object.entries(values).filter(([key]) => !moved.includes(key)))
    }

    export const customized = (contexts: ShortcutContexts): Record<string, JSONValue> =>
        Objects.entries(contexts).reduce((record, [name, {factory, workingDefinition}]) => {
            record[name] = Object.fromEntries(Object.entries(workingDefinition)
                .filter(([key, {shortcut}]) => !shortcut.equals(factory[key].shortcut))
                .map(([key, {shortcut}]) => [key, shortcut.toJSON()]))
            return record
        }, {} as Record<string, JSONValue>)

    export const store = (contexts: ShortcutContexts, storage: ShortcutStore): void => {
        tryCatch(() => storage.setItem(StorageKey, JSON.stringify(customized(contexts))))
    }

    export const load = (contexts: ShortcutContexts, storage: ShortcutStore): boolean => {
        const current = storage.getItem(StorageKey)
        const legacy = storage.getItem(LegacyStorageKey)
        const source = current ?? legacy
        if (!isDefined(source)) {return false}
        const {status, value: stored, error} = tryCatch((): JSONValue => JSON.parse(source))
        if (status === "failure") {
            console.warn(error)
            return false
        }
        Objects.entries(contexts).forEach(([name, {workingDefinition}]) =>
            ShortcutDefinitions.fromJSON(workingDefinition, contextOf(stored, name, !isDefined(current))))
        if (isDefined(legacy)) {
            storage.removeItem(LegacyStorageKey)
            store(contexts, storage)
        }
        return true
    }
}
