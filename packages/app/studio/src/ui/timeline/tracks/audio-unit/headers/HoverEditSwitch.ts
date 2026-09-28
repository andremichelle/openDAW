import {Lifecycle, Terminator} from "@opendaw/lib-std"
import {Runtime} from "@opendaw/lib-runtime"
import {AudioUnitBoxAdapter} from "@opendaw/studio-adapters"
import {Project} from "@opendaw/studio-core"
import {AnyDragData} from "@/ui/AnyDragData"

const HoverSwitchDelay = 1000
const HoverSwitchGap = 500 // dragover silence that means the pointer left

export type HoverEditSwitch = { hover(): void, cancel(): void }

// Anything that lands in the device panel: a device from the browser, one dragged out of a chain, a preset.
export const isDeviceDrag = (data: AnyDragData): boolean =>
    data.type === "midi-effect" || data.type === "audio-effect" || data.type === "instrument" || data.type === "preset"

// Holding a device over a unit's track header for a second opens that unit's chain, so the device can be
// dropped where it belongs in the device panel. `hover` is fed by dragover, which keeps firing while the
// pointer stays, so the switch survives any enter/leave miscount.
export const createHoverEditSwitch = (lifecycle: Lifecycle,
                                      project: Project,
                                      audioUnitBoxAdapter: AudioUnitBoxAdapter): HoverEditSwitch => {
    const audioUnitEditing = project.userEditingManager.audioUnit
    const pending = lifecycle.own(new Terminator())
    let lastHover: number = 0.0
    return {
        hover: () => {
            if (audioUnitEditing.isEditing(audioUnitBoxAdapter.box.editing)) {return}
            lastHover = performance.now()
            if (!pending.isEmpty()) {return}
            pending.own(Runtime.scheduleTimeout(() => {
                pending.terminate()
                if (performance.now() - lastHover < HoverSwitchGap) {
                    // sealed as its own history entry, so undoing the drop that follows keeps the panel here
                    project.editing.modify(() => audioUnitEditing.edit(audioUnitBoxAdapter.box.editing))
                }
            }, HoverSwitchDelay))
        },
        cancel: () => pending.terminate()
    }
}
