import {beforeEach, describe, expect, it} from "vitest"
import {Errors, Progress, RuntimeNotification, RuntimeNotifier, UUID} from "@opendaw/lib-std"
import {CloudHandler} from "./CloudHandler"
import {CloudBackupScripts} from "./CloudBackupScripts"
import {ScriptMeta, ScriptPaths, ScriptStorage} from "../scripts"
import {FakeFiles} from "../scripts/FakeFiles.test-helper"

// In-memory cloud: flat path map, records every approve request so tests can assert on prompts
class FakeCloud implements CloudHandler {
    readonly store = new Map<string, ArrayBuffer>()
    readonly uploads: Array<string> = []
    async upload(path: string, data: ArrayBuffer): Promise<void> {
        this.uploads.push(path)
        this.store.set(path, data)
    }
    async exists(path: string): Promise<boolean> {return this.store.has(path)}
    async download(path: string): Promise<ArrayBuffer> {
        const data = this.store.get(path)
        if (data === undefined) {throw new Errors.FileNotFound(path)}
        return data
    }
    async list(): Promise<string[]> {return Array.from(this.store.keys())}
    async delete(path: string): Promise<void> {
        Array.from(this.store.keys()).filter(key => key.startsWith(path)).forEach(key => this.store.delete(key))
    }
    async alive(): Promise<void> {}
    catalog(): Record<string, ScriptMeta> {
        const data = this.store.get(CloudBackupScripts.RemoteCatalogPath)
        return data === undefined ? {} : JSON.parse(new TextDecoder().decode(data))
    }
    source(uuid: UUID.String): string {
        return new TextDecoder().decode(this.store.get(`${CloudBackupScripts.folderFor(uuid)}/${ScriptPaths.ScriptFile}`))
    }
}

const prompts: Array<RuntimeNotification.ApproveRequest> = []
const answer = {value: true}
RuntimeNotifier.install({
    info: async () => {},
    approve: async request => {
        prompts.push(request)
        return answer.value
    },
    progress: () => ({message: "", terminate: () => {}}),
    notify: () => {}
})

const stockId = UUID.toString(UUID.generate())
const stock = {uuid: stockId, name: "Starter", description: "shipped", source: "// shipped v1"}

const machine = async (seed: boolean = true) => {
    const storage = new ScriptStorage(new FakeFiles())
    if (seed) {await storage.syncStock([stock])}
    return storage
}

const sync = (cloud: FakeCloud, storage: ScriptStorage) =>
    CloudBackupScripts.start(cloud, Progress.Empty, () => {}, storage)

describe("CloudBackupScripts", () => {
    beforeEach(() => {
        prompts.length = 0
        answer.value = true
    })

    it("does not upload an untouched stock example", async () => {
        const cloud = new FakeCloud()
        await sync(cloud, await machine())
        expect(cloud.uploads).toHaveLength(0)
        expect(cloud.catalog()).toEqual({})
    })

    it("uploads a stock example once it was edited", async () => {
        const cloud = new FakeCloud()
        const storage = await machine()
        const uuid = UUID.parse(stockId)
        const meta = await storage.loadMeta(uuid)
        await storage.save(uuid, Object.assign(ScriptMeta.copy(meta), {modified: new Date().toISOString()}), "// my edit")
        await sync(cloud, storage)
        expect(cloud.source(stockId)).toBe("// my edit")
        expect(cloud.catalog()[stockId].stock).toBe(meta.stock)
    })

    it("asks to override the untouched stock copy on another machine, even though it was seeded later", async () => {
        const cloud = new FakeCloud()
        const machineA = await machine()
        const uuid = UUID.parse(stockId)
        const metaA = await stockMeta(machineA)
        await machineA.save(uuid, Object.assign(ScriptMeta.copy(metaA), {modified: "2020-01-01T00:00:00.000Z"}), "// edited on A")
        await sync(cloud, machineA)
        const machineB = await machine()
        await sync(cloud, machineB)
        expect(prompts).toHaveLength(1)
        expect(prompts[0].headline).toBe("Override Scripts?")
        expect(prompts[0].message).toContain("Starter")
        expect(await machineB.loadSource(uuid)).toBe("// edited on A")
    })

    it("keeps the local stock copy when the override is declined", async () => {
        const cloud = new FakeCloud()
        const machineA = await machine()
        const uuid = UUID.parse(stockId)
        const metaA = await stockMeta(machineA)
        await machineA.save(uuid, Object.assign(ScriptMeta.copy(metaA), {modified: "2020-01-01T00:00:00.000Z"}), "// edited on A")
        await sync(cloud, machineA)
        const machineB = await machine()
        answer.value = false
        await sync(cloud, machineB)
        expect(prompts).toHaveLength(1)
        expect(await machineB.loadSource(uuid)).toBe("// shipped v1")
    })

    it("does not prompt for an untouched stock example that is absent from the cloud", async () => {
        const cloud = new FakeCloud()
        await sync(cloud, await machine())
        await sync(cloud, await machine())
        expect(prompts).toHaveLength(0)
    })

    it("downloads the edited stock example when the other machine deleted its copy", async () => {
        const cloud = new FakeCloud()
        const machineA = await machine()
        const uuid = UUID.parse(stockId)
        const metaA = await stockMeta(machineA)
        await machineA.save(uuid, Object.assign(ScriptMeta.copy(metaA), {modified: new Date().toISOString()}), "// edited on A")
        await sync(cloud, machineA)
        const machineB = await machine(false)
        await sync(cloud, machineB)
        expect(prompts).toHaveLength(0)
        expect(await machineB.loadSource(uuid)).toBe("// edited on A")
    })

    it("still uses timestamps for user scripts", async () => {
        const cloud = new FakeCloud()
        const uuid = UUID.generate()
        const machineA = await machine()
        await machineA.save(uuid, Object.assign(ScriptMeta.init("Mine"), {modified: "2021-01-01T00:00:00.000Z"}), "// A")
        await sync(cloud, machineA)
        const machineB = await machine()
        await machineB.save(uuid, Object.assign(ScriptMeta.init("Mine"), {modified: "2022-01-01T00:00:00.000Z"}), "// B")
        await sync(cloud, machineB)
        expect(prompts).toHaveLength(0)
        expect(cloud.source(UUID.toString(uuid))).toBe("// B")
    })
})

const stockMeta = (storage: ScriptStorage): Promise<ScriptMeta> => storage.loadMeta(UUID.parse(stockId))
