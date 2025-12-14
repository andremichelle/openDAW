import {RevampBell, RevampDeviceBox, RevampPass, RevampShelf} from "@opendaw/studio-boxes"
import {int, StringMapping, UUID, ValueMapping} from "@opendaw/lib-std"
import {Address, BooleanField, Int32Field, PointerField, StringField} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {AudioEffectDeviceAdapter, DeviceHost, Devices} from "../../DeviceAdapter"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"
import {AutomatableParameterFieldAdapter} from "../../AutomatableParameterFieldAdapter"

export class RevampDeviceBoxAdapter implements AudioEffectDeviceAdapter {
    readonly type = "audio-effect"
    readonly accepts = "audio"

    readonly #context: BoxAdaptersContext
    readonly #box: RevampDeviceBox
    readonly #parametric: ParameterAdapterSet
    readonly namedParameter // let typescript infer the type

    constructor(context: BoxAdaptersContext, box: RevampDeviceBox) {
        this.#context = context
        this.#box = box
        this.#parametric = new ParameterAdapterSet(this.#context)
        this.namedParameter = this.#wrapParameters(box)
    }

    get box(): RevampDeviceBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get indexField(): Int32Field {return this.#box.index}
    get labelField(): StringField {return this.#box.label}
    get enabledField(): BooleanField {return this.#box.enabled}
    get minimizedField(): BooleanField {return this.#box.minimized}
    get host(): PointerField<Pointers.AudioEffectHost> {return this.#box.host}
    get spectrum(): Address {return this.#box.address.append(0xFFF)}

    deviceHost(): DeviceHost {
        return this.#context.boxAdapters
            .adapterFor(this.#box.host.targetVertex.unwrap("no device-host").box, Devices.isHost)
    }

    audioUnitBoxAdapter(): AudioUnitBoxAdapter {return this.deviceHost().audioUnitBoxAdapter()}

    terminate(): void {
        this.#parametric.terminate()
    }

    #wrapParameters(box: RevampDeviceBox) {
        return {
            highPass: createPass(this.#parametric, box.highPass, "High-Pass"),
            lowShelf: createShelf(this.#parametric, box.lowShelf, "Low-Shelf"),
            lowBell: createBell(this.#parametric, box.lowBell, "Low-Bell"),
            midBell: createBell(this.#parametric, box.midBell, "Mid-Bell"),
            highBell: createBell(this.#parametric, box.highBell, "High-Bell"),
            highShelf: createShelf(this.#parametric, box.highShelf, "High-Shelf"),
            lowPass: createPass(this.#parametric, box.lowPass, "Low-Pass")
        } as const
    }
}

export type Parameters = {
    enabled: AutomatableParameterFieldAdapter<boolean>
    frequency: AutomatableParameterFieldAdapter<number>
}

export type PassParameters = Parameters & {
    order: AutomatableParameterFieldAdapter<int>
    q: AutomatableParameterFieldAdapter<number>
}

export type ShelfParameters = Parameters & {
    gain: AutomatableParameterFieldAdapter<number>
}

export type BellParameters = Parameters & {
    q: AutomatableParameterFieldAdapter<number>
    gain: AutomatableParameterFieldAdapter<number>
}

const FrequencyMapping = ValueMapping.exponential(20.0, 20_000.0)
const GainMapping = ValueMapping.linear(-24.0, 24.0)
const QMapping = ValueMapping.exponential(0.01, 10.0)

const createPass = (parametric: ParameterAdapterSet, pass: RevampPass, name: string): PassParameters => {
    return ({
        enabled: parametric.createParameter(pass.enabled, ValueMapping.bool, StringMapping.bool, "enabled"),
        frequency: parametric.createParameter(
            pass.frequency,
            FrequencyMapping,
            StringMapping.numeric({unit: "Hz", fractionDigits: 0}),
            `${name} Freq`),
        order: parametric.createParameter(
            pass.order,
            ValueMapping.linearInteger(0, 3),
            StringMapping.indices("db", ["12", "24", "36", "48"]),
            `${name} Order`),
        q: parametric.createParameter(
            pass.q,
            QMapping,
            StringMapping.numeric({fractionDigits: 3}),
            `${name} Q`)
    })
}

const createShelf = (parametric: ParameterAdapterSet, shelf: RevampShelf, name: string): ShelfParameters => ({
    enabled: parametric.createParameter(shelf.enabled, ValueMapping.bool, StringMapping.bool, "enabled"),
    frequency: parametric.createParameter(
        shelf.frequency,
        FrequencyMapping,
        StringMapping.numeric({unit: "Hz", fractionDigits: 0}),
        `${name} Freq`),
    gain: parametric.createParameter(
        shelf.gain,
        GainMapping,
        StringMapping.numeric({unit: "db", fractionDigits: 1, bipolar: true}),
        `${name} Gain`, 0.5)
})

const createBell = (parametric: ParameterAdapterSet, bell: RevampBell, name: string): BellParameters => ({
    enabled: parametric.createParameter(bell.enabled, ValueMapping.bool, StringMapping.bool, "enabled"),
    frequency: parametric.createParameter(
        bell.frequency,
        FrequencyMapping,
        StringMapping.numeric({unit: "Hz", fractionDigits: 0}),
        `${name} Freq`),
    gain: parametric.createParameter(
        bell.gain,
        GainMapping,
        StringMapping.numeric({unit: "db", fractionDigits: 1, bipolar: true}),
        `${name} Gain`, 0.5),
    q: parametric.createParameter(
        bell.q,
        QMapping,
        StringMapping.numeric({fractionDigits: 3}),
        `${name} Q`)
})