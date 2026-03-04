import {describe, expect, it} from "vitest"
import {RoomService} from "./RoomService"

describe("RoomService", () => {
    it("generates a share URL from a room ID", () => {
        const service = new RoomService({endpoint: "wss://localhost:3000"})
        const url = service.getShareUrl("abc12345")
        expect(url).toBe("https://opendaw.studio/r/abc12345")
    })
    it("extracts room ID from a share URL", () => {
        const roomId = RoomService.parseShareUrl("https://opendaw.studio/r/abc12345")
        expect(roomId).toBe("abc12345")
    })
    it("returns undefined for invalid share URLs", () => {
        const roomId = RoomService.parseShareUrl("https://opendaw.studio/other")
        expect(roomId).toBeUndefined()
    })
})
