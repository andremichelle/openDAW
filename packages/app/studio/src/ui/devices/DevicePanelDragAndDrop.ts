import {asDefined, isAbsent, isDefined, panic, RuntimeNotifier, Terminable, UUID} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {DragAndDrop} from "@/ui/DragAndDrop"
import {AnyDragData} from "@/ui/AnyDragData"
import {
    AudioBusBoxAdapter,
    AudioUnitBoxAdapter,
    Devices,
    InstrumentBox,
    InstrumentFactories,
    InstrumentFactory,
    PresetDecoder
} from "@opendaw/studio-adapters"
import {InsertMarker} from "@/ui/components/InsertMarker"
import {EffectFactories, PresetStorage, Project} from "@opendaw/studio-core"
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
                if (type === "preset") {
                    if (dragData.source !== "user") {return false}
                    if (dragData.category === "audio-unit" && deviceHost.isAudioUnit) {
                        instrumentContainer.style.opacity = "0.5"
                        return true
                    }
                    if (dragData.category === "instrument" && deviceHost.isAudioUnit
                        && !deviceHost.inputAdapter.mapOr(input => input instanceof AudioBusBoxAdapter, false)) {
                        instrumentContainer.style.opacity = "0.5"
                        return true
                    }
                    if (dragData.category === "audio-effect" || dragData.category === "audio-effect-chain") {
                        const [_index, successor] = DragAndDrop.findInsertLocation(event, audioEffectsContainer)
                        audioEffectsContainer.insertBefore(insertMarker, successor)
                        return true
                    }
                    if (dragData.category === "midi-effect" || dragData.category === "midi-effect-chain") {
                        if (deviceHost.inputAdapter.mapOr(input => input.accepts !== "midi", true)) {return false}
                        const [_index, successor] = DragAndDrop.findInsertLocation(event, midiEffectsContainer)
                        midiEffectsContainer.insertBefore(insertMarker, successor)
                        return true
                    }
                    return false
                }
                let container: HTMLElement
                if (type === "audio-effect") {
                    container = audioEffectsContainer
                } else if (type === "midi-effect") {
                    if (deviceHost.inputAdapter.mapOr(input => input.accepts !== "midi", true)) {
                        return false
                    }
                    container = midiEffectsContainer
                } else if (type === "instrument" && deviceHost.isAudioUnit) {
                    if (dragData.device === null) {return false}
                    if (deviceHost.inputAdapter.mapOr(input => input instanceof AudioBusBoxAdapter, false)) {
                        return false
                    }
                    instrumentContainer.style.opacity = "0.5"
                    return true
                } else {
                    return false
                }
                const [_index, successor] = DragAndDrop.findInsertLocation(event, container)
                container.insertBefore(insertMarker, successor)
                return true
            },
            drop: (event: DragEvent, dragData: AnyDragData): void => {
                instrumentContainer.style.opacity = "1.0"
                if (insertMarker.isConnected) {insertMarker.remove()}
                const {type} = dragData
                if (type === "preset") {
                    const dropIndex = dragData.category === "audio-effect" || dragData.category === "audio-effect-chain"
                        ? DragAndDrop.findInsertLocation(event, audioEffectsContainer)[0]
                        : dragData.category === "midi-effect" || dragData.category === "midi-effect-chain"
                            ? DragAndDrop.findInsertLocation(event, midiEffectsContainer)[0]
                            : 0
                    handlePresetDrop(project, dragData, dropIndex).catch(console.warn)
                    return
                }
                if (type !== "midi-effect" && type !== "audio-effect" && type !== "instrument") {return}
                const editingDeviceChain = userEditingManager.audioUnit.get()
                if (editingDeviceChain.isEmpty()) {return}
                const deviceHost = boxAdapters.adapterFor(editingDeviceChain.unwrap("editingDeviceChain isEmpty").box, Devices.isHost)
                if (type === "instrument" && deviceHost instanceof AudioUnitBoxAdapter) {
                    if (dragData.device === null) {return}
                    const inputBox = deviceHost.inputField.pointerHub.incoming().at(0)?.box
                    if (isAbsent(inputBox)) {
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
                if (dragData.uuids === null) {
                    editing.modify(() => {
                        const factory = EffectFactories.MergedNamed[dragData.device]
                        project.api.insertEffect(field, factory, index)
                    })
                } else {
                    const uuids = dragData.uuids
                    if (uuids.length === 0) {return}
                    const startIndices = uuids
                        .map(uuidStr => project.boxGraph.findBox(UUID.parse(uuidStr)).unwrapOrNull())
                        .filter(isDefined)
                        .filter(IndexedBox.isIndexedBox)
                        .map(box => box.index.getValue())
                        .toSorted((a, b) => a - b)
                    if (startIndices.length === 0) {return}
                    editing.modify(() => IndexedBox.moveIndices(field, startIndices, index))
                }
            },
            enter: () => {},
            leave: () => {
                instrumentContainer.style.opacity = "1.0"
                if (insertMarker.isConnected) {insertMarker.remove()}
            }
        })
    }

    const handlePresetDrop = async (project: Project,
                                    dragData: { category: string, source: string, uuid: UUID.String },
                                    dropIndex: number): Promise<void> => {
        if (dragData.source !== "user") {
            console.debug("Stock presets not yet available for drop")
            return
        }
        const editing = project.userEditingManager.audioUnit.get()
        if (editing.isEmpty()) {return}
        const targetAudioUnit = project.boxAdapters
            .adapterFor(editing.unwrap().box, Devices.isHost).audioUnitBoxAdapter().box
        const load = await Promises.tryCatch(PresetStorage.load(UUID.parse(dragData.uuid)))
        if (load.status === "rejected") {
            await RuntimeNotifier.info({
                headline: "Could Not Load Preset",
                message: String(load.error)
            })
            return
        }
        if (dragData.category === "audio-unit") {
            project.editing.modify(() => {
                const attempt = PresetDecoder.replaceAudioUnit(load.value as ArrayBuffer, targetAudioUnit)
                if (attempt.isFailure()) {
                    RuntimeNotifier.info({
                        headline: "Can't Apply Preset",
                        message: attempt.failureReason()
                    }).then()
                }
            })
            project.loadScriptDevices()
            return
        }
        if (dragData.category === "instrument") {
            project.editing.modify(() => {
                const attempt = PresetDecoder.replaceAudioUnit(load.value as ArrayBuffer, targetAudioUnit,
                    {keepMIDIEffects: true, keepAudioEffects: true})
                if (attempt.isFailure()) {
                    RuntimeNotifier.info({
                        headline: "Can't Apply Preset",
                        message: attempt.failureReason()
                    }).then()
                }
            })
            project.loadScriptDevices()
            return
        }
        if (dragData.category === "audio-effect" || dragData.category === "midi-effect"
            || dragData.category === "audio-effect-chain" || dragData.category === "midi-effect-chain") {
            project.editing.modify(() => {
                const attempt = PresetDecoder.insertEffectChain(load.value, targetAudioUnit, dropIndex)
                if (attempt.isFailure()) {
                    RuntimeNotifier.info({
                        headline: "Can't Apply Preset",
                        message: attempt.failureReason()
                    }).then()
                }
            })
            project.loadScriptDevices()
            return
        }
        console.debug(`Preset drop for category '${dragData.category}' not yet implemented`)
    }
}