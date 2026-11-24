import {describe, expect, it} from "vitest"
import {RuntimeNotifier} from "@opendaw/lib-std"
import {Promises} from "./promises"

// #574: without a notifier nobody can cancel, so a failing attempt must not be retried forever
describe("Promises.approvedRetry without a RuntimeNotifier", () => {
    it("makes one attempt and rethrows its error", async () => {
        expect(RuntimeNotifier.installed).toBe(false)
        let attempts = 0
        const failure = new Error("upload failed")
        const retried = Promises.approvedRetry(async () => {
            attempts++
            throw failure
        }, () => ({message: "Retry?"}))
        await expect(retried).rejects.toBe(failure)
        expect(attempts).toBe(1)
    })
})
