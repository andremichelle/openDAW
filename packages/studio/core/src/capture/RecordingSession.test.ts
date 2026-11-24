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

describe("RecordingSession with a failing capture", () => {
    const start = async (...reasons: Array<unknown>) => {
        const {Option} = await import("@opendaw/lib-std")
        const captures = reasons.map((reason, index) => ({
            prepareRecording: () => new Promise<void>((_, reject) => setTimeout(() => reject(reason), index * 10))
        }))
        const project = {
            engine: {transportLocked: new DefaultObservableValue(false)},
            captureDevices: {filterArmed: () => captures},
            liveSync: Option.None,
            editing: {}
        }
        const session = new RecordingSession(project as unknown as Project)
        const outcome = await session.start(false).then(() => "started", reason => reason)
        return {outcome, session}
    }
    // #579: an abort (reported already) must not hide another capture's refusal
    it("reports a refusal even when another capture aborted first", async () => {
        const {Errors} = await import("@opendaw/lib-std")
        const {outcome, session} = await start(Errors.AbortError, new Errors.Warning("NotAllowedError: Permission denied"))
        expect(outcome).toBeInstanceOf(Errors.Warning)
        expect(outcome).toHaveProperty("message", "NotAllowedError: Permission denied")
        expect(session.isRecording).toBe(false)
    })
    it("passes an abort on when every capture aborted", async () => {
        const {Errors} = await import("@opendaw/lib-std")
        const {outcome, session} = await start(Errors.AbortError, Errors.AbortError)
        expect(outcome).toBe(Errors.AbortError)
        expect(session.isRecording).toBe(false)
    })
})
