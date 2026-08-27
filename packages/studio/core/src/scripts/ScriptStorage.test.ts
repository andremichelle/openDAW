import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {OpfsProtocol} from "@opendaw/lib-fusion"
import {ScriptFiles, ScriptStorage, StockScript} from "./ScriptStorage"
import {ScriptPaths} from "./ScriptPaths"
import {ScriptMeta} from "./ScriptMeta"

// In-memory stand-in for the OPFS worker: flat path map, folders are implied by their files
class FakeFiles implements ScriptFiles {
    readonly store = new Map<string, Uint8Array>()
    async read(path: string): Promise<Uint8Array> {
        const bytes = this.store.get(path)
        if (bytes === undefined) {throw new Error(`Not found: ${path}`)}
        return bytes
    }
    async write(path: string, data: Uint8Array): Promise<void> {this.store.set(path, data)}
    async delete(path: string): Promise<void> {
        Array.from(this.store.keys()).filter(key => key === path || key.startsWith(`${path}/`))
            .forEach(key => this.store.delete(key))
    }
    async list(path: string): Promise<ReadonlyArray<OpfsProtocol.Entry>> {
        const names = new Map<string, OpfsProtocol.Kind>()
        Array.from(this.store.keys()).filter(key => key.startsWith(`${path}/`)).forEach(key => {
            const rest = key.substring(path.length + 1)
            const slash = rest.indexOf("/")
            if (slash === -1) {names.set(rest, "file")} else {names.set(rest.substring(0, slash), "directory")}
        })
        return Array.from(names.entries()).map(([name, kind]) => ({name, kind}))
    }
}

const setup = () => {
    const files = new FakeFiles()
    return {files, storage: new ScriptStorage(files)}
}

const stock = (name: string, source: string, uuid: UUID.String = UUID.toString(UUID.generate())): StockScript =>
    ({uuid, name, description: `${name} description`, source})

describe("ScriptStorage", () => {
    it("starts empty and lists saved scripts", async () => {
        const {storage} = setup()
        expect(await storage.list()).toHaveLength(0)
        const uuid = UUID.generate()
        const meta = ScriptMeta.init("Hello", "world")
        await storage.save(uuid, meta, "const a = 1")
        const list = await storage.list()
        expect(list).toHaveLength(1)
        expect(UUID.equals(list[0].uuid, uuid)).toBe(true)
        expect(list[0].meta.name).toBe("Hello")
        expect(list[0].meta.description).toBe("world")
        expect(await storage.loadSource(uuid)).toBe("const a = 1")
        expect(await storage.exists(uuid)).toBe(true)
    })

    it("ignores folders that are not uuids or lack a meta file", async () => {
        const {files, storage} = setup()
        await files.write(`${ScriptPaths.Folder}/not-a-uuid/script.ts`, new Uint8Array(1))
        const orphan = UUID.generate()
        await files.write(ScriptPaths.scriptFile(orphan), new Uint8Array(1))
        expect(await storage.list()).toHaveLength(0)
        expect(await storage.exists(orphan)).toBe(false)
    })

    it("updates meta without touching the source", async () => {
        const {storage} = setup()
        const uuid = UUID.generate()
        await storage.save(uuid, ScriptMeta.init("A"), "source")
        await storage.saveMeta(uuid, Object.assign(await storage.loadMeta(uuid), {name: "B", description: "desc"}))
        expect((await storage.loadMeta(uuid)).name).toBe("B")
        expect((await storage.loadMeta(uuid)).description).toBe("desc")
        expect(await storage.loadSource(uuid)).toBe("source")
    })

    it("deletes with a tombstone", async () => {
        const {storage} = setup()
        const uuid = UUID.generate()
        await storage.save(uuid, ScriptMeta.init("A"), "source")
        await storage.delete(uuid)
        expect(await storage.list()).toHaveLength(0)
        expect(await storage.exists(uuid)).toBe(false)
        expect(await storage.loadTrashedIds()).toEqual([UUID.toString(uuid)])
        await storage.delete(uuid)
        expect(await storage.loadTrashedIds()).toHaveLength(1)
    })

    it("meta survives unknown or missing fields", () => {
        expect(ScriptMeta.fromJSON(null).name).toBe("Untitled")
        expect(ScriptMeta.fromJSON([]).name).toBe("Untitled")
        const meta = ScriptMeta.fromJSON({name: "X"})
        expect(meta.name).toBe("X")
        expect(meta.description).toBe("")
        expect(typeof meta.created).toBe("string")
    })

    it("hash is stable and content sensitive", () => {
        expect(ScriptStorage.hash("abc")).toBe(ScriptStorage.hash("abc"))
        expect(ScriptStorage.hash("abc")).not.toBe(ScriptStorage.hash("abd"))
        expect(ScriptStorage.hash("")).toBe("811c9dc5")
    })

    describe("stock scripts", () => {
        it("seeds stock scripts with their hash", async () => {
            const {storage} = setup()
            const script = stock("Starter", "// v1")
            await storage.syncStock([script])
            const list = await storage.list()
            expect(list).toHaveLength(1)
            expect(list[0].meta.name).toBe("Starter")
            expect(list[0].meta.description).toBe("Starter description")
            expect(list[0].meta.stock).toBe(ScriptStorage.hash("// v1"))
            expect(await storage.loadSource(UUID.parse(script.uuid))).toBe("// v1")
        })

        it("leaves an unchanged stock script alone, including user edits to it", async () => {
            const {storage} = setup()
            const script = stock("Starter", "// v1")
            await storage.syncStock([script])
            const uuid = UUID.parse(script.uuid)
            const meta = await storage.loadMeta(uuid)
            await storage.save(uuid, Object.assign(meta, {name: "Mine"}), "// edited")
            await storage.syncStock([script])
            expect(await storage.loadSource(uuid)).toBe("// edited")
            expect((await storage.loadMeta(uuid)).name).toBe("Mine")
        })

        it("a newer stock version overrides the stored copy", async () => {
            const {storage} = setup()
            const v1 = stock("Starter", "// v1")
            await storage.syncStock([v1])
            const uuid = UUID.parse(v1.uuid)
            const created = (await storage.loadMeta(uuid)).created
            await storage.save(uuid, Object.assign(await storage.loadMeta(uuid), {name: "Mine"}), "// edited")
            const v2: StockScript = {...v1, name: "Starter 2", source: "// v2"}
            await storage.syncStock([v2])
            const meta = await storage.loadMeta(uuid)
            expect(await storage.loadSource(uuid)).toBe("// v2")
            expect(meta.name).toBe("Starter 2")
            expect(meta.stock).toBe(ScriptStorage.hash("// v2"))
            expect(meta.created).toBe(created)
        })

        it("a deleted stock script does not come back, even in a newer version", async () => {
            const {storage} = setup()
            const v1 = stock("Starter", "// v1")
            await storage.syncStock([v1])
            await storage.delete(UUID.parse(v1.uuid))
            await storage.syncStock([{...v1, source: "// v2"}])
            expect(await storage.list()).toHaveLength(0)
        })

        it("stock scripts live next to user scripts", async () => {
            const {storage} = setup()
            const own = UUID.generate()
            await storage.save(own, ScriptMeta.init("Own"), "// own")
            await storage.syncStock([stock("A", "// a"), stock("B", "// b")])
            const names = (await storage.list()).map(({meta}) => meta.name).sort()
            expect(names).toEqual(["A", "B", "Own"])
        })
    })
})
