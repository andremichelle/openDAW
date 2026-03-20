import {asInstanceOf, isDefined, Option, StringMapping, Terminator, UUID, ValueMapping} from "@opendaw/lib-std"
import {Address, BooleanField, StringField} from "@opendaw/lib-box"
import {ApparatDeviceBox, WerkstattParameterBox} from "@opendaw/studio-boxes"
import {DeviceHost, Devices, InstrumentDeviceBoxAdapter} from "../../DeviceAdapter"
import {LabeledAudioOutput} from "../../LabeledAudioOutputsOwner"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {TrackType} from "../../timeline/TrackType"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"
import {parseParams, resolveParamMappings} from "../../ScriptParamDeclaration"

export class ApparatDeviceBoxAdapter implements InstrumentDeviceBoxAdapter {
    readonly #terminator = new Terminator()

    readonly type = "instrument"
    readonly accepts = "midi"
    readonly manualUrl = DeviceManualUrls.Apparat

    readonly #context: BoxAdaptersContext
    readonly #box: ApparatDeviceBox
    readonly #parametric: ParameterAdapterSet

    constructor(context: BoxAdaptersContext, box: ApparatDeviceBox) {
        this.#context = context
        this.#box = box
        this.#parametric = this.#terminator.own(new ParameterAdapterSet(this.#context))
        this.#terminator.own(
            box.parameters.pointerHub.catchupAndSubscribe({
                onAdded: (({box: parameterBox}) => {
                    const paramBox = asInstanceOf(parameterBox, WerkstattParameterBox)
                    const label = paramBox.label.getValue()
                    const declarations = parseParams(box.code.getValue())
                    const declaration = declarations.find(decl => decl.label === label)
                    const {valueMapping, stringMapping} = isDefined(declaration)
                        ? resolveParamMappings(declaration)
                        : {
                            valueMapping: ValueMapping.unipolar(),
                            stringMapping: StringMapping.percent({fractionDigits: 1})
                        }
                    this.#parametric.createParameter(paramBox.value, valueMapping, stringMapping, label)
                }),
                onRemoved: (({box}) => this.#parametric
                    .removeParameter(asInstanceOf(box, WerkstattParameterBox).value.address))
            })
        )
        this.#terminator.own(box.code.subscribe(() => {
            const declarations = parseParams(box.code.getValue())
            for (const adapter of this.#parametric.parameters()) {
                const declaration = declarations.find(decl => decl.label === adapter.name)
                const {valueMapping, stringMapping} = isDefined(declaration)
                    ? resolveParamMappings(declaration)
                    : {valueMapping: ValueMapping.unipolar(), stringMapping: StringMapping.percent({fractionDigits: 1})}
                adapter.updateMappings(valueMapping, stringMapping)
            }
        }))
    }

    get box(): ApparatDeviceBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get labelField(): StringField {return this.#box.label}
    get iconField(): StringField {return this.#box.icon}
    get defaultTrackType(): TrackType {return TrackType.Notes}
    get enabledField(): BooleanField {return this.#box.enabled}
    get minimizedField(): BooleanField {return this.#box.minimized}
    get acceptsMidiEvents(): boolean {return true}
    get parameters(): ParameterAdapterSet {return this.#parametric}

    deviceHost(): DeviceHost {
        return this.#context.boxAdapters
            .adapterFor(this.#box.host.targetVertex.unwrap("no device-host").box, Devices.isHost)
    }

    audioUnitBoxAdapter(): AudioUnitBoxAdapter {return this.deviceHost().audioUnitBoxAdapter()}

    * labeledAudioOutputs(): Iterable<LabeledAudioOutput> {
        yield {address: this.address, label: this.labelField.getValue(), children: () => Option.None}
    }

    terminate(): void {this.#terminator.terminate()}
}
