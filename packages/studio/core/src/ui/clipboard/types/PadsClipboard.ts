import {asInstanceOf, isAbsent, Option, UUID} from "@opendaw/lib-std"
import {AudioUnitType} from "@opendaw/studio-enums"
import {AudioUnitBox, InstrumentCompositeCellBox, TrackBox} from "@opendaw/studio-boxes"
import {PlayfieldPads, TrackType} from "@opendaw/studio-adapters"
import {ClipboardUtils} from "../ClipboardUtils"
import {BoxGraphCopy} from "../../../BoxGraphCopy"
import {DevicesClipboard} from "./DevicesClipboardHandler"
import {AudioUnitsClipboard, ClipboardAudioUnits} from "./AudioUnitsClipboardHandler"

// a pad copies as an audio unit holding its instrument, chains and mix, automation lanes stay behind
export namespace PadsClipboard {
    export const copyEntry = (cell: InstrumentCompositeCellBox, unit: AudioUnitBox): Option<ClipboardAudioUnits> => {
        if (!PlayfieldPads.isPad(cell) || isAbsent(cell.instrument.pointerHub.incoming().at(0))) {return Option.None}
        const capture = unit.capture.targetVertex.mapOr(({box}) => [box], [])
        const dependencies = DevicesClipboard.collectDeviceDependencies([cell], cell.graph)
        const graph = BoxGraphCopy.readGraph(ClipboardUtils.serializeBoxes([unit, ...capture, cell, ...dependencies]))
        graph.beginTransaction()
        const unitCopy = asInstanceOf(graph.findBox(unit.address.uuid).unwrap("unit copy"), AudioUnitBox)
        const cellCopy = asInstanceOf(graph.findBox(cell.address.uuid).unwrap("pad copy"), InstrumentCompositeCellBox)
        cellCopy.instrument.pointerHub.incoming().forEach(pointer => pointer.refer(unitCopy.input))
        cellCopy.midiEffects.pointerHub.incoming().forEach(pointer => pointer.refer(unitCopy.midiEffects))
        cellCopy.audioEffects.pointerHub.incoming().forEach(pointer => pointer.refer(unitCopy.audioEffects))
        unitCopy.volume.setValue(cellCopy.gain.getValue())
        unitCopy.panning.setValue(cellCopy.pan.getValue())
        unitCopy.mute.setValue(cellCopy.mute.getValue())
        unitCopy.solo.setValue(cellCopy.solo.getValue())
        TrackBox.create(graph, UUID.generate(), box => {
            box.type.setValue(TrackType.Notes)
            box.tracks.refer(unitCopy.tracks)
            box.target.refer(unitCopy)
        })
        cellCopy.delete()
        graph.endTransaction()
        return Option.wrap(AudioUnitsClipboard.entryOf(graph.boxes(), AudioUnitType.Instrument))
    }
}
