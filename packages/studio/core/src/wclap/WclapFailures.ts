import {Optional, RuntimeNotifier, UUID} from "@opendaw/lib-std"
import {WclapMidiEffectBox} from "@opendaw/studio-boxes"
import {WclapStatus} from "@opendaw/studio-adapters"
import {Project} from "../project"
import {WclapBoxes} from "./WclapBoxes"

// A plugin that cannot load passes audio through, the editor shows why, and this tells the user once per failure
export namespace WclapFailures {
    export const report = (project: Project, uuid: string, previous: Optional<WclapStatus>, status: WclapStatus): void => {
        if (status.state !== "failed" || previous?.state === "failed") {return}
        const box = project.boxGraph.findBox(UUID.parse(uuid)).unwrapOrNull()
        const name = WclapBoxes.is(box)
            ? `"${box.label.getValue()}" (${box.clapId.getValue()})` : "A WebCLAP plugin"
        RuntimeNotifier.notify({
            message: `${name} could not load: ${status.message}. The device passes ${box instanceof WclapMidiEffectBox ? "notes" : "audio"} through.`,
            icon: "Warning"
        })
    }
}
