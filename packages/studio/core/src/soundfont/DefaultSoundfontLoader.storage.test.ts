import {afterEach, beforeEach, describe, expect, it, vi} from "vitest"
import {isDefined, UUID} from "@opendaw/lib-std"
import {SoundfontLoaderState, SoundfontMetaData} from "@opendaw/studio-adapters"
import {ExternalLib} from "../ExternalLib"
import {SoundfontStorage} from "./SoundfontStorage"
import {GlobalSoundfontLoaderManager} from "./GlobalSoundfontLoaderManager"
import {DefaultSoundfontLoader} from "./DefaultSoundfontLoader"

// Riffle (20 Nov 2026): a fetched soundfont ended in error because its cache write failed
const meta: SoundfontMetaData = {name: "Piano", size: 4, url: "", license: "", origin: "openDAW"}
type FakeBank = { readonly bytes: Uint8Array }

const settled = (manager: GlobalSoundfontLoaderManager, uuid: UUID.Bytes): Promise<SoundfontLoaderState> => {
    const loader = manager.getOrCreate(uuid)
    return new Promise(resolve => {
        const check = (state: SoundfontLoaderState) => {
            if (state.type === "loaded" || state.type === "error") {resolve(state)}
        }
        check(loader.state)
        loader.subscribe(check)
    })
}

describe("DefaultSoundfontLoader when the cache write fails", () => {
    let saveError: unknown = null
    beforeEach(() => {
        saveError = null
        vi.spyOn(console, "warn").mockImplementation(() => {})
        const reader = (bytes: ArrayBuffer) => ({bytes: new Uint8Array(bytes)})
        vi.spyOn(ExternalLib, "Soundfont").mockImplementation(async () =>
            ({status: "resolved", value: reader}) as unknown as Awaited<ReturnType<typeof ExternalLib.Soundfont>>)
        vi.spyOn(SoundfontStorage, "get").mockReturnValue({
            load: async () => {throw new DOMException("not stored", "NotFoundError")},
            save: async () => {if (isDefined(saveError)) {throw saveError}}
        } as unknown as SoundfontStorage)
    })
    afterEach(() => vi.restoreAllMocks())

    it("keeps a fetched soundfont loaded when the disk is full", async () => {
        saveError = new DOMException("No space available for this operation", "QuotaExceededError")
        const file = new Uint8Array([1, 2, 3, 4]).buffer
        const manager = new GlobalSoundfontLoaderManager({fetch: async () => [file, meta]})
        const uuid = UUID.generate()
        expect((await settled(manager, uuid)).type).toBe("loaded")
        const loader = manager.getOrCreate(uuid) as DefaultSoundfontLoader
        expect(loader.meta.unwrap()).toEqual(meta)
        expect(Array.from((loader.soundfont.unwrap() as unknown as FakeBank).bytes)).toEqual([1, 2, 3, 4])
        expect(loader.file.unwrap()).toBe(file)
    })

    it("keeps no second copy of a soundfont that was stored", async () => {
        const manager = new GlobalSoundfontLoaderManager({fetch: async () => [new Uint8Array(4).buffer, meta]})
        const uuid = UUID.generate()
        expect((await settled(manager, uuid)).type).toBe("loaded")
        expect((manager.getOrCreate(uuid) as DefaultSoundfontLoader).file.isEmpty()).toBe(true)
    })

    it("keeps the original error as cause when the fetch fails", async () => {
        const error = new TypeError("Failed to fetch")
        const manager = new GlobalSoundfontLoaderManager({fetch: async () => {throw error}})
        expect(await settled(manager, UUID.generate())).toEqual({type: "error", reason: "Failed to fetch", cause: error})
    })
})
