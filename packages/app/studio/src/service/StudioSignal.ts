import {Sample, Soundfont} from "@opendaw/studio-adapters"
import {ProjectMeta} from "@opendaw/studio-core"
import {WerkstattEditorState} from "@/ui/werkstatt-editor/WerkstattEditorState"

export type StudioSignal =
    | { type: "reset-peaks" }
    | { type: "import-sample", sample: Sample }
    | { type: "import-soundfont", soundfont: Soundfont }
    | { type: "delete-project", meta: ProjectMeta }
    | { type: "werkstatt-editor-update", state: WerkstattEditorState }