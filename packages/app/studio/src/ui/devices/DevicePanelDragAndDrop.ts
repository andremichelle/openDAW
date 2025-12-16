import {asDefined, panic, Terminable} from "@opendaw/lib-std"
import {DragAndDrop} from "@/ui/DragAndDrop"
import {AnyDragData} from "@/ui/AnyDragData"
import {
    AudioBusBoxAdapter,
    AudioUnitBoxAdapter,
    Devices,
    InstrumentBox,
    InstrumentFactories,
    InstrumentFactory
} from "@opendaw/studio-adapters"
import {InsertMarker} from "@/ui/components/InsertMarker"
import {EffectFactories, Project} from "@opendaw/studio-core"
import {IndexedBox} from "@opendaw/lib-box"

export namespace DevicePanelDragAndDrop {
    export const install = (project: Project,
                            editors: HTMLElement,
                            midiEffectsContainer: HTMLElement,
                            instrumentContainer: HTMLElement,
                            audioEffectsContainer: HTMLElement): Terminable => {
        const insertMarker: HTMLElement = InsertMarker()
        const {editing, boxAdapters, userEditingManager} = project
        return DragAndDrop.installTarget(editors, {
            drag: (event: DragEvent, dragData: AnyDragData): boolean => {
                instrumentContainer.style.opacity = "1.0"
                const editingDeviceChain = userEditingManager.audioUnit.get()
                if (editingDeviceChain.isEmpty()) {return false}
                const deviceHost = boxAdapters.adapterFor(editingDeviceChain.unwrap().box, Devices.isHost)
                const {type} = dragData
                let container: HTMLElement
                if (type === "audio-effect") {
                    container = audioEffectsContainer
                } else if (type === "midi-effect") {
                    if (deviceHost.inputAdapter.mapOr(input => input.accepts !== "midi", true)) {
                        return false
                    }
                    container = midiEffectsContainer
                } else if (type === "instrument" && deviceHost.isAudioUnit) {
                    if (deviceHost.inputAdapter.mapOr(input => input instanceof AudioBusBoxAdapter, false)) {
                        return false
                    }
                    instrumentContainer.style.opacity = "0.5"
                    return true
                } else {
                    return false
                }
                const [index, successor] = DragAndDrop.findInsertLocation(event, container)
                if (dragData.start_index === null) {
                    container.insertBefore(insertMarker, successor)
                } else {
                    const delta = index - dragData.start_index
                    if (delta < 0 || delta > 1) {
                        container.insertBefore(insertMarker, successor)
                    } else if (insertMarker.isConnected) {insertMarker.remove()}
                }
                return true
            },
            drop: (event: DragEvent, dragData: AnyDragData): void => {
                instrumentContainer.style.opacity = "1.0"
                if (insertMarker.isConnected) {insertMarker.remove()}
                const {type} = dragData
                if (type !== "midi-effect" && type !== "audio-effect" && type !== "instrument") {return}
                const editingDeviceChain = userEditingManager.audioUnit.get()
                if (editingDeviceChain.isEmpty()) {return}
                const deviceHost = boxAdapters.adapterFor(editingDeviceChain.unwrap("editingDeviceChain isEmpty").box, Devices.isHost)
                if (type === "instrument" && deviceHost instanceof AudioUnitBoxAdapter) {
                    const inputBox = deviceHost.inputField.pointerHub.incoming().at(0)?.box
                    if (inputBox === undefined) {
                        console.warn("No instrument to replace")
                        return
                    }
                    const namedElement = InstrumentFactories.Named[dragData.device]
                    const factory = asDefined(namedElement, `Unknown: '${dragData.device}'`) as InstrumentFactory
                    editing.modify(() => {
                        const attempt = project.api.replaceMIDIInstrument(inputBox as InstrumentBox, factory)
                        if (attempt.isFailure()) {console.debug(attempt.failureReason())}
                    })
                    return
                }
                let container: HTMLElement
                let field
                if (type === "audio-effect") {
                    container = audioEffectsContainer
                    field = deviceHost.audioEffects.field()
                } else if (type === "midi-effect") {
                    container = midiEffectsContainer
                    field = deviceHost.midiEffects.field()
                } else {
                    return panic(`Unknown type: ${type}`)
                }
                const [index] = DragAndDrop.findInsertLocation(event, container)
                if (dragData.start_index === null) {
                    editing.modify(() => {
                        const factory = EffectFactories.MergedNamed[dragData.device]
                        project.api.insertEffect(field, factory, index)
                    })
                } else {
                    const delta = index - dragData.start_index
                    if (delta < 0 || delta > 1) { // if delta is zero or one, it has no effect on the order
                        editing.modify(() => IndexedBox.moveIndex(field, dragData.start_index, delta))
                    }
                }
            },
            enter: () => {},
            leave: () => {
                instrumentContainer.style.opacity = "1.0"
                if (insertMarker.isConnected) {insertMarker.remove()}
            }
        })
    }
}