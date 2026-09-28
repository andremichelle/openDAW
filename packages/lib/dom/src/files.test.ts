import {afterEach, describe, expect, it, vi} from "vitest"
import {Errors} from "@opendaw/lib-std"
import {Files} from "./files"

// Chrome allows one native picker at a time: a second showOpenFilePicker call while the first is open
// rejects with NotAllowedError "File picker already active". Files.open must refuse re-entry itself
// so callers only ever see their own picker's result or a plain abort (live error 1148).
describe("Files.open re-entry", () => {
    afterEach(() => vi.unstubAllGlobals())
    const stubPicker = () => {
        const {promise, resolve, reject} = Promise.withResolvers<ReadonlyArray<{getFile: () => Promise<File>}>>()
        const showOpenFilePicker = vi.fn(() => promise)
        vi.stubGlobal("window", {showOpenFilePicker})
        return {resolve, reject, showOpenFilePicker}
    }
    it("rejects a second call with an abort while the first picker is open, without opening a second picker", async () => {
        const {resolve, showOpenFilePicker} = stubPicker()
        const first = Files.open()
        const second = Files.open()
        await expect(second).rejects.toSatisfy(Errors.isAbort)
        expect(showOpenFilePicker).toHaveBeenCalledTimes(1)
        const file = new File(["x"], "x.txt")
        resolve([{getFile: () => Promise.resolve(file)}])
        expect(await first).toEqual([file])
    })
    it("accepts a new call once the previous picker resolved", async () => {
        const {resolve, showOpenFilePicker} = stubPicker()
        const first = Files.open()
        resolve([])
        await first
        const {resolve: resolveNext} = stubPicker()
        const next = Files.open()
        resolveNext([])
        expect(await next).toEqual([])
        expect(showOpenFilePicker).toHaveBeenCalledTimes(1)
    })
    it("accepts a new call once the previous picker was cancelled", async () => {
        const {reject} = stubPicker()
        const first = Files.open()
        reject(new DOMException("cancel", "AbortError"))
        await expect(first).rejects.toSatisfy(Errors.isAbort)
        const {resolve} = stubPicker()
        const next = Files.open()
        resolve([])
        expect(await next).toEqual([])
    })
})
