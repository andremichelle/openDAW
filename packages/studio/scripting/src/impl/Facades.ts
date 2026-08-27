import {Box, Field, PointerField, Vertex} from "@opendaw/lib-box"
import {
    AudioBusBox,
    AudioEffectCompositeCellBox,
    AudioUnitBox,
    AuxSendBox,
    GrooveShuffleBox,
    LfoModulatorBox,
    MacroModulatorBox,
    MarkerBox,
    MIDIOutputParameterBox,
    ModulationBox,
    NoteEventBox,
    PlayfieldSampleBox,
    RandomModulatorBox,
    StepsModulatorBox,
    TrackBox,
    ValueEventBox,
    WerkstattParameterBox,
    WerkstattSampleBox
} from "@opendaw/studio-boxes"
import {isDefined, isNull, Nullable, Optional, panic} from "@opendaw/lib-std"
import {Context} from "./Context"
import {Facade} from "./Common"
import {AnyAudioUnit} from "../Api"
import {AudioEffectCompositeEntryImpl, AudioEffectImpls, CompositeBox} from "./devices/AudioEffects"
import {MIDIEffectImpls} from "./devices/MIDIEffects"
import {InstrumentImpls, MIDIOutputParameterImpl, PlayfieldSlotImpl} from "./devices/Instruments"
import {ScriptParameterImpl, ScriptSampleImpl} from "./devices/ScriptDevices"
import {AudioUnitImpls} from "./AudioUnits"
import {SendImpl} from "./Sends"
import {GrooveShuffleImpl} from "./GrooveShuffleImpl"
import {ModulationImpl, ModulatorImpls} from "./Modulators"
import {TrackImpls} from "./timeline/Tracks"
import {MarkerImpl} from "./timeline/Markers"
import {NoteEventImpl, ValueEventImpl} from "./timeline/Events"

export namespace Facades {
    const pointerNamed = (box: Box, name: string): Optional<PointerField> =>
        box.fields().find(field => field.fieldName === name && field instanceof PointerField) as Optional<PointerField>

    export const parentBox = (box: Box): Nullable<Box> => {
        const pointer = pointerNamed(box, "host") ?? pointerNamed(box, "device") ?? pointerNamed(box, "composite")
            ?? pointerNamed(box, "audio-unit") ?? pointerNamed(box, "owner")
        if (!isDefined(pointer)) {return null}
        return pointer.targetVertex.mapOr(vertex => vertex.box, null)
    }

    export const audioUnitBoxOf = (box: Box): AudioUnitBox => {
        let current: Nullable<Box> = box
        while (!isNull(current)) {
            if (current instanceof AudioUnitBox) {return current}
            if (current instanceof AudioBusBox) {
                return current.output.targetVertex.mapOr(vertex => vertex.box, null) as AudioUnitBox
            }
            current = parentBox(current)
        }
        return panic(`${box.name} does not belong to an audio unit`)
    }

    export const audioUnitOf = (context: Context, box: Box): AnyAudioUnit =>
        AudioUnitImpls.wrap(context, audioUnitBoxOf(box))

    export const forBox = (context: Context, box: Box): Nullable<object> => {
        if (box instanceof AudioUnitBox) {return AudioUnitImpls.wrap(context, box)}
        if (box instanceof AudioBusBox) {return AudioUnitImpls.wrap(context, audioUnitBoxOf(box))}
        if (InstrumentImpls.isBox(box)) {return InstrumentImpls.wrap(context, box)}
        if (MIDIEffectImpls.isBox(box)) {return MIDIEffectImpls.wrap(context, box)}
        if (AudioEffectImpls.isBox(box)) {return AudioEffectImpls.wrap(context, box)}
        if (box instanceof PlayfieldSampleBox) {return PlayfieldSlotImpl.wrap(context, box)}
        if (box instanceof AudioEffectCompositeCellBox) {return AudioEffectCompositeEntryImpl.wrap(context, box)}
        if (box instanceof AuxSendBox) {return SendImpl.wrap(context, box)}
        if (box instanceof WerkstattParameterBox) {return ScriptParameterImpl.wrap(context, box)}
        if (box instanceof WerkstattSampleBox) {return ScriptSampleImpl.wrap(context, box)}
        if (box instanceof MIDIOutputParameterBox) {return MIDIOutputParameterImpl.wrap(context, box)}
        if (box instanceof GrooveShuffleBox) {return GrooveShuffleImpl.wrap(context, box)}
        if (box instanceof LfoModulatorBox || box instanceof StepsModulatorBox
            || box instanceof MacroModulatorBox || box instanceof RandomModulatorBox) {
            return ModulatorImpls.wrap(context, box)
        }
        if (box instanceof ModulationBox) {return ModulationImpl.wrap(context, box)}
        if (box instanceof TrackBox) {return TrackImpls.wrap(context, box)}
        if (box instanceof MarkerBox) {return MarkerImpl.wrap(context, box)}
        if (box instanceof NoteEventBox) {return NoteEventImpl.wrap(context, box)}
        if (box instanceof ValueEventBox) {return ValueEventImpl.wrap(context, box)}
        return null
    }

    export const forVertex = (context: Context, vertex: Vertex): Nullable<object> => {
        if (vertex.isBox()) {return forBox(context, vertex)}
        return forBox(context, vertex.box)
    }

    export const boxOf = (facade: unknown): Box => {
        if (facade instanceof Facade) {return facade.box}
        return panic(new TypeError(`Expected an openDAW object, got ${describe(facade)}`))
    }

    export const isCompositeBox = (box: Box): box is CompositeBox => AudioEffectImpls.isCompositeBox(box)

    export const compositeInputField = (box: CompositeBox): Field => box.input

    export const isNestedIn = (owner: Box, composite: CompositeBox): boolean => {
        let current: Nullable<Box> = parentBox(owner)
        while (!isNull(current)) {
            if (current === composite) {return true}
            if (current instanceof AudioUnitBox) {return false}
            current = parentBox(current)
        }
        return false
    }

    const describe = (value: unknown): string => {
        if (isNull(value)) {return "null"}
        if (!isDefined(value)) {return "undefined"}
        return typeof value === "object" ? value.constructor.name : typeof value
    }
}
