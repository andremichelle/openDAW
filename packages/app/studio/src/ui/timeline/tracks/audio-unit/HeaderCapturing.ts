import {ElementCapturing} from "@/ui/canvas/capturing"
import {AudioUnitBox} from "@opendaw/studio-boxes"
import {int, Nullable} from "@opendaw/lib-std"

export namespace HeaderCapturing {
    export type Target = { type: "hover", box: AudioUnitBox } | { type: "insert", index: int }

    export const install = (element: HTMLElement): ElementCapturing<Target> => new ElementCapturing<Target>(element, {
        capture: (_localX: number, _localY: number): Nullable<Target> => {
            return null
        }
    })
}