import {afterEach, describe, expect, it, vi} from "vitest"
import {Option} from "@opendaw/lib-std"
import {StudioService} from "@/service/StudioService"
import {CreateParameters} from "../TimelineDragAndDrop"
import {ClipCaptureTarget} from "./ClipCapturing"

Reflect.set(globalThis, "AudioWorkletNode", class {})
const {AudioContentFactory, ElementCapturing} = await import("@opendaw/studio-core")
const {ClipDragAndDrop} = await import("./ClipDragAndDrop")
afterEach(() => vi.restoreAllMocks())

describe("sample drops in a horizontally scrolled clip view", () => {
    it.each(["file", "sample"] as const)("replaces the scrolled column for a %s drop", type => {
        const create = vi.spyOn(AudioContentFactory, type === "file"
            ? "createNotStretchedClip" : "createTimeStretchedClip")
            .mockReturnValue({} as ReturnType<typeof AudioContentFactory.createNotStretchedClip>)
        const earlierDelete = vi.fn()
        const targetDelete = vi.fn()
        const getAdapterByIndex = vi.fn((index: number) =>
            Option.wrap({box: {delete: index === 2 ? targetDelete : earlierDelete}}))
        const service = {
            project: {boxGraph: {}},
            timeline: {clips: {scroll: {getValue: () => 73.5}}}
        } as unknown as StudioService
        const capturing = {
            element: {getBoundingClientRect: () => ({left: 100})}
        } as unknown as InstanceType<typeof ElementCapturing<ClipCaptureTarget>>
        const drop = new ClipDragAndDrop(service, capturing)
        drop.handleSample({
            event: {clientX: 130}, trackBoxAdapter: {clips: {collection: {getAdapterByIndex}}},
            audioFileBox: {}, sample: {bpm: 120}, type
        } as unknown as CreateParameters)
        expect(getAdapterByIndex).toHaveBeenCalledWith(2)
        expect(targetDelete).toHaveBeenCalledOnce()
        expect(earlierDelete).not.toHaveBeenCalled()
        expect(create).toHaveBeenCalledWith(expect.objectContaining({index: 2}))
    })
})
