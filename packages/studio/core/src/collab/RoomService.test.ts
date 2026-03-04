import {describe, expect, it} from "vitest"
import {RoomService} from "./RoomService"

describe("RoomService", () => {
    it("generates a share URL using window.location.origin by default", () => {
        const service = new RoomService({endpoint: "wss://localhost:3000"})
        const url = service.getShareUrl("abc12345")
        expect(url).toBe(`${window.location.origin}/r/abc12345`)
    })
    it("uses explicit shareBaseUrl override", () => {
        const service = new RoomService({
            endpoint: "wss://localhost:3000",
            shareBaseUrl: "https://my-app.example.com",
        })
        const url = service.getShareUrl("abc12345")
        expect(url).toBe("https://my-app.example.com/r/abc12345")
    })
    it("extracts room ID from a share URL", () => {
        const roomId = RoomService.parseShareUrl("https://example.com/r/abc12345")
        expect(roomId).toBe("abc12345")
    })
    it("parses share URL from various domains", () => {
        expect(RoomService.parseShareUrl("https://opendaw.studio/r/room1234")).toBe("room1234")
        expect(RoomService.parseShareUrl("http://localhost:5173/r/testroom")).toBe("testroom")
        expect(RoomService.parseShareUrl("https://my-fork.vercel.app/r/xyz99abc")).toBe("xyz99abc")
    })
    it("returns undefined for URLs without /r/ segment", () => {
        expect(RoomService.parseShareUrl("https://opendaw.studio/other")).toBeUndefined()
    })
    it("returns undefined for empty room ID", () => {
        expect(RoomService.parseShareUrl("https://opendaw.studio/r/")).toBeUndefined()
    })
    it("rejects uppercase characters in room ID", () => {
        expect(RoomService.parseShareUrl("https://opendaw.studio/r/ABC12345")).toBeUndefined()
    })
    it("generates an 8-character alphanumeric room ID", () => {
        const service = new RoomService({endpoint: "wss://localhost:3000"})
        const roomId = service.generateRoomId()
        expect(roomId).toMatch(/^[a-z0-9]{8}$/)
    })
    it("generates unique room IDs across calls", () => {
        const service = new RoomService({endpoint: "wss://localhost:3000"})
        const ids = new Set(Array.from({length: 20}, () => service.generateRoomId()))
        expect(ids.size).toBe(20)
    })
})
