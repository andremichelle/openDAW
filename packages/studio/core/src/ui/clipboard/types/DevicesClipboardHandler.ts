import {ByteArrayInput, ByteArrayOutput, int, isDefined, Option, Optional, Provider, RuntimeNotifier} from "@opendaw/lib-std"
import {Box, BoxEditing, BoxGraph} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {
    AudioEffectDeviceAdapter,
    BoxAdapters,
    DeviceBoxAdapter,
    DeviceBoxUtils,
    DeviceHost,
    Devices,
    EffectDeviceBox,
    FilteredSelection,
    InstrumentDeviceBoxAdapter,
    MidiEffectDeviceAdapter
} from "@opendaw/studio-adapters"
import {ClipboardEntry, ClipboardHandler} from "../ClipboardManager"
import {ClipboardUtils} from "../ClipboardUtils"

type ClipboardDevices = ClipboardEntry<"devices">

type InstrumentContent = "notes" | "audio"

type DeviceMetadata = {
    hasInstrument: boolean
    instrumentContent: InstrumentContent | ""
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
        readonly getHost: Provider<Option<DeviceHost>>
    }

    const encodeMetadata = (metadata: DeviceMetadata): ArrayBufferLike => {
        const output = ByteArrayOutput.create()
        output.writeBoolean(metadata.hasInstrument)
        output.writeString(metadata.instrumentContent)
        output.writeInt(metadata.midiEffectCount)
        output.writeInt(metadata.midiEffectMaxIndex)
        output.writeInt(metadata.audioEffectCount)
        output.writeInt(metadata.audioEffectMaxIndex)
        return output.toArrayBuffer()
    }

    const decodeMetadata = (buffer: ArrayBufferLike): DeviceMetadata => {
        const input = new ByteArrayInput(buffer)
        return {
            hasInstrument: input.readBoolean(),
            instrumentContent: input.readString() as InstrumentContent | "",
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
                                      getHost
                                  }: Context): ClipboardHandler<ClipboardDevices> => {
        const isCopyable = (adapter: DeviceBoxAdapter): boolean => adapter.box.tags.copyable !== false
        const copyableSelected = (): ReadonlyArray<DeviceBoxAdapter> => selection.selected().filter(isCopyable)
        const copyDevices = (): Option<ClipboardDevices> => {
            const selected = copyableSelected()
            if (selected.length === 0) {return Option.None}
            let instrument: InstrumentDeviceBoxAdapter | null = null
            const midiEffects: Array<MidiEffectDeviceAdapter> = []
            const audioEffects: Array<AudioEffectDeviceAdapter> = []
            for (const adapter of selected) {
                if (adapter.type === "instrument") {
                    instrument = adapter as InstrumentDeviceBoxAdapter
                } else if (adapter.type === "midi-effect") {
                    midiEffects.push(adapter as MidiEffectDeviceAdapter)
                } else if (adapter.type === "audio-effect") {
                    audioEffects.push(adapter as AudioEffectDeviceAdapter)
                }
            }
            if (instrument === null && midiEffects.length === 0 && audioEffects.length === 0) {return Option.None}
            midiEffects.sort((a, b) => a.indexField.getValue() - b.indexField.getValue())
            audioEffects.sort((a, b) => a.indexField.getValue() - b.indexField.getValue())
            const midiEffectMaxIndex = midiEffects.length > 0
                ? midiEffects[midiEffects.length - 1].indexField.getValue()
                : 0
            const audioEffectMaxIndex = audioEffects.length > 0
                ? audioEffects[audioEffects.length - 1].indexField.getValue()
                : 0
            const deviceBoxes = [
                ...(instrument !== null ? [instrument.box] : []),
                ...midiEffects.map(adapter => adapter.box),
                ...audioEffects.map(adapter => adapter.box)
            ]
            const dependencies = deviceBoxes.flatMap(box =>
                Array.from(boxGraph.dependenciesOf(box, {
                    alwaysFollowMandatory: true,
                    excludeBox: (dep: Box) => dep.ephemeral || DeviceBoxUtils.isDeviceBox(dep)
                }).boxes).filter(dep => dep.resource === "external"))
            const allBoxes = [...deviceBoxes, ...dependencies]
            const instrumentContent = instrument !== null
                ? (instrument.box.tags.content as Optional<InstrumentContent>) ?? ""
                : ""
            const metadata: DeviceMetadata = {
                hasInstrument: instrument !== null,
                instrumentContent,
                midiEffectCount: midiEffects.length,
                midiEffectMaxIndex,
                audioEffectCount: audioEffects.length,
                audioEffectMaxIndex
            }
            const data = ClipboardUtils.serializeBoxes(allBoxes, encodeMetadata(metadata))
            return Option.wrap({type: "devices", data})
        }
        return {
            canCopy: (): boolean => getEnabled() && copyableSelected().length > 0,
            canCut: (): boolean => getEnabled() && copyableSelected().length > 0,
            canPaste: (entry: ClipboardEntry): boolean => getEnabled() && entry.type === "devices",
            copy: copyDevices,
            cut: (): Option<ClipboardDevices> => {
                const result = copyDevices()
                result.ifSome(() => {
                    const optHost = getHost()
                    if (optHost.isEmpty()) {return}
                    const host = optHost.unwrap()
                    const selected = new Set(selection.selected().filter(adapter => adapter.type !== "instrument"))
                    const remainingMidi = host.midiEffects.adapters().filter(adapter => !selected.has(adapter))
                    const remainingAudio = host.audioEffects.adapters().filter(adapter => !selected.has(adapter))
                    editing.modify(() => {
                        selected.forEach(adapter => adapter.box.delete())
                        remainingMidi.forEach((adapter, index) => adapter.indexField.setValue(index))
                        remainingAudio.forEach((adapter, index) => adapter.indexField.setValue(index))
                    })
                })
                return result
            },
            paste: (entry: ClipboardEntry): void => {
                if (entry.type !== "devices" || !getEnabled()) {return}
                const optHost = getHost()
                if (optHost.isEmpty()) {return}
                const host = optHost.unwrap()
                const metadata = decodeMetadata(ClipboardUtils.extractMetadata(entry.data))
                const selected = selection.selected()
                const selectedInstrument = selected.find(adapter => adapter.type === "instrument")
                const selectedMidiEffects = selected.filter(adapter => adapter.type === "midi-effect") as MidiEffectDeviceAdapter[]
                const selectedAudioEffects = selected.filter(adapter => adapter.type === "audio-effect") as AudioEffectDeviceAdapter[]
                let replaceInstrument = metadata.hasInstrument && isDefined(selectedInstrument)
                    && selectedInstrument.box.tags.copyable !== false
                if (replaceInstrument && isDefined(selectedInstrument)) {
                    const selectedContent = selectedInstrument.box.tags.content as Optional<InstrumentContent>
                    if (isDefined(selectedContent) && metadata.instrumentContent !== ""
                        && selectedContent !== metadata.instrumentContent) {
                        RuntimeNotifier.info({
                            headline: "Incompatible Instrument",
                            message: `Cannot replace a '${selectedContent}' instrument with a '${metadata.instrumentContent}' instrument.`
                        }).finally()
                        replaceInstrument = false
                    }
                }
                const midiInsertIndex = selectedMidiEffects.length > 0
                    ? selectedMidiEffects.reduce((max, adapter) => Math.max(max, adapter.indexField.getValue()), -1) + 1
                    : 0
                const audioInsertIndex = selectedAudioEffects.length > 0
                    ? selectedAudioEffects.reduce((max, adapter) => Math.max(max, adapter.indexField.getValue()), -1) + 1
                    : 0
                editing.modify(() => {
                    selection.deselectAll()
                    if (replaceInstrument && isDefined(selectedInstrument)) {
                        selectedInstrument.box.delete()
                    }
                    for (const adapter of host.midiEffects.adapters()) {
                        const currentIndex = adapter.indexField.getValue()
                        if (currentIndex >= midiInsertIndex) {
                            adapter.indexField.setValue(currentIndex + metadata.midiEffectCount)
                        }
                    }
                    for (const adapter of host.audioEffects.adapters()) {
                        const currentIndex = adapter.indexField.getValue()
                        if (currentIndex >= audioInsertIndex) {
                            adapter.indexField.setValue(currentIndex + metadata.audioEffectCount)
                        }
                    }
                    const boxes = ClipboardUtils.deserializeBoxes(
                        entry.data,
                        boxGraph,
                        {
                            mapPointer: pointer => {
                                if (pointer.pointerType === Pointers.InstrumentHost && replaceInstrument) {
                                    return Option.wrap(host.inputField.address)
                                }
                                if (pointer.pointerType === Pointers.MIDIEffectHost) {
                                    return Option.wrap(host.midiEffectsField.address)
                                }
                                if (pointer.pointerType === Pointers.AudioEffectHost) {
                                    return Option.wrap(host.audioEffectsField.address)
                                }
                                return Option.None
                            },
                            excludeBox: box => DeviceBoxUtils.isInstrumentDeviceBox(box) && !replaceInstrument
                        }
                    )
                    const deviceBoxes = boxes.filter(box => DeviceBoxUtils.isDeviceBox(box))
                    const newMidiEffects = deviceBoxes
                        .filter((box): box is EffectDeviceBox =>
                            DeviceBoxUtils.isEffectDeviceBox(box) && box.tags.deviceType === "midi-effect")
                        .sort((a, b) => a.index.getValue() - b.index.getValue())
                    const newAudioEffects = deviceBoxes
                        .filter((box): box is EffectDeviceBox =>
                            DeviceBoxUtils.isEffectDeviceBox(box) && box.tags.deviceType === "audio-effect")
                        .sort((a, b) => a.index.getValue() - b.index.getValue())
                    newMidiEffects.forEach((box, idx) => box.index.setValue(midiInsertIndex + idx))
                    newAudioEffects.forEach((box, idx) => box.index.setValue(audioInsertIndex + idx))
                    selection.select(...deviceBoxes.map(box => boxAdapters.adapterFor(box, Devices.isAny)))
                })
            }
        }
    }
}
