import {InstrumentTranscription, MenuItem, Project, TranscriptionSource} from "@opendaw/studio-core"
import {NeuralTranscription} from "@/service/NeuralTranscription"

export const instrumentTranscriptionMenuItem = (project: Project, source: TranscriptionSource): MenuItem =>
    MenuItem.default({label: "Convert Instruments to MIDI...", separatorBefore: true,
        selectable: !InstrumentTranscription.isRunning(project)})
        .setTriggerProcedure(() => NeuralTranscription.run(project, source))
