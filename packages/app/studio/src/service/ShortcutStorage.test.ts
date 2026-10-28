import {describe, expect, it} from "vitest"
import {Nullable} from "@opendaw/lib-std"
import {Key, Shortcut, ShortcutDefinitions} from "@opendaw/lib-dom"
import {ShortcutContexts, ShortcutStorage, ShortcutStore} from "./ShortcutStorage"

const shift = true

const createStore = (initial: Record<string, string> = {}) => {
    const items = new Map<string, string>(Object.entries(initial))
    const store: ShortcutStore = {
        getItem: (key: string): Nullable<string> => items.get(key) ?? null,
        setItem: (key: string, value: string) => {items.set(key, value)},
        removeItem: (key: string) => {items.delete(key)}
    }
    return {items, store}
}

// mirrors the screen shortcuts after 76569d459 plus one untouched entry
const createContexts = (): ShortcutContexts => {
    const factory: ShortcutDefinitions = {
        "workspace-screen-modulation": {shortcut: Shortcut.of(Key.Digit3, {shift}), description: ""},
        "workspace-screen-piano": {shortcut: Shortcut.of(Key.Digit4, {shift}), description: ""},
        "workspace-screen-project": {shortcut: Shortcut.of(Key.Digit5, {shift}), description: ""},
        "workspace-screen-shadertoy": {shortcut: Shortcut.of(Key.Digit6, {shift}), description: ""},
        "toggle-loop": {shortcut: Shortcut.of(Key.KeyL), description: ""}
    }
    return {global: {factory, workingDefinition: ShortcutDefinitions.copy(factory)}}
}

const working = (contexts: ShortcutContexts, key: string): Shortcut => contexts.global.workingDefinition[key].shortcut

// a full snapshot as the old store() wrote it, with the pre-76569d459 screen defaults and a custom loop key
const legacySnapshot = JSON.stringify({
    global: {
        "workspace-screen-piano": Shortcut.of(Key.Digit3, {shift}).toJSON(),
        "workspace-screen-project": Shortcut.of(Key.Digit4, {shift}).toJSON(),
        "workspace-screen-shadertoy": Shortcut.of(Key.Digit5, {shift}).toJSON(),
        "workspace-screen-modulation": Shortcut.of(Key.Digit6, {shift}).toJSON(),
        "toggle-loop": Shortcut.of(Key.KeyK).toJSON()
    }
})

describe("ShortcutStorage", () => {
    it("stores only shortcuts that differ from the factory", () => {
        const contexts = createContexts()
        working(contexts, "toggle-loop").overrideWith(Shortcut.of(Key.KeyK))
        const {items, store} = createStore()
        ShortcutStorage.store(contexts, store)
        expect(JSON.parse(items.get(ShortcutStorage.StorageKey)!)).toEqual({
            global: {"toggle-loop": Shortcut.of(Key.KeyK).toJSON()}
        })
    })

    it("follows a changed factory default after a round trip", () => {
        const before = createContexts()
        working(before, "toggle-loop").overrideWith(Shortcut.of(Key.KeyK))
        const {store} = createStore()
        ShortcutStorage.store(before, store)
        const after = createContexts()
        after.global.factory["workspace-screen-piano"].shortcut.overrideWith(Shortcut.of(Key.Digit8, {shift}))
        after.global.workingDefinition["workspace-screen-piano"].shortcut.overrideWith(Shortcut.of(Key.Digit8, {shift}))
        expect(ShortcutStorage.load(after, store)).toBe(true)
        expect(working(after, "workspace-screen-piano").equals(Shortcut.of(Key.Digit8, {shift}))).toBe(true)
        expect(working(after, "toggle-loop").equals(Shortcut.of(Key.KeyK))).toBe(true)
    })

    it("migrates a legacy snapshot: drops the moved screen keys, keeps custom ones, rewrites as diff", () => {
        const contexts = createContexts()
        const {items, store} = createStore({[ShortcutStorage.LegacyStorageKey]: legacySnapshot})
        expect(ShortcutStorage.load(contexts, store)).toBe(true)
        expect(working(contexts, "workspace-screen-modulation").equals(Shortcut.of(Key.Digit3, {shift}))).toBe(true)
        expect(working(contexts, "workspace-screen-piano").equals(Shortcut.of(Key.Digit4, {shift}))).toBe(true)
        expect(working(contexts, "workspace-screen-project").equals(Shortcut.of(Key.Digit5, {shift}))).toBe(true)
        expect(working(contexts, "workspace-screen-shadertoy").equals(Shortcut.of(Key.Digit6, {shift}))).toBe(true)
        expect(working(contexts, "toggle-loop").equals(Shortcut.of(Key.KeyK))).toBe(true)
        expect(items.has(ShortcutStorage.LegacyStorageKey)).toBe(false)
        expect(JSON.parse(items.get(ShortcutStorage.StorageKey)!)).toEqual({
            global: {"toggle-loop": Shortcut.of(Key.KeyK).toJSON()}
        })
    })

    it("prefers the new key and still removes a leftover legacy snapshot", () => {
        const contexts = createContexts()
        const {items, store} = createStore({
            [ShortcutStorage.StorageKey]: JSON.stringify({global: {}}),
            [ShortcutStorage.LegacyStorageKey]: legacySnapshot
        })
        expect(ShortcutStorage.load(contexts, store)).toBe(true)
        expect(working(contexts, "toggle-loop").equals(Shortcut.of(Key.KeyL))).toBe(true)
        expect(items.has(ShortcutStorage.LegacyStorageKey)).toBe(false)
    })

    it("does nothing without stored shortcuts and survives broken JSON", () => {
        expect(ShortcutStorage.load(createContexts(), createStore().store)).toBe(false)
        const contexts = createContexts()
        const {store} = createStore({[ShortcutStorage.StorageKey]: "{broken"})
        const {warn} = console
        console.warn = () => {}
        expect(ShortcutStorage.load(contexts, store)).toBe(false)
        console.warn = warn
        expect(working(contexts, "toggle-loop").equals(Shortcut.of(Key.KeyL))).toBe(true)
    })
})
