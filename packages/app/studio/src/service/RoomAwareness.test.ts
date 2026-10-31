import {describe, expect, it, vi} from "vitest"
import type {Awareness} from "y-protocols/awareness"
import {RoomAwareness} from "./RoomAwareness"

vi.mock("@opendaw/lib-dom", async importOriginal => ({
    ...(await importOriginal<object>()),
    deferNextFrame: (exec: () => void) => ({request: exec, immediate: exec, cancel: () => {}, terminate: () => {}})
}))

vi.stubGlobal("localStorage", {getItem: () => null, setItem: () => {}})

const fakeAwareness = () => {
    const state: Record<string, unknown> = {}
    return {clientID: 1, setLocalStateField: (key: string, value: unknown) => {state[key] = value}, state}
}

describe("RoomAwareness", () => {
    it("is not recording after joining", () => {
        const awareness = fakeAwareness()
        new RoomAwareness(awareness as unknown as Awareness, "room", "Ann", "#fff")
        expect(awareness.state.user).toMatchObject({name: "Ann", recording: false})
    })

    it("tells the room when recording starts and stops", () => {
        const awareness = fakeAwareness()
        const room = new RoomAwareness(awareness as unknown as Awareness, "room", "Ann", "#fff")
        room.recording.setValue(true)
        expect(awareness.state.user).toMatchObject({recording: true})
        room.recording.setValue(false)
        expect(awareness.state.user).toMatchObject({recording: false})
    })

    it("keeps name, color and panel while the recording state changes", () => {
        const awareness = fakeAwareness()
        const room = new RoomAwareness(awareness as unknown as Awareness, "room", "Ann", "#fff")
        room.panel.setValue("mixer")
        room.recording.setValue(true)
        expect(awareness.state.user).toEqual({name: "Ann", color: "#fff", panel: "mixer", recording: true})
    })
})
