import {describe, expect, it} from "vitest"
import {Option} from "@opendaw/lib-std"
import {TracksManager} from "../TracksManager"

Reflect.set(globalThis, "AudioWorkletNode", class {})
const {ClipCapturing} = await import("./ClipCapturing")
const {createClipSelectableLocator} = await import("./ClipSelectableLocator")

describe("scrolled clip selection in taller tracks", () => {
    it("uses the shared horizontal offset and actual row height for hit testing and rectangle selection", () => {
        const clip = {indexField: {getValue: () => 2}}
        const track = {
            position: 0, size: 200,
            trackBoxAdapter: {clips: {collection: {
                getAdapterByIndex: (index: number) => index === 2 ? Option.wrap(clip) : Option.None,
                adapters: () => [clip]
            }}}
        }
        const manager = {
            service: {timeline: {clips: {scroll: {getValue: () => 73.5}}}},
            scrollableContainer: {scrollTop: 0, scrollHeight: 264},
            tracks: () => [track], localToIndex: () => 0
        } as unknown as TracksManager
        const capturing = ClipCapturing.create({} as Element, manager)
        expect(capturing.captureLocalPoint(30, 180)).toMatchObject({type: "clip", clip})
        expect(capturing.captureLocalPoint(30, 201)).toBeNull()
        const locator = createClipSelectableLocator(capturing, manager)
        expect(Array.from(locator.selectablesBetween({u: 25, v: 0}, {u: 35, v: 200}))).toEqual([clip])
    })
})
