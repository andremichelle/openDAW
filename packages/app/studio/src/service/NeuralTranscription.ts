import type {Project} from "@opendaw/studio-core"
import type {TranscriptionSource} from "./InstrumentTranscription"
import type {StudioService} from "./StudioService"

export const MUSCRIPTOR_ENABLED = import.meta.env.VITE_ENABLE_MUSCRIPTOR === "true"

/** One build-gated entry point for every audio-to-MIDI action. */
export class NeuralTranscription {
    static readonly browse = async (service: StudioService): Promise<void> => {
        if (!MUSCRIPTOR_ENABLED) {return}
        const {MuScriptorTranscription} = await import("@/service/MuScriptorTranscription")
        await MuScriptorTranscription.browse(service)
    }

    static readonly run = async (project: Project, source: TranscriptionSource): Promise<void> => {
        if (!MUSCRIPTOR_ENABLED) {return}
        const {MuScriptorTranscription} = await import("@/service/MuScriptorTranscription")
        await MuScriptorTranscription.run(project, source)
    }
}
