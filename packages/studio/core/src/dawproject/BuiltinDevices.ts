import {ifDefined, int, isDefined, UUID} from "@opendaw/lib-std"
import {Xml} from "@opendaw/lib-xml"
import {BoxGraph, Field} from "@opendaw/lib-box"
import {BoolParameterSchema, EqBandSchema, EqBandType, EqualizerSchema, ParameterDecoder, RealParameterSchema, Unit} from "@opendaw/lib-dawproject"
import {Pointers} from "@opendaw/studio-enums"
import {RevampBell, RevampDeviceBox, RevampPass, RevampShelf} from "@opendaw/studio-boxes"
import {DawProjectIds} from "./DawProjectIds"
import {EffectParameterDefaults} from "../EffectParameterDefaults"

export namespace BuiltinDevices {
    export const equalizer = (boxGraph: BoxGraph,
                              equalizer: EqualizerSchema,
                              field: Field<Pointers.MIDIEffectHost> | Field<Pointers.AudioEffectHost>,
                              index: int): RevampDeviceBox => {
        const mapOrder = (order?: int) => {
            switch (order) {
                case 1:
                case 2:
                    return 0
                case 3:
                case 4:
                    return 1
                case 5:
                case 6:
                    return 2
                default:
                    return 3
            }
        }
        const readPass = (schema: EqBandSchema, pass: RevampPass) => {
            const {order, frequency, q, enabled} = pass
            order.setValue(mapOrder(schema.order))
            if (isDefined(schema.freq?.value)) {frequency.setValue(ParameterDecoder.readValue(schema.freq))}
            ifDefined(schema.q?.value, value => q.setValue(value))
            ifDefined(schema.enabled?.value, value => enabled.setValue(value))
        }
        const readShelf = (schema: EqBandSchema, pass: RevampShelf) => {
            const {frequency, gain, enabled} = pass
            if (isDefined(schema.freq?.value)) {frequency.setValue(ParameterDecoder.readValue(schema.freq))}
            ifDefined(schema.gain?.value, value => gain.setValue(value))
            ifDefined(schema.enabled?.value, value => enabled.setValue(value))
        }
        return RevampDeviceBox.create(boxGraph, UUID.generate(), box => {
            EffectParameterDefaults.defaultRevampDeviceBox(box)
            box.host.refer(field)
            box.index.setValue(index)
            box.label.setValue(equalizer.deviceName ?? "Revamp")
            let bellIndex: int = 0
            equalizer.bands.forEach((band) => {
                switch (band.type) {
                    case EqBandType.HIGH_PASS:
                        return readPass(band, box.highPass)
                    case EqBandType.LOW_PASS:
                        return readPass(band, box.lowPass)
                    case EqBandType.HIGH_SHELF:
                        return readShelf(band, box.highShelf)
                    case EqBandType.LOW_SHELF:
                        return readShelf(band, box.lowShelf)
                    case EqBandType.BELL: {
                        if (bellIndex === 3) {return}
                        const bell = [box.lowBell, box.midBell, box.highBell][bellIndex++]
                        const {frequency, gain, q, enabled} = bell
                        if (isDefined(band.freq?.value)) {frequency.setValue(ParameterDecoder.readValue(band.freq))}
                        ifDefined(band.q?.value, value => q.setValue(value))
                        ifDefined(band.gain?.value, value => gain.setValue(value))
                        ifDefined(band.enabled?.value, value => enabled.setValue(value))
                        return
                    }
                    default:
                        console.warn(`Cannot map band type: ${band.type} to Revamp`)
                        return
                }
            })
        })
    }

    export const revampBands = (box: RevampDeviceBox, ids: DawProjectIds): ReadonlyArray<EqBandSchema> => {
        const frequency = (pass: RevampPass | RevampShelf | RevampBell) => Xml.element({
            id: ids.of(pass.frequency.address), name: "Frequency", unit: Unit.HERTZ, min: 20.0, max: 20_000.0,
            value: pass.frequency.getValue()
        }, RealParameterSchema)
        const enabled = (pass: RevampPass | RevampShelf | RevampBell) => Xml.element({
            id: ids.of(pass.enabled.address), name: "Enabled", value: pass.enabled.getValue()
        }, BoolParameterSchema)
        const gain = (pass: RevampShelf | RevampBell) => Xml.element({
            id: ids.of(pass.gain.address), name: "Gain", unit: Unit.DECIBEL, min: -24.0, max: 24.0, value: pass.gain.getValue()
        }, RealParameterSchema)
        const q = (pass: RevampPass | RevampBell) => Xml.element({
            id: ids.of(pass.q.address), name: "Q", unit: Unit.LINEAR, min: 0.01, max: 10.0, value: pass.q.getValue()
        }, RealParameterSchema)
        const pass = (type: EqBandType, pass: RevampPass) => Xml.element({
            type, order: (pass.order.getValue() + 1) * 2, freq: frequency(pass), q: q(pass), enabled: enabled(pass)
        }, EqBandSchema)
        const shelf = (type: EqBandType, shelf: RevampShelf) => Xml.element({
            type, freq: frequency(shelf), gain: gain(shelf), enabled: enabled(shelf)
        }, EqBandSchema)
        const bell = (bell: RevampBell) => Xml.element({
            type: EqBandType.BELL, freq: frequency(bell), gain: gain(bell), q: q(bell), enabled: enabled(bell)
        }, EqBandSchema)
        return [
            pass(EqBandType.HIGH_PASS, box.highPass),
            shelf(EqBandType.LOW_SHELF, box.lowShelf),
            bell(box.lowBell),
            bell(box.midBell),
            bell(box.highBell),
            shelf(EqBandType.HIGH_SHELF, box.highShelf),
            pass(EqBandType.LOW_PASS, box.lowPass)
        ]
    }
}
