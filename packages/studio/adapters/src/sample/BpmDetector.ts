import {Option, Progress} from "@opendaw/lib-std"
import {AudioData, bpm} from "@opendaw/lib-dsp"

// Resolves the musical tempo of imported audio. `None` means unknown and is stored as `SampleMetaData.bpm = 0`,
// which keeps the material in seconds instead of warping it to a fabricated tempo. Each host installs its own
// policy: whether a result is trustworthy is decided here, not by the callers.
export interface BpmDetector {
    detect(audioData: Readonly<AudioData>, progress: Progress.Handler): Promise<Option<bpm>>
}

export namespace BpmDetector {
    export const Unknown: BpmDetector = {
        detect: async (_audioData: Readonly<AudioData>, progress: Progress.Handler): Promise<Option<bpm>> => {
            progress(1.0)
            return Option.None
        }
    }
}
