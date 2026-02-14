import {ByteArrayInput, ByteArrayOutput, int, Option, Optional, Provider} from "@opendaw/lib-std"
import {Box, BoxEditing, BoxGraph, IndexedBox} from "@opendaw/lib-box"
import {AudioUnitType, Pointers} from "@opendaw/studio-enums"
import {
    AudioBusBox,
    AudioUnitBox,
    AuxSendBox,
    CaptureAudioBox,
    CaptureMidiBox,
    MIDIControllerBox,
    RootBox
} from "@opendaw/studio-boxes"
import {AudioUnitBoxAdapter, AudioUnitOrdering, RootBoxAdapter, UserEditing} from "@opendaw/studio-adapters"
import {ClipboardEntry, ClipboardHandler} from "../ClipboardManager"
import {ClipboardUtils} from "../ClipboardUtils"

type ClipboardAudioUnits = ClipboardEntry<"audio-units">

type AudioUnitMetadata = {
    readonly type: AudioUnitType
}

export namespace AudioUnitsClipboard {
    export type Context = {
        readonly getEnabled: Provider<boolean>
        readonly editing: BoxEditing
        readonly boxGraph: BoxGraph
        readonly rootBoxAdapter: RootBoxAdapter
        readonly audioUnitEditing: UserEditing
        readonly getEditedAudioUnit: Provider<Option<AudioUnitBoxAdapter>>
    }

    const encodeMetadata = (metadata: AudioUnitMetadata): ArrayBufferLike => {
        const output = ByteArrayOutput.create()
        output.writeString(metadata.type)
        return output.toArrayBuffer()
    }

    const decodeMetadata = (buffer: ArrayBufferLike): AudioUnitMetadata => {
        const input = new ByteArrayInput(buffer)
        return {type: input.readString() as AudioUnitType}
    }

    export const createHandler = ({
                                      getEnabled,
                                      editing,
                                      boxGraph,
                                      rootBoxAdapter,
                                      audioUnitEditing,
                                      getEditedAudioUnit
                                  }: Context): ClipboardHandler<ClipboardAudioUnits> => {
        const copyAudioUnit = (): Option<ClipboardAudioUnits> => {
            const optAudioUnit = getEditedAudioUnit()
            if (optAudioUnit.isEmpty()) {return Option.None}
            const audioUnitAdapter = optAudioUnit.unwrap()
            const audioUnitBox = audioUnitAdapter.box
            const isOutput = audioUnitAdapter.type === AudioUnitType.Output
            const dependencies = Array.from(audioUnitBox.graph.dependenciesOf(audioUnitBox, {
                alwaysFollowMandatory: true,
                stopAtResources: true,
                excludeBox: (box: Box) => {
                    if (box.ephemeral) {return true}
                    if (box.name === RootBox.ClassName) {return true}
                    if (box.name === AudioBusBox.ClassName) {return true}
                    if (box.name === AuxSendBox.ClassName) {return true}
                    if (box.name === MIDIControllerBox.ClassName) {return true}
                    if (isOutput && box.name === CaptureAudioBox.ClassName) {return true}
                    if (isOutput && box.name === CaptureMidiBox.ClassName) {return true}
                    return false
                }
            }).boxes)
            const metadata: AudioUnitMetadata = {type: audioUnitAdapter.type}
            const allBoxes = [audioUnitBox, ...dependencies]
            const data = ClipboardUtils.serializeBoxes(allBoxes, encodeMetadata(metadata))
            return Option.wrap({type: "audio-units", data})
        }
        return {
            canCopy: (): boolean => getEnabled() && getEditedAudioUnit().nonEmpty(),
            canCut: (): boolean => {
                if (!getEnabled()) {return false}
                const optAudioUnit = getEditedAudioUnit()
                if (optAudioUnit.isEmpty()) {return false}
                return !optAudioUnit.unwrap().isOutput
            },
            canPaste: (entry: ClipboardEntry): boolean => getEnabled() && entry.type === "audio-units",
            copy: copyAudioUnit,
            cut: (): Option<ClipboardAudioUnits> => {
                const optAudioUnit = getEditedAudioUnit()
                if (optAudioUnit.isEmpty()) {return Option.None}
                const audioUnit = optAudioUnit.unwrap()
                if (audioUnit.isOutput) {return Option.None}
                const result = copyAudioUnit()
                result.ifSome(() => {
                    editing.modify(() => {
                        audioUnit.box.delete()
                        rootBoxAdapter.audioUnits.adapters()
                            .forEach((adapter, index) => adapter.indexField.setValue(index))
                    })
                })
                return result
            },
            paste: (entry: ClipboardEntry): void => {
                if (entry.type !== "audio-units" || !getEnabled()) {return}
                const metadata = decodeMetadata(ClipboardUtils.extractMetadata(entry.data))
                const isOutputPaste = metadata.type === AudioUnitType.Output
                if (isOutputPaste) {
                    // Split into two transactions to ensure deletion notifications fire
                    // before new boxes are created (avoids "already has input" conflict)
                    editing.modify(() => clearOutputContent(rootBoxAdapter), false)
                    editing.modify(() => pasteOutputContent(entry.data, boxGraph, rootBoxAdapter))
                } else {
                    editing.modify(() => {
                        const pastedBox = pasteNewAudioUnit(entry.data, boxGraph, rootBoxAdapter, getEditedAudioUnit())
                        if (pastedBox) {
                            audioUnitEditing.edit(pastedBox.editing)
                        }
                    })
                }
            }
        }
    }

    const clearOutputContent = (rootBoxAdapter: RootBoxAdapter): void => {
        const outputAdapter = rootBoxAdapter.audioUnits.adapters().find(adapter => adapter.isOutput)
        if (!outputAdapter) {return}
        outputAdapter.tracks.collection.adapters().forEach(track => track.box.delete())
        const inputAdapter = outputAdapter.input.adapter()
        if (inputAdapter.nonEmpty() && inputAdapter.unwrap().type === "instrument") {
            inputAdapter.unwrap().box.delete()
        }
        outputAdapter.midiEffects.adapters().forEach(effect => effect.box.delete())
        outputAdapter.audioEffects.adapters().forEach(effect => effect.box.delete())
    }

    const pasteOutputContent = (data: ArrayBufferLike,
                                boxGraph: BoxGraph,
                                rootBoxAdapter: RootBoxAdapter): void => {
        const outputAdapter = rootBoxAdapter.audioUnits.adapters().find(adapter => adapter.isOutput)
        if (!outputAdapter) {return}
        const outputBox = outputAdapter.box
        const primaryBusAddress = rootBoxAdapter.audioBusses.adapters().at(0)?.address
        if (!primaryBusAddress) {return}
        ClipboardUtils.deserializeBoxes(
            data,
            boxGraph,
            {
                mapPointer: (pointer, address) => {
                    if (pointer.pointerType === Pointers.TrackCollection) {
                        return Option.wrap(outputBox.tracks.address)
                    }
                    if (pointer.pointerType === Pointers.InstrumentHost) {
                        return Option.wrap(outputBox.input.address)
                    }
                    if (pointer.pointerType === Pointers.MIDIEffectHost) {
                        return Option.wrap(outputBox.midiEffects.address)
                    }
                    if (pointer.pointerType === Pointers.AudioEffectHost) {
                        return Option.wrap(outputBox.audioEffects.address)
                    }
                    if (pointer.pointerType === Pointers.AudioOutput) {
                        return address.map(addr => addr.moveTo(primaryBusAddress.uuid))
                    }
                    if (pointer.pointerType === Pointers.MIDIDevice) {
                        return Option.wrap(rootBoxAdapter.box.outputMidiDevices.address)
                    }
                    return Option.None
                },
                excludeBox: box => box.name === AudioUnitBox.ClassName || box.name === AudioBusBox.ClassName || box.name === RootBox.ClassName
            }
        )
    }

    const pasteNewAudioUnit = (data: ArrayBufferLike,
                               boxGraph: BoxGraph,
                               rootBoxAdapter: RootBoxAdapter,
                               currentAudioUnit: Option<AudioUnitBoxAdapter>): Optional<AudioUnitBox> => {
        const rootBox = rootBoxAdapter.box
        const primaryBusAddress = rootBoxAdapter.audioBusses.adapters().at(0)?.address
        if (!primaryBusAddress) {return undefined}
        const boxes = ClipboardUtils.deserializeBoxes(
            data,
            boxGraph,
            {
                mapPointer: (pointer, address) => {
                    if (pointer.pointerType === Pointers.AudioUnits) {
                        return Option.wrap(rootBox.audioUnits.address)
                    }
                    if (pointer.pointerType === Pointers.AudioOutput) {
                        return address.map(addr => addr.moveTo(primaryBusAddress.uuid))
                    }
                    if (pointer.pointerType === Pointers.MIDIDevice) {
                        return Option.wrap(rootBox.outputMidiDevices.address)
                    }
                    return Option.None
                }
            }
        )
        const pastedAudioUnit = boxes.find(box => box.name === AudioUnitBox.ClassName) as AudioUnitBox | undefined
        if (!pastedAudioUnit) {return undefined}
        const insertAfterIndex = currentAudioUnit
            .map(adapter => adapter.indexField.getValue())
            .unwrapOrElse(() => -1)
        reorderAudioUnitsAfterPaste(pastedAudioUnit, insertAfterIndex, rootBoxAdapter)
        return pastedAudioUnit
    }

    const reorderAudioUnitsAfterPaste = (pastedAudioUnit: AudioUnitBox,
                                         insertAfterIndex: int,
                                         rootBoxAdapter: RootBoxAdapter): void => {
        const rootBox = rootBoxAdapter.box
        const allAudioUnits = IndexedBox.collectIndexedBoxes(rootBox.audioUnits, AudioUnitBox)
        allAudioUnits.toSorted((a, b) => {
            const orderA = AudioUnitOrdering[a.type.getValue()]
            const orderB = AudioUnitOrdering[b.type.getValue()]
            const orderDiff = orderA - orderB
            if (orderDiff !== 0) {return orderDiff}
            const aIsPasted = a === pastedAudioUnit
            const bIsPasted = b === pastedAudioUnit
            if (aIsPasted && !bIsPasted) {
                if (insertAfterIndex === -1) {return -1}
                return b.index.getValue() <= insertAfterIndex ? 1 : -1
            }
            if (bIsPasted && !aIsPasted) {
                if (insertAfterIndex === -1) {return 1}
                return a.index.getValue() <= insertAfterIndex ? -1 : 1
            }
            return a.index.getValue() - b.index.getValue()
        }).forEach((box, index) => box.index.setValue(index))
    }
}