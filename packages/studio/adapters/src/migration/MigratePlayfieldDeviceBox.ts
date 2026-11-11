import {BoxGraph, Field, PointerField, Vertex} from "@opendaw/lib-box"
import {asInstanceOf, isInstanceOf, Option, UUID} from "@opendaw/lib-std"
import {
    AudioFileBox,
    BoxIO,
    InstrumentCompositeCellBox,
    NanoDeviceBox,
    PlayfieldDeviceBox,
    PlayfieldSampleBox
} from "@opendaw/studio-boxes"
import {migrateAutomation} from "./MigrateAutomation"
import {PlayfieldPads} from "../devices/instruments/Playfield/PlayfieldPads"

const GateOff = 0
const GateLoop = 2
const SlotReleaseMax = 5.0
const NanoReleaseMax = 8.0
const ReleaseMin = 0.001

export const migrateSlotReleaseUnit = (unit: number): number => {
    const seconds = ReleaseMin * Math.pow(SlotReleaseMax / ReleaseMin, unit)
    return Math.log(seconds / ReleaseMin) / Math.log(NanoReleaseMax / ReleaseMin)
}

const retarget = (pointer: PointerField, slot: PlayfieldSampleBox, cell: InstrumentCompositeCellBox,
                  nano: NanoDeviceBox): Option<Vertex> => {
    const keys = pointer.targetAddress.unwrap("pointer target").fieldKeys
    if (keys.length === 0) {return Option.wrap(cell)}
    const fields: ReadonlyArray<[Field, Vertex]> = [
        [slot.mute, cell.mute], [slot.solo, cell.solo], [slot.exclude, cell.exclude],
        [slot.volume, cell.gain], [slot.panning, cell.pan], [slot.polyphone, nano.polyphone],
        [slot.pitch, nano.tune], [slot.sampleStart, nano.sampleStart], [slot.sampleEnd, nano.sampleEnd],
        [slot.attack, nano.attack], [slot.release, nano.release]
    ]
    return Option.wrap(fields.find(([field]) => field.fieldKey === keys[0])?.[1])
}

const migrateSlot = (boxGraph: BoxGraph<BoxIO.TypeMap>, playfield: PlayfieldDeviceBox, slot: PlayfieldSampleBox): void => {
    const gate = slot.gate.getValue()
    const sampleStart = slot.sampleStart.getValue()
    const sampleEnd = slot.sampleEnd.getValue()
    const file = slot.file.targetVertex.map(vertex => asInstanceOf(vertex.box, AudioFileBox))
    const cell = InstrumentCompositeCellBox.create(boxGraph, UUID.generate(), box => {
        box.composite.refer(playfield.pads)
        box.index.setValue(slot.index.getValue())
        box.key.setValue(PlayfieldPads.DefaultKey)
        box.minimized.setValue(slot.minimized.getValue())
        box.gain.setValue(slot.volume.getValue())
        box.pan.setValue(slot.panning.getValue())
        box.mute.setValue(slot.mute.getValue())
        box.solo.setValue(slot.solo.getValue())
        box.exclude.setValue(slot.exclude.getValue())
    })
    const nano = NanoDeviceBox.create(boxGraph, UUID.generate(), box => {
        box.host.refer(cell.instrument)
        file.ifSome(fileBox => {
            box.file.refer(fileBox)
            box.label.setValue(fileBox.fileName.getValue())
        })
        box.icon.setValue(slot.icon.getValue())
        box.enabled.setValue(slot.enabled.getValue())
        PlayfieldPads.applyPadMode(box)
        box.tune.setValue(slot.pitch.getValue())
        box.attack.setValue(slot.attack.getValue())
        box.release.setValue(slot.release.getValue())
        box.sampleStart.setValue(sampleStart)
        box.sampleEnd.setValue(sampleEnd)
        box.loop.setValue(gate === GateLoop)
        box.polyphone.setValue(slot.polyphone.getValue())
        box.oneShot.setValue(gate === GateOff)
    })
    slot.midiEffects.pointerHub.incoming().forEach(pointer => pointer.refer(cell.midiEffects))
    slot.audioEffects.pointerHub.incoming().forEach(pointer => pointer.refer(cell.audioEffects))
    migrateAutomation(boxGraph, slot.release, migrateSlotReleaseUnit)
    if (slot.gate.pointerHub.nonEmpty()) {
        console.warn(`Migrate 'PlayfieldSampleBox' gate automation on key ${slot.index.getValue()} is dropped, a pad plays one mode`)
    }
    slot.incomingEdges().forEach(pointer => {
        retarget(pointer, slot, cell, nano).ifSome(target => pointer.refer(target))
    })
    slot.delete()
}

// every slot becomes a cell hosting a Nano that plays like the slot, every pointer follows
export const migratePlayfieldDeviceBox = (boxGraph: BoxGraph<BoxIO.TypeMap>, box: PlayfieldDeviceBox): void => {
    const slots = box.samples.pointerHub.incoming()
        .map(pointer => pointer.box)
        .filter(slot => isInstanceOf(slot, PlayfieldSampleBox))
        .map(slot => asInstanceOf(slot, PlayfieldSampleBox))
    if (slots.length === 0) {return}
    console.debug(`Migrate 'PlayfieldDeviceBox' ${slots.length} slot(s) to Nano pads`)
    boxGraph.beginTransaction()
    slots.forEach(slot => migrateSlot(boxGraph, box, slot))
    boxGraph.endTransaction()
}
