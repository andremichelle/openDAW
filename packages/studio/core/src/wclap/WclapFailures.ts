import {Optional, RuntimeNotifier, UUID} from "@opendaw/lib-std"
import {WclapDeviceBox, WclapInstrumentBox} from "@opendaw/studio-boxes"
import {WclapStatus} from "@opendaw/studio-adapters"
import {Project} from "../project"

// A plugin that cannot load passes audio through, the editor shows why, and this tells the user once per failure
export namespace WclapFailures {
    export const report = (project: Project, uuid: string, previous: Optional<WclapStatus>, status: WclapStatus): void => {
        if (status.state !== "failed" || previous?.state === "failed") {return}
        const box = project.boxGraph.findBox(UUID.parse(uuid)).unwrapOrNull()
        const name = box instanceof WclapDeviceBox || box instanceof WclapInstrumentBox
            ? `"${box.label.getValue()}" (${box.clapId.getValue()})` : "A WebCLAP plugin"
        RuntimeNotifier.notify({
            message: `${name} could not load: ${status.message}. The device passes audio through.`,
            icon: "Warning"
        })
    }
}
