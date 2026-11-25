import {describe, expect, it} from "vitest"
import {DefaultObservableValue, isDefined, Terminable} from "@opendaw/lib-std"
import type {Project} from "../project"

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const {RecordingSession} = await import("./RecordingSession")

describe("RecordingSession with a locked transport", () => {
    it("starts nothing and arms no capture", async () => {
        const armed: Array<string> = []
        const project = {
            engine: {transportLocked: new DefaultObservableValue(true)},
            captureDevices: {filterArmed: () => {armed.push("filterArmed"); return []}}
        }
        const session = new RecordingSession(project as unknown as Project)
        const result = await session.start(true)
        expect(result).toBe(Terminable.Empty)
        expect(session.isRecording).toBe(false)
        expect(RecordingSession.anyRecording).toBe(false)
        expect(armed).toEqual([])
    })
})
