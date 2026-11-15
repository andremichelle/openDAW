import {UUID} from "@opendaw/lib-std"
import {Sample, Soundfont} from "@opendaw/studio-adapters"
import {ProjectMeta} from "@opendaw/studio-core"

export type StudioSignal =
    | { type: "reset-peaks" }
    | { type: "reveal-device", uuid: UUID.Bytes }
    | { type: "import-sample", sample: Sample }
    | { type: "import-soundfont", soundfont: Soundfont }
    | { type: "delete-project", meta: ProjectMeta }