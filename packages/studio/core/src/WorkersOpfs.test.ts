import {describe, expect, it, vi} from "vitest"
import type {OpfsProtocol} from "@opendaw/lib-fusion"

// A host with its own file storage (the desktop app) installs it before anything touches Workers.Opfs.
// Without an installed protocol, Workers.Opfs stays the OPFS worker exactly as before.
const freshWorkers = async () => {
    vi.resetModules()
    return (await import("./Workers")).Workers
}

const memoryOpfs = (): OpfsProtocol => ({
    write: async () => {},
    read: async () => new Uint8Array(0),
    exists: async () => false,
    delete: async () => {},
    list: async () => [],
    isAvailable: async () => true
})

describe("Workers.Opfs", () => {
    it("is the OPFS worker and needs installed workers when nothing was installed", async () => {
        const Workers = await freshWorkers()
        expect(() => Workers.Opfs).toThrow(/Workers are not installed/)
    })
    it("is the installed protocol when installed before first use", async () => {
        const Workers = await freshWorkers()
        const protocol = memoryOpfs()
        Workers.installOpfs(protocol)
        expect(Workers.Opfs).toBe(protocol)
        expect(Workers.Opfs).toBe(protocol)
    })
    it("refuses an installation after first use", async () => {
        const Workers = await freshWorkers()
        Workers.installOpfs(memoryOpfs())
        void Workers.Opfs
        expect(() => Workers.installOpfs(memoryOpfs())).toThrow()
    })
})
