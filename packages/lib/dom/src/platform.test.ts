import {afterEach, describe, expect, it, vi} from "vitest"
import {Nullable, Option} from "@opendaw/lib-std"

// Platform must behave exactly like the browser code it replaced until a desktop shell installs its own
// strategies. Each test imports a fresh module instance, because install() mutates module state.
// Browser caches whether a location exists at module load, so the host is stubbed before importing.
const freshPlatform = async (host: string = "opendaw.studio") => {
    vi.stubGlobal("location", {host})
    vi.stubGlobal("self", {location: {host}})
    vi.resetModules()
    return (await import("./platform")).Platform
}

const memoryStore = (): Storage => {
    const entries = new Map<string, string>()
    return {
        get length() {return entries.size},
        clear: () => entries.clear(),
        key: (index: number) => Array.from(entries.keys())[index] ?? null,
        getItem: (key: string) => entries.get(key) ?? null,
        setItem: (key: string, value: string) => {entries.set(key, value)},
        removeItem: (key: string) => {entries.delete(key)}
    }
}

describe("Platform browser defaults", () => {
    afterEach(() => vi.unstubAllGlobals())
    it("isDevelopment is true exactly when the host contains localhost", async () => {
        const Platform = await freshPlatform("localhost:8080")
        expect(Platform.isDevelopment()).toBe(true)
        vi.stubGlobal("location", {host: "opendaw.studio"})
        expect(Platform.isDevelopment()).toBe(false)
        vi.stubGlobal("location", {host: "dev.opendaw.studio"})
        expect(Platform.isDevelopment()).toBe(false)
    })
    it("storage is the global localStorage, resolved at call time", async () => {
        const Platform = await freshPlatform()
        const first = memoryStore()
        vi.stubGlobal("localStorage", first)
        expect(Platform.hasStorage()).toBe(true)
        expect(Platform.storage()).toBe(first)
        const second = memoryStore()
        vi.stubGlobal("localStorage", second)
        expect(Platform.storage()).toBe(second)
    })
    it("hasStorage is false where no localStorage exists (workers, node)", async () => {
        const Platform = await freshPlatform()
        vi.stubGlobal("localStorage", undefined)
        expect(Platform.hasStorage()).toBe(false)
    })
    it("reads and writes go to localStorage", async () => {
        const Platform = await freshPlatform()
        const store = memoryStore()
        vi.stubGlobal("localStorage", store)
        Platform.storage().setItem("key", "value")
        expect(store.getItem("key")).toBe("value")
        Platform.storage().removeItem("key")
        expect(store.getItem("key")).toBeNull()
    })
})

describe("Platform.install", () => {
    afterEach(() => vi.unstubAllGlobals())
    it("replaces only the given strategies", async () => {
        const Platform = await freshPlatform("localhost:8080")
        vi.stubGlobal("localStorage", memoryStore())
        const desktopStore = memoryStore()
        Platform.install({storage: () => desktopStore})
        expect(Platform.storage()).toBe(desktopStore)
        expect(Platform.isDevelopment()).toBe(true)
        expect(Platform.hasStorage()).toBe(true)
    })
    it("an installed isDevelopment ignores the host", async () => {
        const Platform = await freshPlatform("localhost:8080")
        Platform.install({isDevelopment: () => false})
        expect(Platform.isDevelopment()).toBe(false)
    })
})

describe("Platform files", () => {
    afterEach(() => vi.unstubAllGlobals())
    const freshFiles = async () => {
        await freshPlatform()
        const {Files} = await import("./files")
        const {Platform} = await import("./platform")
        return {Files, Platform}
    }
    it("browser canSaveStream follows the presence of showSaveFilePicker", async () => {
        const {Files} = await freshFiles()
        vi.stubGlobal("window", {})
        expect(Files.canSaveStream()).toBe(false)
        vi.stubGlobal("window", {showSaveFilePicker: vi.fn()})
        expect(Files.canSaveStream()).toBe(true)
    })
    it("browser saveStream is no target when the picker rejects", async () => {
        const {Files} = await freshFiles()
        vi.stubGlobal("window", {showSaveFilePicker: vi.fn(() => Promise.reject(new DOMException("cancel", "AbortError")))})
        expect((await Files.saveStream({suggestedName: "x.mp4"})).isEmpty()).toBe(true)
    })
    it("browser saveStream wraps the writable of the picked file", async () => {
        const {Files} = await freshFiles()
        const writable = new WritableStream()
        vi.stubGlobal("window", {showSaveFilePicker: vi.fn(async () => ({createWritable: async () => writable}))})
        expect((await Files.saveStream({suggestedName: "x.mp4"})).unwrap()).toBe(writable)
    })
    it("browser saveStream rejects when the writable cannot be created", async () => {
        const {Files} = await freshFiles()
        const failure = new Error("disk full")
        vi.stubGlobal("window", {showSaveFilePicker: vi.fn(async () => ({createWritable: () => Promise.reject(failure)}))})
        await expect(Files.saveStream({suggestedName: "x.mp4"})).rejects.toBe(failure)
    })
    it("Files delegates to installed strategies", async () => {
        const {Files, Platform} = await freshFiles()
        const file = new File(["x"], "x.txt")
        const writable = new WritableStream()
        const saveFile = vi.fn(async () => "saved.od")
        const openFiles = vi.fn(async () => [file])
        Platform.install({
            saveFile, openFiles,
            canSaveStream: () => true,
            saveStream: async () => Option.wrap(writable)
        })
        const buffer = new ArrayBuffer(4)
        expect(await Files.save(buffer, {suggestedName: "saved.od"})).toBe("saved.od")
        expect(saveFile).toHaveBeenCalledWith(buffer, {suggestedName: "saved.od"})
        expect(await Files.open({multiple: true})).toEqual([file])
        expect(openFiles).toHaveBeenCalledWith({multiple: true})
        expect(Files.canSaveStream()).toBe(true)
        expect((await Files.saveStream({suggestedName: "x.mp4"})).unwrap()).toBe(writable)
    })
    it("the one-picker-at-a-time guard applies to installed pickers", async () => {
        const {Files, Platform} = await freshFiles()
        const {promise, resolve} = Promise.withResolvers<ReadonlyArray<File>>()
        const openFiles = vi.fn(() => promise)
        Platform.install({openFiles})
        const first = Files.open()
        await expect(Files.open()).rejects.toBeDefined()
        expect(openFiles).toHaveBeenCalledTimes(1)
        resolve([])
        expect(await first).toEqual([])
    })
})

describe("Platform clipboard and fullscreen", () => {
    afterEach(() => vi.unstubAllGlobals())
    const fresh = async () => {
        await freshPlatform()
        const {Clipboard} = await import("./clipboard")
        const {Fullscreen} = await import("./fullscreen")
        const {Platform} = await import("./platform")
        return {Clipboard, Fullscreen, Platform}
    }
    it("browser clipboard uses navigator.clipboard, resolved at call time", async () => {
        const {Clipboard} = await fresh()
        const writeText = vi.fn(async () => {})
        const readText = vi.fn(async () => "pasted")
        vi.stubGlobal("navigator", {clipboard: {writeText, readText}})
        await Clipboard.writeText("copied")
        expect(writeText).toHaveBeenCalledWith("copied")
        expect(await Clipboard.readText()).toBe("pasted")
    })
    it("Clipboard uses an installed strategy", async () => {
        const {Clipboard, Platform} = await fresh()
        vi.stubGlobal("navigator", {})
        const written: Array<string> = []
        Platform.install({
            writeClipboardText: async (text: string) => {written.push(text)},
            readClipboardText: async () => "native"
        })
        await Clipboard.writeText("copied")
        expect(written).toEqual(["copied"])
        expect(await Clipboard.readText()).toBe("native")
    })
    it("Fullscreen uses installed strategies for request and exit", async () => {
        const {Fullscreen, Platform} = await fresh()
        const element = {ownerDocument: {}} as unknown as Element
        const state: { active: Nullable<Element> } = {active: null}
        Platform.install({
            isFullscreenAvailable: () => true,
            requestFullscreen: async (target: Element) => {state.active = target},
            fullscreenElement: () => state.active,
            exitFullscreen: async () => {state.active = null}
        })
        expect(await Fullscreen.toggle(element)).toBe(true)
        expect(state.active).toBe(element)
        expect(await Fullscreen.toggle(element)).toBe(false)
        expect(state.active).toBeNull()
    })
})

describe("Platform lifecycle", () => {
    afterEach(() => vi.unstubAllGlobals())
    const beforeUnload = () => {
        const listeners: Array<(event: Event) => void> = []
        vi.stubGlobal("window", {
            addEventListener: (type: string, listener: (event: Event) => void) => {
                if (type === "beforeunload") {listeners.push(listener)}
            },
            alert: vi.fn()
        })
        return (): boolean => {
            const event = new Event("beforeunload", {cancelable: true})
            listeners.forEach(listener => listener(event))
            return event.defaultPrevented
        }
    }
    it("browser guardClose prompts for unsaved work", async () => {
        const Platform = await freshPlatform()
        const unload = beforeUnload()
        vi.stubGlobal("navigator", {onLine: true})
        const state = {unsaved: false}
        Platform.guardClose(() => state.unsaved)
        expect(unload()).toBe(false)
        state.unsaved = true
        expect(unload()).toBe(true)
    })
    it("browser guardClose prompts when offline, saved or not", async () => {
        const Platform = await freshPlatform()
        const unload = beforeUnload()
        vi.stubGlobal("navigator", {onLine: false})
        Platform.guardClose(() => false)
        expect(unload()).toBe(true)
    })
    it("browser alert and reload use window.alert and location.reload", async () => {
        const Platform = await freshPlatform()
        beforeUnload()
        const reload = vi.fn()
        vi.stubGlobal("location", {host: "opendaw.studio", reload})
        Platform.alert("message")
        expect(window.alert).toHaveBeenCalledWith("message")
        Platform.reload()
        expect(reload).toHaveBeenCalledTimes(1)
    })
    it("installed lifecycle strategies replace the browser ones", async () => {
        const Platform = await freshPlatform()
        const unload = beforeUnload()
        const calls: Array<string> = []
        Platform.install({
            alert: (message: string) => calls.push(`alert:${message}`),
            reload: () => calls.push("reload"),
            guardClose: () => calls.push("guard")
        })
        Platform.alert("message")
        Platform.reload()
        Platform.guardClose(() => true)
        expect(calls).toEqual(["alert:message", "reload", "guard"])
        expect(unload()).toBe(false)
        expect(window.alert).not.toHaveBeenCalled()
    })
})
