import {beforeEach, describe, expect, it, vi} from "vitest"
import {RuntimeNotification, RuntimeNotifier} from "@opendaw/lib-std"
import {AudioData} from "@opendaw/lib-dsp"

const files = vi.hoisted(() => ({
    saves: [] as Array<{ bytes: ArrayBuffer, options?: SaveFilePickerOptions }>,
    outcomes: [] as Array<"saved" | "aborted">
}))
vi.mock("@opendaw/lib-dom", () => ({
    Files: {
        save: async (bytes: ArrayBuffer, options?: SaveFilePickerOptions): Promise<string> => {
            files.saves.push({bytes, options})
            if (files.outcomes.shift() === "aborted") {throw new DOMException("The user aborted a request.", "AbortError")}
            return options?.suggestedName ?? "unknown"
        }
    }
}))

import {UnstoredRecording} from "./UnstoredRecording"

const approvals: Array<RuntimeNotification.ApproveRequest> = []
let answers: Array<boolean> = []
RuntimeNotifier.install({
    info: async () => {},
    approve: async request => {
        approvals.push(request)
        return answers.shift() ?? false
    },
    progress: () => ({unknownProgress: () => {}, terminate: () => {}}) as unknown as RuntimeNotification.ProgressUpdater,
    notify: () => {}
} as RuntimeNotification.Notifier)

const take = (): AudioData => {
    const audio = AudioData.create(48000, 480, 2)
    audio.frames[0].fill(0.25)
    audio.frames[1].fill(-0.25)
    return audio
}

describe("UnstoredRecording", () => {
    beforeEach(() => {
        approvals.length = 0
        answers = []
        files.saves.length = 0
        files.outcomes = []
    })

    it("saves the take as a WAV file named after the recording on Download WAV", async () => {
        answers = [true]
        files.outcomes = ["saved"]
        const error = new DOMException("No space available for this operation", "QuotaExceededError")
        expect(await UnstoredRecording.offerDownload(take(), "Recording-2026-11-20", error)).toBe(true)
        expect(approvals.length).toBe(1)
        expect(approvals[0]).toMatchObject({headline: "Recording Not Saved", approveText: "Download WAV", cancelText: "Discard"})
        expect(approvals[0].message).toContain("'Recording-2026-11-20' could not be saved in the browser (")
        expect(approvals[0].message).toContain("No space available for this operation")
        expect(files.saves.length).toBe(1)
        expect(files.saves[0].options?.suggestedName).toBe("Recording-2026-11-20.wav")
        const bytes = new Uint8Array(files.saves[0].bytes)
        expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("RIFF")
        expect(new TextDecoder().decode(bytes.subarray(8, 12))).toBe("WAVE")
        expect(bytes.byteLength).toBeGreaterThan(480 * 2 * 4)
    })

    it("saves nothing on Discard", async () => {
        answers = [false]
        expect(await UnstoredRecording.offerDownload(take(), "Recording", new Error("x"))).toBe(false)
        expect(files.saves.length).toBe(0)
    })

    it("asks again when the file dialog was closed without saving, so the take is not lost by accident", async () => {
        answers = [true, true]
        files.outcomes = ["aborted", "saved"]
        expect(await UnstoredRecording.offerDownload(take(), "Recording", new Error("x"))).toBe(true)
        expect(approvals.length).toBe(2)
        expect(files.saves.length).toBe(2)
    })

    it("ends with Discard after the file dialog was closed", async () => {
        answers = [true, false]
        files.outcomes = ["aborted"]
        expect(await UnstoredRecording.offerDownload(take(), "Recording", new Error("x"))).toBe(false)
        expect(approvals.length).toBe(2)
        expect(files.saves.length).toBe(1)
    })
})
