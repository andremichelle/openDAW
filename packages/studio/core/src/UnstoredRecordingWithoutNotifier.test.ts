import {describe, expect, it, vi} from "vitest"
import {RuntimeNotifier} from "@opendaw/lib-std"
import {AudioData} from "@opendaw/lib-dsp"

const files = vi.hoisted(() => ({saves: 0}))
vi.mock("@opendaw/lib-dom", () => ({
    Files: {
        save: async (): Promise<string> => {
            files.saves++
            throw new DOMException("The user aborted a request.", "AbortError")
        }
    }
}))

import {UnstoredRecording} from "./UnstoredRecording"

// #574: without a notifier nobody can choose Discard, so a refused save must end the offer
describe("UnstoredRecording without a RuntimeNotifier", () => {
    it("tries one save and gives up when it is refused", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {})
        expect(RuntimeNotifier.installed).toBe(false)
        const audio = AudioData.create(48000, 480, 1)
        expect(await UnstoredRecording.offerDownload(audio, "Recording", new Error("x"))).toBe(false)
        expect(files.saves).toBe(1)
    })
})
