import {Sample, Soundfont} from "@moises-ai/studio-adapters"
import {ProjectMeta} from "@moises-ai/studio-core"

export type StudioSignal =
    | { type: "reset-peaks" }
    | { type: "import-sample", sample: Sample }
    | { type: "import-soundfont", soundfont: Soundfont }
    | { type: "delete-project", meta: ProjectMeta }