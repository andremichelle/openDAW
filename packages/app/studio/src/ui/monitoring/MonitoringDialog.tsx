import css from "./MonitoringDialog.sass?inline"
import {createElement} from "@opendaw/lib-jsx"
import {
    Color,
    DefaultObservableValue,
    DefaultParameter,
    Editing,
    Lifecycle,
    Option,
    Parameter,
    StringMapping,
    Terminable,
    Terminator,
    unitValue,
    ValueGuide,
    ValueMapping
} from "@opendaw/lib-std"
import {gainToDb} from "@opendaw/lib-dsp"
import {CaptureAudio, MonitoringMode} from "@opendaw/studio-core"
import {Dialog} from "@/ui/components/Dialog"
import {Checkbox} from "@/ui/components/Checkbox"
import {Icon} from "@/ui/components/Icon"
import {Knob} from "@/ui/components/Knob"
import {RelativeUnitValueDragging} from "@/ui/wrapper/RelativeUnitValueDragging"
import {HorizontalPeakMeter} from "@/ui/components/HorizontalPeakMeter"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {Surface} from "@/ui/surface/Surface"
import {Html} from "@opendaw/lib-dom"
import {AudioDevices} from "@/audio/AudioDevices"
import {StudioService} from "@/service/StudioService"
import {SnapCenter} from "@/ui/configs"

const className = Html.adoptStyleSheet(css, "MonitoringDialog")

type OutputDevice = { id: string, label: string }
const DefaultDevice: OutputDevice = {id: "", label: "Default"}

type ParamKnobConstruct = {
    lifecycle: Lifecycle,
    editing: Editing,
    parameter: Parameter,
    anchor: unitValue,
    color: Color,
    label: string,
    options?: ValueGuide.Options
}

const ParamKnob = ({lifecycle, editing, parameter, anchor, color, label, options}: ParamKnobConstruct) => {
    const valueLabel: HTMLElement = <span className="value"/>
    const update = () => {
        const printValue = parameter.getPrintValue()
        valueLabel.textContent = `${printValue.value}${printValue.unit}`
    }
    lifecycle.own(parameter.subscribe(update))
    update()
    return (
        <div className="param-knob">
            <h5>{label}</h5>
            <RelativeUnitValueDragging lifecycle={lifecycle}
                                       editing={editing}
                                       parameter={parameter}
                                       options={options}>
                <Knob lifecycle={lifecycle} value={parameter} anchor={anchor} color={color}/>
            </RelativeUnitValueDragging>
            {valueLabel}
        </div>
    )
}

export namespace MonitoringDialog {
    export const open = async (service: StudioService, capture: CaptureAudio): Promise<void> => {
        const switchable = "setSinkId" in AudioContext.prototype
        let outputDevices: ReadonlyArray<OutputDevice> = [DefaultDevice]
        if (switchable) {
            try {
                const devices = await AudioDevices.queryListOutputDevices()
                outputDevices = [DefaultDevice, ...devices.map(device => ({id: device.deviceId, label: device.label}))]
            } catch (_reason) {
                // keep default only
            }
        }
        const lifecycle = new Terminator()
        const volumeParam = lifecycle.own(new DefaultParameter(
            ValueMapping.linear(-48, 12), StringMapping.numeric({unit: "dB", fractionDigits: 1}),
            "Volume", capture.monitorVolumeDb))
        const panParam = lifecycle.own(new DefaultParameter(
            ValueMapping.bipolar(), StringMapping.numeric({fractionDigits: 2, bipolar: true}),
            "Pan", capture.monitorPan))
        const muteModel = lifecycle.own(new DefaultObservableValue<boolean>(capture.monitorMuted))
        lifecycle.ownAll(
            volumeParam.subscribe(() => capture.monitorVolumeDb = volumeParam.getValue()),
            panParam.subscribe(() => capture.monitorPan = panParam.getValue()),
            muteModel.subscribe(owner => capture.monitorMuted = owner.getValue())
        )
        const peaksInDb = new Float32Array(2).fill(Number.NEGATIVE_INFINITY)
        const meterTerminator = lifecycle.own(new Terminator())
        const reconnectMeter = () => {
            meterTerminator.terminate()
            try {
                const meterWorklet = service.audioWorklets.createMeter(2)
                capture.monitorPanNode.connect(meterWorklet)
                meterTerminator.ownAll(
                    meterWorklet.subscribe(({peak}) => {
                        peaksInDb[0] = gainToDb(peak[0])
                        peaksInDb[1] = gainToDb(peak[1] ?? peak[0])
                    }),
                    Terminable.create(() => meterWorklet.disconnect())
                )
            } catch (_reason) {
                peaksInDb.fill(Number.NEGATIVE_INFINITY)
            }
        }
        reconnectMeter()
        const modeSelect: HTMLSelectElement = (
            <select className="select" onchange={() => {
                capture.monitoringMode = modeSelect.value as MonitoringMode
                reconnectMeter()
            }}>
                <option value="off" selected={capture.monitoringMode === "off"}>Off</option>
                <option value="direct" selected={capture.monitoringMode === "direct"}>Direct</option>
                <option value="effects" selected={capture.monitoringMode === "effects"}>With Effects</option>
            </select>
        )
        const currentDeviceId = capture.monitorOutputDeviceId.unwrapOrElse("")
        const deviceSelect: HTMLSelectElement = (
            <select className="select" onchange={() => {
                const deviceId = deviceSelect.value === "" ? Option.None : Option.wrap(deviceSelect.value)
                capture.setMonitorOutputDevice(deviceId)
            }}>
                {outputDevices.map(device => (
                    <option value={device.id}
                            selected={device.id === currentDeviceId}>{device.label}</option>
                ))}
            </select>
        )
        const dialog: HTMLDialogElement = (
            <Dialog headline="Monitoring"
                    icon={IconSymbol.SpeakerHeadphone}
                    style={{minWidth: "auto", maxWidth: "auto"}}
                    buttons={[{text: "Close", primary: true, onClick: handler => handler.close()}]}>
                <div className={className}>
                    <div className="controls-row">
                        <ParamKnob lifecycle={lifecycle}
                                   editing={service.project.editing}
                                   parameter={volumeParam}
                                   anchor={0.8}
                                   color={Colors.yellow}
                                   label="Volume"/>
                        <ParamKnob lifecycle={lifecycle} editing={service.project.editing}
                                   parameter={panParam}
                                   anchor={0.5}
                                   color={Colors.green}
                                   label="Pan"
                                   options={SnapCenter}/>
                        <div className="param-knob">
                            <h5>Mute</h5>
                            <Checkbox lifecycle={lifecycle} model={muteModel}>
                                <Icon symbol={IconSymbol.Checkbox}/>
                            </Checkbox>
                        </div>
                    </div>
                    <div className="select-row">
                        <div className="field">
                            <label>Mode</label>
                            {modeSelect}
                        </div>
                        {switchable && (
                            <div className="field">
                                <label>Output</label>
                                {deviceSelect}
                            </div>
                        )}
                    </div>
                    <HorizontalPeakMeter lifecycle={lifecycle} peaksInDb={peaksInDb}/>
                </div>
            </Dialog>
        )
        dialog.addEventListener("close", () => lifecycle.terminate())
        Surface.get().body.appendChild(dialog)
        dialog.showModal()
    }
}
