import {describe, expect, it, vi} from "vitest"
import {PresenceService} from "./PresenceService"

describe("PresenceService", () => {
    it("starts with empty participants", () => {
        const service = new PresenceService()
        expect(service.participants).toEqual([])
    })
    it("adds a participant and notifies", () => {
        const service = new PresenceService()
        const spy = vi.fn()
        service.onChange.subscribe(spy)
        service.updatePresence({
            identity: "user-1",
            displayName: "Alice",
            color: "#FF6B6B",
            cursorX: 100,
            cursorY: 200,
            cursorTarget: "track-1"
        })
        expect(service.participants).toHaveLength(1)
        expect(service.participants[0].displayName).toBe("Alice")
        expect(spy).toHaveBeenCalled()
    })
    it("updates existing participant position", () => {
        const service = new PresenceService()
        service.updatePresence({
            identity: "user-1", displayName: "Alice", color: "#FF6B6B",
            cursorX: 100, cursorY: 200, cursorTarget: "track-1"
        })
        service.updatePresence({
            identity: "user-1", displayName: "Alice", color: "#FF6B6B",
            cursorX: 300, cursorY: 400, cursorTarget: "track-2"
        })
        expect(service.participants).toHaveLength(1)
        expect(service.participants[0].cursorX).toBe(300)
    })
    it("removes a participant", () => {
        const service = new PresenceService()
        service.updatePresence({
            identity: "user-1", displayName: "Alice", color: "#FF6B6B",
            cursorX: 0, cursorY: 0, cursorTarget: ""
        })
        service.removeParticipant("user-1")
        expect(service.participants).toEqual([])
    })
    it("cleans up on terminate", () => {
        const service = new PresenceService()
        service.updatePresence({
            identity: "user-1", displayName: "Alice", color: "#FF6B6B",
            cursorX: 0, cursorY: 0, cursorTarget: ""
        })
        service.terminate()
        expect(service.participants).toEqual([])
    })
})
