import {MenuItem, Project} from "@opendaw/studio-core"
import {InstrumentTranscription, TranscriptionSource} from "@/service/InstrumentTranscription"
import {NeuralTranscription} from "@/service/NeuralTranscription"

export const instrumentTranscriptionMenuItem = (project: Project, source: TranscriptionSource): MenuItem =>
    MenuItem.default({label: "Convert Instruments to MIDI...", separatorBefore: true,
        selectable: !InstrumentTranscription.isRunning(project)})
        .setTriggerProcedure(() => NeuralTranscription.run(project, source))
