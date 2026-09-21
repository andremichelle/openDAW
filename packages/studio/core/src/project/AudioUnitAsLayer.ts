import {Attempt, Attempts, isAbsent, isDefined, isInstanceOf, Option, Optional, UUID} from "@opendaw/lib-std"
import {Address, Box, BoxGraph, IndexedBox, PointerField} from "@opendaw/lib-box"
import {AudioUnitType, Pointers} from "@opendaw/studio-enums"
import {
    AudioUnitBox, CaptureAudioBox, CaptureMidiBox, InstrumentCompositeBox, InstrumentCompositeCellBox,
    NoteEventCollectionBox, TrackBox, ValueEventCollectionBox
} from "@opendaw/studio-boxes"
import {InstrumentCompositeBoxAdapter, InstrumentFactories, TrackType, TransferUtils} from "@opendaw/studio-adapters"
import {BoxGraphCopy} from "../BoxGraphCopy"
import type {Project} from "./Project"
import type {CompositeLayerProduct} from "./ProjectApi"
import type {InstrumentBox} from "@opendaw/studio-adapters"

// a copied audio unit ("audio-units" clipboard entry) becomes a new last layer: its instrument, both chains and
// its strip go into the layer, its tracks are appended to the composite's unit, sends and capture are dropped
export namespace AudioUnitAsLayer {
    // what happens to the note and audio tracks when both the clipboard and the composite's unit have content
    export type Notes = "keep" | "replace" | "append"

    const unitOf = (graph: BoxGraph): Optional<AudioUnitBox> => graph.boxes()
        .find((box): box is AudioUnitBox => isInstanceOf(box, AudioUnitBox) && box.type.getValue() !== AudioUnitType.Output)

    const contentTracks = (unit: AudioUnitBox): ReadonlyArray<TrackBox> => IndexedBox.collectIndexedBoxes(unit.tracks)
        .filter((box): box is TrackBox => isInstanceOf(box, TrackBox) && box.type.getValue() !== TrackType.Value)

    export const hasNotes = (unit: AudioUnitBox): boolean => contentTracks(unit)
        .some(track => track.regions.pointerHub.incoming().length > 0 || track.clips.pointerHub.incoming().length > 0)

    export const clipboardHasNotes = (data: ArrayBufferLike): boolean => {
        const unit = unitOf(BoxGraphCopy.readGraph(data))
        return isDefined(unit) && hasNotes(unit)
    }

    const reaches = (box: Box, dropped: Set<Box>, visited: Set<Box> = new Set()): boolean => {
        if (visited.has(box)) {return false}
        visited.add(box)
        for (const [pointer, targetAddress] of box.outgoingEdges()) {
            if (!pointer.mandatory) {continue}
            const target = box.graph.findBox(targetAddress.uuid)
            if (target.isEmpty()) {continue}
            if (dropped.has(target.unwrap()) || reaches(target.unwrap(), dropped, visited)) {return true}
        }
        return false
    }

    const isEmptyTrack = (track: TrackBox): boolean =>
        track.regions.pointerHub.incoming().length === 0 && track.clips.pointerHub.incoming().length === 0

    // the given tracks, everything hanging on them, and the event collections nothing else refers to
    const without = (sources: ReadonlyArray<Box>, tracks: ReadonlyArray<TrackBox>): ReadonlyArray<Box> => {
        if (tracks.length === 0) {return sources}
        const dropped = new Set<Box>(tracks)
        sources.forEach(box => {if (reaches(box, dropped)) {dropped.add(box)}})
        sources.forEach(box => {
            if (!isInstanceOf(box, NoteEventCollectionBox) && !isInstanceOf(box, ValueEventCollectionBox)) {return}
            if (box.incomingEdges().every(pointer => dropped.has(pointer.box))) {dropped.add(box)}
        })
        return sources.filter(box => !dropped.has(box))
    }

    const withoutContent = (sources: ReadonlyArray<Box>, unit: AudioUnitBox): ReadonlyArray<Box> =>
        without(sources, contentTracks(unit))

    const withoutEmptyContent = (sources: ReadonlyArray<Box>, unit: AudioUnitBox): ReadonlyArray<Box> =>
        without(sources, contentTracks(unit).filter(isEmptyTrack))

    export const paste = (project: Project, composite: InstrumentCompositeBox, data: ArrayBufferLike,
                          notes: Notes = "append"): Attempt<CompositeLayerProduct<InstrumentBox>, string> => {
        const sourceGraph = BoxGraphCopy.readGraph(data)
        const sourceUnit = unitOf(sourceGraph)
        if (isAbsent(sourceUnit)) {return Attempts.err("Clipboard holds no audio unit")}
        const instrument = sourceUnit.input.pointerHub.incoming().at(0)?.box
        if (isAbsent(instrument) || instrument.tags.deviceType !== "instrument") {
            return Attempts.err("The audio unit holds no instrument")
        }
        const factoryKey = InstrumentFactories.keyOfBox(instrument)
        if (!isDefined(factoryKey) || !InstrumentFactories.isLayerInstrument(InstrumentFactories.Named[factoryKey])) {
            return Attempts.err(`${instrument.name} cannot be used as a layer`)
        }
        const {boxGraph, boxAdapters} = project
        const targetUnit = boxAdapters.adapterFor(composite, InstrumentCompositeBoxAdapter).audioUnitBoxAdapter().box
        const layers = IndexedBox.collectIndexedBoxes(composite.cells)
        const cellBox = InstrumentCompositeCellBox.create(boxGraph, UUID.generate(), box => {
            box.composite.refer(composite.cells)
            box.index.setValue(layers.length)
            box.gain.setValue(sourceUnit.volume.getValue())
            box.pan.setValue(sourceUnit.panning.getValue())
            box.mute.setValue(sourceUnit.mute.getValue())
            box.solo.setValue(sourceUnit.solo.getValue())
        })
        const complete = sourceGraph.boxes().filter(box => box !== sourceUnit
            && !isInstanceOf(box, CaptureMidiBox) && !isInstanceOf(box, CaptureAudioBox))
        const sources = notes === "keep" ? withoutContent(complete, sourceUnit)
            : notes === "append" ? withoutEmptyContent(complete, sourceUnit) : complete
        if (notes === "replace") {
            contentTracks(targetUnit).forEach(track => track.delete())
            IndexedBox.collectIndexedBoxes(targetUnit.tracks).forEach((track, index) => track.index.setValue(index))
        }
        const uuidMap = TransferUtils.mapUuids(sources)
        const fresh = sources.filter(source =>
            !TransferUtils.keepsIdentity(source) || boxGraph.findBox(source.address.uuid).isEmpty())
        // a note or audio lane targets its unit itself, never the copied unit still living in this project
        const unitFields = new Map<string, Address>([
            [sourceUnit.address.toString(), targetUnit.address],
            [sourceUnit.input.address.toString(), cellBox.instrument.address],
            [sourceUnit.midiEffects.address.toString(), cellBox.midiEffects.address],
            [sourceUnit.audioEffects.address.toString(), cellBox.audioEffects.address],
            [sourceUnit.tracks.address.toString(), targetUnit.tracks.address],
            [sourceUnit.volume.address.toString(), cellBox.gain.address],
            [sourceUnit.panning.address.toString(), cellBox.pan.address],
            [sourceUnit.mute.address.toString(), cellBox.mute.address],
            [sourceUnit.solo.address.toString(), cellBox.solo.address]
        ])
        const existingTracks = IndexedBox.collectIndexedBoxes(targetUnit.tracks).length
        PointerField.decodeWith({
            map: (pointer: PointerField, address: Option<Address>): Option<Address> => {
                const internal = address.flatMap(addr => uuidMap.opt(addr.uuid).map(({target}) => addr.moveTo(target)))
                if (internal.nonEmpty()) {return internal}
                const unitField = address.flatMap(addr => Option.wrap(unitFields.get(addr.toString())))
                if (unitField.nonEmpty()) {return unitField}
                return address.flatMap(addr => boxGraph.findBox(addr.uuid).nonEmpty()
                    ? Option.wrap(addr)
                    : TransferUtils.mapModulatorCollection(pointer, boxGraph))
            }
        }, () => TransferUtils.cloneBoxes(fresh, uuidMap, boxGraph))
        sources.filter((box): box is TrackBox => isInstanceOf(box, TrackBox))
            .sort((left, right) => left.index.getValue() - right.index.getValue())
            .forEach((source, offset) => boxGraph.findBox(uuidMap.get(source.address.uuid, "track").target)
                .ifSome((track: Box) => (track as TrackBox).index.setValue(existingTracks + offset)))
        const instrumentBox = boxGraph.findBox(uuidMap.get(instrument.address.uuid, "instrument").target)
            .unwrap("pasted instrument") as InstrumentBox
        return Attempts.ok({cellBox, instrumentBox})
    }
}
