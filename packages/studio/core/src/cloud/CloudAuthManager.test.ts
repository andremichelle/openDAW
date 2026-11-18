import {describe, expect, it} from "vitest"
import {Errors} from "@opendaw/lib-std"
import {CloudAuthManager} from "./CloudAuthManager"
import {CloudHandler} from "./CloudHandler"

const ClientIds = {Dropbox: "dropbox", GoogleDrive: "google"}

const stubHandler = (alive: () => Promise<void> = () => Promise.resolve()): CloudHandler => ({
    alive,
    upload: () => Promise.resolve(),
    exists: () => Promise.resolve(false),
    download: () => Promise.reject(new Errors.FileNotFound("")),
    list: () => Promise.resolve([]),
    delete: () => Promise.resolve()
})

describe("CloudAuthManager custom server", () => {
    it("rejects without a connector", async () => {
        await expect(CloudAuthManager.create(ClientIds).getHandler("CustomServer"))
            .rejects.toThrow("No custom server connector")
    })

    it("connects once and reuses the handler", async () => {
        let calls = 0
        const handler = stubHandler()
        const manager = CloudAuthManager.create(ClientIds, async () => {calls++; return handler})
        expect(await manager.getHandler("CustomServer")).toBe(handler)
        expect(await manager.getHandler("CustomServer")).toBe(handler)
        expect(calls).toBe(1)
    })

    it("asks again after a cancelled connect", async () => {
        let calls = 0
        const handler = stubHandler()
        const manager = CloudAuthManager.create(ClientIds, async () => {
            calls++
            return calls === 1 ? Promise.reject(Errors.AbortError) : handler
        })
        const first = await manager.getHandler("CustomServer").then(() => "resolved", error => error)
        expect(Errors.isAbort(first)).toBe(true)
        expect(await manager.getHandler("CustomServer")).toBe(handler)
        expect(calls).toBe(2)
    })

    it("asks again when the handler is no longer alive", async () => {
        let calls = 0
        let reachable = true
        const handler = stubHandler(() => reachable ? Promise.resolve() : Promise.reject(new Error("gone")))
        const manager = CloudAuthManager.create(ClientIds, async () => {calls++; return handler})
        await manager.getHandler("CustomServer")
        reachable = false
        await expect(manager.getHandler("CustomServer")).rejects.toThrow("gone")
        reachable = true
        await manager.getHandler("CustomServer")
        expect(calls).toBe(2)
    })

    it("asks again after forget", async () => {
        let calls = 0
        const manager = CloudAuthManager.create(ClientIds, async () => {calls++; return stubHandler()})
        await manager.getHandler("CustomServer")
        manager.forget("CustomServer")
        await manager.getHandler("CustomServer")
        expect(calls).toBe(2)
    })
})

