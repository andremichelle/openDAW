import {describe, expect, it, vi} from "vitest"
import {PresenceService} from "./PresenceService"
import {PresenceData} from "./types"

const makePresence = (identity: string, overrides?: Partial<PresenceData>): PresenceData => ({
    identity,
    displayName: overrides?.displayName ?? identity,
    color: overrides?.color ?? "#FF6B6B",
    cursorX: overrides?.cursorX ?? 0,
    cursorY: overrides?.cursorY ?? 0,
    cursorTarget: overrides?.cursorTarget ?? "",
})

describe("PresenceService", () => {
    it("starts with empty participants", () => {
        const service = new PresenceService()
        expect(service.participants).toEqual([])
    })
    it("adds a participant and notifies", () => {
        const service = new PresenceService()
        const spy = vi.fn()
        service.onChange.subscribe(spy)
        service.updatePresence(makePresence("user-1", {displayName: "Alice"}))
        expect(service.participants).toHaveLength(1)
        expect(service.participants[0].displayName).toBe("Alice")
        expect(spy).toHaveBeenCalled()
    })
    it("tracks multiple participants simultaneously", () => {
        const service = new PresenceService()
        service.updatePresence(makePresence("user-1", {displayName: "Alice"}))
        service.updatePresence(makePresence("user-2", {displayName: "Bob"}))
        service.updatePresence(makePresence("user-3", {displayName: "Carol"}))
        expect(service.participants).toHaveLength(3)
        const names = service.participants.map(participant => participant.displayName)
        expect(names).toContain("Alice")
        expect(names).toContain("Bob")
        expect(names).toContain("Carol")
    })
    it("updates existing participant keyed by identity", () => {
        const service = new PresenceService()
        service.updatePresence(makePresence("user-1", {cursorX: 100, cursorY: 200}))
        service.updatePresence(makePresence("user-1", {cursorX: 300, cursorY: 400, cursorTarget: "track-2"}))
        expect(service.participants).toHaveLength(1)
        expect(service.participants[0].cursorX).toBe(300)
        expect(service.participants[0].cursorY).toBe(400)
    })
    it("removes a participant", () => {
        const service = new PresenceService()
        service.updatePresence(makePresence("user-1"))
        service.removeParticipant("user-1")
        expect(service.participants).toEqual([])
    })
    it("removeParticipant on non-existent is no-op", () => {
        const service = new PresenceService()
        const spy = vi.fn()
        service.onChange.subscribe(spy)
        service.removeParticipant("ghost")
        expect(spy).not.toHaveBeenCalled()
    })
    it("removeParticipant notifies onChange", () => {
        const service = new PresenceService()
        service.updatePresence(makePresence("user-1"))
        const spy = vi.fn()
        service.onChange.subscribe(spy)
        service.removeParticipant("user-1")
        expect(spy).toHaveBeenCalledTimes(1)
    })
    it("clear notifies onChange", () => {
        const service = new PresenceService()
        service.updatePresence(makePresence("user-1"))
        service.updatePresence(makePresence("user-2"))
        const spy = vi.fn()
        service.onChange.subscribe(spy)
        service.clear()
        expect(spy).toHaveBeenCalledTimes(1)
        expect(service.participants).toEqual([])
    })
    it("rapid sequential updates maintain consistency", () => {
        const service = new PresenceService()
        for (let index = 0; index < 100; index++) {
            service.updatePresence(makePresence("user-1", {cursorX: index}))
        }
        expect(service.participants).toHaveLength(1)
        expect(service.participants[0].cursorX).toBe(99)
    })
    it("terminate removes existing subscribers from onChange", () => {
        const service = new PresenceService()
        const spy = vi.fn()
        service.onChange.subscribe(spy)
        service.updatePresence(makePresence("user-1"))
        expect(spy).toHaveBeenCalledTimes(1)
        service.terminate()
        service.updatePresence(makePresence("user-2"))
        expect(spy).toHaveBeenCalledTimes(1)
    })
    it("cleans up on terminate", () => {
        const service = new PresenceService()
        service.updatePresence(makePresence("user-1"))
        service.terminate()
        expect(service.participants).toEqual([])
    })
})
