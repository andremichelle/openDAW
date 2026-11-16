import {isDefined, Option, RuntimeNotifier} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {MidiDevices, Project} from "@opendaw/studio-core"

export namespace MidiAccessOnLoad {
    const headline = "MIDI Controls"

    export const check = async (project: Project): Promise<void> => {
        const count = project.midiLearning.numberOfConnections
        if (count === 0 || MidiDevices.available().getValue() || !MidiDevices.canRequestMidiAccess()) {return}
        const controls = count === 1 ? "1 learned MIDI control" : `${count} learned MIDI controls`
        const state = await queryPermission()
        if (state.contains("granted")) {
            MidiDevices.available().setValue(true)
        } else if (state.contains("denied")) {
            await RuntimeNotifier.info({
                headline,
                message: `This project has ${controls}, but MIDI access is blocked in your browser's site settings. Allow MIDI there to use them.`
            })
        } else {
            const approved = await RuntimeNotifier.approve({
                headline,
                message: `This project has ${controls}. Turn on MIDI access so they respond?`,
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
