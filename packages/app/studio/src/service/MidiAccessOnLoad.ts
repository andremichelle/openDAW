import {isDefined, Option, RuntimeNotifier} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {CaptureMidi, MidiDevices, Project} from "@opendaw/studio-core"

export namespace MidiAccessOnLoad {
    const headline = "MIDI Controls"

    export const check = async (project: Project): Promise<void> => {
        const controls = project.midiLearning.numberOfConnections
        const tracks = project.captureDevices.allCaptures()
            .filter(capture => capture instanceof CaptureMidi && capture.armed.getValue()).length
        if (controls + tracks === 0 || MidiDevices.available().getValue() || !MidiDevices.canRequestMidiAccess()) {return}
        const uses = [
            controls === 0 ? "" : controls === 1 ? "1 learned MIDI control" : `${controls} learned MIDI controls`,
            tracks === 0 ? "" : tracks === 1 ? "1 armed MIDI track" : `${tracks} armed MIDI tracks`
        ].filter(text => text.length > 0).join(" and ")
        const state = await queryPermission()
        if (state.contains("granted") || state.contains("denied")) {
            MidiDevices.available().setValue(true)
        } else {
            const approved = await RuntimeNotifier.approve({
                headline,
                message: `This project has ${uses}. Turn on MIDI access so they respond?`,
                approveText: "Turn on MIDI",
                cancelText: "Not now"
            })
            if (approved) {MidiDevices.available().setValue(true)}
        }
    }

    const queryPermission = async (): Promise<Option<PermissionState>> => {
        if (!isDefined(navigator.permissions?.query)) {return Option.None}
        const {status, value} = await Promises.tryCatch(navigator.permissions.query({name: "midi"}))
        return status === "resolved" ? Option.wrap(value.state) : Option.None
    }
}
