import {ByteArrayInput, ByteArrayOutput, int, Option, Provider} from "@opendaw/lib-std"
import {Box, BoxEditing, BoxGraph, Field} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {
    AudioEffectDeviceAdapter,
    BoxAdapters,
    DeviceBoxAdapter,
    DeviceBoxUtils,
    Devices,
    FilteredSelection,
    MidiEffectDeviceAdapter
} from "@opendaw/studio-adapters"
import {ClipboardEntry, ClipboardHandler} from "../ClipboardManager"
import {ClipboardUtils} from "../ClipboardUtils"

type ClipboardDevices = ClipboardEntry<"devices">

type DeviceMetadata = {
    midiEffectCount: int
    midiEffectMaxIndex: int
    audioEffectCount: int
    audioEffectMaxIndex: int
}

export namespace DevicesClipboard {
    export type Context = {
        readonly getEnabled: Provider<boolean>
        readonly editing: BoxEditing
        readonly selection: FilteredSelection<DeviceBoxAdapter>
        readonly boxGraph: BoxGraph
        readonly boxAdapters: BoxAdapters
        readonly getMidiEffectsField: Provider<Option<Field<Pointers.MIDIEffectHost>>>
        readonly getAudioEffectsField: Provider<Option<Field<Pointers.AudioEffectHost>>>
    }

    const encodeMetadata = (metadata: DeviceMetadata): ArrayBufferLike => {
        const output = ByteArrayOutput.create()
        output.writeInt(metadata.midiEffectCount)
        output.writeInt(metadata.midiEffectMaxIndex)
        output.writeInt(metadata.audioEffectCount)
        output.writeInt(metadata.audioEffectMaxIndex)
        return output.toArrayBuffer()
    }

    const decodeMetadata = (buffer: ArrayBufferLike): DeviceMetadata => {
        const input = new ByteArrayInput(buffer)
        return {
            midiEffectCount: input.readInt(),
            midiEffectMaxIndex: input.readInt(),
            audioEffectCount: input.readInt(),
            audioEffectMaxIndex: input.readInt()
        }
    }

    export const createHandler = ({
                                      getEnabled,
                                      editing,
                                      selection,
                                      boxGraph,
                                      boxAdapters,
                                      getMidiEffectsField,
                                      getAudioEffectsField
                                  }: Context): ClipboardHandler<ClipboardDevices> => {
        const copyDevices = (): Option<ClipboardDevices> => {
            const selected = selection.selected()
            if (selected.length === 0) {return Option.None}
            const midiEffects: Array<MidiEffectDeviceAdapter> = []
            const audioEffects: Array<AudioEffectDeviceAdapter> = []
            for (const adapter of selected) {
                if (adapter.type === "midi-effect") {
                    midiEffects.push(adapter as MidiEffectDeviceAdapter)
                } else if (adapter.type === "audio-effect") {
                    audioEffects.push(adapter as AudioEffectDeviceAdapter)
                }
            }
            if (midiEffects.length === 0 && audioEffects.length === 0) {return Option.None}
            const midiEffectMaxIndex = midiEffects.length > 0
                ? midiEffects.reduce((max, adapter) => Math.max(max, adapter.indexField.getValue()), Number.NEGATIVE_INFINITY)
                : 0
            const audioEffectMaxIndex = audioEffects.length > 0
                ? audioEffects.reduce((max, adapter) => Math.max(max, adapter.indexField.getValue()), Number.NEGATIVE_INFINITY)
                : 0
            const deviceBoxes = selected
                .filter(adapter => adapter.type === "midi-effect" || adapter.type === "audio-effect")
                .map(adapter => adapter.box)
            const dependencies = deviceBoxes.flatMap(box =>
                Array.from(boxGraph.dependenciesOf(box, {
                    alwaysFollowMandatory: true,
                    excludeBox: (dep: Box) => dep.ephemeral
                }).boxes))
            const allBoxes = [...deviceBoxes, ...dependencies]
            const metadata: DeviceMetadata = {
                midiEffectCount: midiEffects.length,
                midiEffectMaxIndex,
                audioEffectCount: audioEffects.length,
                audioEffectMaxIndex
            }
            const data = ClipboardUtils.serializeBoxes(allBoxes, encodeMetadata(metadata))
            return Option.wrap({type: "devices", data})
        }
        return {
            canCopy: (): boolean => getEnabled() && selection.nonEmpty(),
            canCut: (): boolean => getEnabled() && selection.nonEmpty(),
            canPaste: (entry: ClipboardEntry): boolean => getEnabled() && entry.type === "devices",
            copy: copyDevices,
            cut: (): Option<ClipboardDevices> => {
                const result = copyDevices()
                result.ifSome(() => editing.modify(() =>
                    selection.selected().forEach(adapter => adapter.box.delete())))
                return result
            },
            paste: (entry: ClipboardEntry): void => {
                if (entry.type !== "devices" || !getEnabled()) {return}
                const optMidiField = getMidiEffectsField()
                const optAudioField = getAudioEffectsField()
                if (optMidiField.isEmpty() && optAudioField.isEmpty()) {return}
                const metadata = decodeMetadata(ClipboardUtils.extractMetadata(entry.data))
                const selected = selection.selected()
                const selectedMidiEffects = selected.filter(adapter => adapter.type === "midi-effect") as MidiEffectDeviceAdapter[]
                const selectedAudioEffects = selected.filter(adapter => adapter.type === "audio-effect") as AudioEffectDeviceAdapter[]
                const midiInsertIndex = selectedMidiEffects.length > 0
                    ? selectedMidiEffects.reduce((max, adapter) => Math.max(max, adapter.indexField.getValue()), -1) + 1
                    : 0
                const audioInsertIndex = selectedAudioEffects.length > 0
                    ? selectedAudioEffects.reduce((max, adapter) => Math.max(max, adapter.indexField.getValue()), -1) + 1
                    : 0
                editing.modify(() => {
                    selection.deselectAll()
                    optMidiField.ifSome(field => {
                        for (const pointer of field.pointerHub.incoming()) {
                            if (DeviceBoxUtils.isEffectDeviceBox(pointer.box)) {
                                const currentIndex = pointer.box.index.getValue()
                                if (currentIndex >= midiInsertIndex) {
                                    pointer.box.index.setValue(currentIndex + metadata.midiEffectCount)
                                }
                            }
                        }
                    })
                    optAudioField.ifSome(field => {
                        for (const pointer of field.pointerHub.incoming()) {
                            if (DeviceBoxUtils.isEffectDeviceBox(pointer.box)) {
                                const currentIndex = pointer.box.index.getValue()
                                if (currentIndex >= audioInsertIndex) {
                                    pointer.box.index.setValue(currentIndex + metadata.audioEffectCount)
                                }
                            }
                        }
                    })
                    let midiIdx = midiInsertIndex
                    let audioIdx = audioInsertIndex
                    const boxes = ClipboardUtils.deserializeBoxes(
                        entry.data,
                        boxGraph,
                        {
                            mapPointer: pointer => {
                                if (pointer.pointerType === Pointers.MIDIEffectHost && optMidiField.nonEmpty()) {
                                    return Option.wrap(optMidiField.unwrap().address)
                                }
                                if (pointer.pointerType === Pointers.AudioEffectHost && optAudioField.nonEmpty()) {
                                    return Option.wrap(optAudioField.unwrap().address)
                                }
                                return Option.None
                            },
                            modifyBox: box => {
                                if (DeviceBoxUtils.isEffectDeviceBox(box)) {
                                    if (box.tags.deviceType === "midi-effect") {
                                        box.index.setValue(midiIdx++)
                                    } else if (box.tags.deviceType === "audio-effect") {
                                        box.index.setValue(audioIdx++)
                                    }
                                }
                            }
                        }
                    )
                    const deviceBoxes = boxes.filter(box => DeviceBoxUtils.isEffectDeviceBox(box))
                    selection.select(...deviceBoxes.map(box => boxAdapters.adapterFor(box, Devices.isAny)))
                })
            }
        }
    }
}
