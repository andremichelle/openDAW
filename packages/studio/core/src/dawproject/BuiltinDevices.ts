import {ifDefined, int, UUID} from "@moises-ai/lib-std"
import {BoxGraph, Field} from "@moises-ai/lib-box"
import {BandSchema, EqBandType, EqualizerSchema, ParameterDecoder} from "@moises-ai/lib-dawproject"
import {Pointers} from "@moises-ai/studio-enums"
import {RevampDeviceBox, RevampPass, RevampShelf} from "@moises-ai/studio-boxes"
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
        const readPass = (schema: BandSchema, pass: RevampPass) => {
            const {order, frequency, q, enabled} = pass
            order.setValue(mapOrder(schema.order))
            frequency.setValue(ParameterDecoder.readValue(schema.freq))
            ifDefined(schema.Q?.value, value => q.setValue(value))
            ifDefined(schema.enabled?.value, value => enabled.setValue(value))
        }
        const readShelf = (schema: BandSchema, pass: RevampShelf) => {
            const {frequency, gain, enabled} = pass
            frequency.setValue(ParameterDecoder.readValue(schema.freq))
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
                        frequency.setValue(ParameterDecoder.readValue(band.freq))
                        ifDefined(band.Q?.value, value => q.setValue(value))
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
}