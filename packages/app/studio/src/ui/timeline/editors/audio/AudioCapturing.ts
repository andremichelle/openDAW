import {Nullable} from "@opendaw/lib-std"
import {PointerRadiusDistance} from "@/ui/timeline/constants.ts"
import {ElementCapturing, TimelineRange} from "@opendaw/studio-core"

import {AudioEventOwnerReader} from "@/ui/timeline/editors/EventOwnerReader.ts"

export type AudioCaptureTarget =
    | { type: "loop-duration", reader: AudioEventOwnerReader }

export const createAudioCapturing = (element: Element,
                                     range: TimelineRange,
                                     reader: AudioEventOwnerReader) =>
    new ElementCapturing<AudioCaptureTarget>(element, {
        capture: (x: number, _y: number): Nullable<AudioCaptureTarget> => {
            return Math.abs(range.unitToX(reader.loopDuration + reader.offset) - x) < PointerRadiusDistance
                ? {reader, type: "loop-duration"}
                : null
        }
    })