import {asInstanceOf, isDefined, Option, StringMapping, Terminator, UUID, ValueMapping} from "@opendaw/lib-std"
import {Address, BooleanField, Int32Field, PointerField, StringField} from "@opendaw/lib-box"
import {WerkstattDeviceBox, WerkstattParameterBox} from "@opendaw/studio-boxes"
import {Pointers} from "@opendaw/studio-enums"
import {AudioEffectDeviceAdapter, DeviceHost, Devices} from "../../DeviceAdapter"
import {LabeledAudioOutput} from "../../LabeledAudioOutputsOwner"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {parseParams, resolveParamMappings} from "../../ScriptParamDeclaration"

export class WerkstattDeviceBoxAdapter implements AudioEffectDeviceAdapter {
    readonly #terminator = new Terminator()

    readonly type = "audio-effect"
    readonly accepts = "audio"
    readonly manualUrl = DeviceManualUrls.Werkstatt

    readonly #context: BoxAdaptersContext
    readonly #box: WerkstattDeviceBox
    readonly #parametric: ParameterAdapterSet

    constructor(context: BoxAdaptersContext, box: WerkstattDeviceBox) {
        this.#context = context
        this.#box = box
        this.#parametric = this.#terminator.own(new ParameterAdapterSet(this.#context))
        const declarations = parseParams(box.code.getValue())
        this.#terminator.own(
            box.parameters.pointerHub.catchupAndSubscribe({
                onAdded: (({box: parameterBox}) => {
                    const paramBox = asInstanceOf(parameterBox, WerkstattParameterBox)
                    const label = paramBox.label.getValue()
                    const declaration = declarations.find(decl => decl.label === label)
                    const {valueMapping, stringMapping} = isDefined(declaration)
                        ? resolveParamMappings(declaration)
                        : {valueMapping: ValueMapping.unipolar(), stringMapping: StringMapping.percent({fractionDigits: 1})}
                    this.#parametric.createParameter(paramBox.value, valueMapping, stringMapping, label)
                }),
                onRemoved: (({box}) => this.#parametric
                    .removeParameter(asInstanceOf(box, WerkstattParameterBox).value.address))
            })
        )
    }

    get box(): WerkstattDeviceBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get indexField(): Int32Field {return this.#box.index}
    get labelField(): StringField {return this.#box.label}
    get enabledField(): BooleanField {return this.#box.enabled}
    get minimizedField(): BooleanField {return this.#box.minimized}
    get host(): PointerField<Pointers.AudioEffectHost> {return this.#box.host}
    get parameters(): ParameterAdapterSet {return this.#parametric}

    deviceHost(): DeviceHost {
        return this.#context.boxAdapters
            .adapterFor(this.#box.host.targetVertex.unwrap("no device-host").box, Devices.isHost)
    }

    audioUnitBoxAdapter(): AudioUnitBoxAdapter {return this.deviceHost().audioUnitBoxAdapter()}

    *labeledAudioOutputs(): Iterable<LabeledAudioOutput> {
        yield {address: this.address, label: this.labelField.getValue(), children: () => Option.None}
    }

    terminate(): void {this.#terminator.terminate()}
}
