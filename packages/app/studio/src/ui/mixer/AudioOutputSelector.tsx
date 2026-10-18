import css from "./OutputSelector.sass?inline"
import settingsCss from "./AudioOutputSettings.sass?inline"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {AudioOutputDevice} from "@/audio/AudioOutputDevice"
import {Surface} from "@/ui/surface/Surface"
import {IconSymbol} from "@opendaw/studio-enums"
import {Dialog} from "@/ui/components/Dialog"
import {AudioOutputDevices} from "@/ui/mixer/AudioOutputDevices"
import {Promises} from "@opendaw/lib-runtime"
import {Dialogs} from "@/ui/components/dialogs"
import {TextScroller} from "@/ui/TextScroller"
import {DefaultObservableValue, int, isDefined, Lifecycle, Terminator} from "@opendaw/lib-std"
import {AudioOutputBackend, OutputDevice} from "@/audio/AudioOutputDevice"
import {DropDown} from "@/ui/composite/DropDown"

const className = Html.adoptStyleSheet(css, "OutputSelector")
const settingsClassName = Html.adoptStyleSheet(settingsCss, "AudioOutputSettings")

type Construct = {
    lifecycle: Lifecycle
    output: AudioOutputDevice
}

export const AudioOutputSelector = ({lifecycle, output}: Construct) => {
    if (!output.switchable) {
        return (
            <div className={className}
                 onclick={() => Dialogs.info({
                     headline: "Cannot Switch Audio-Output",
                     message: "Only Chrome supports this feature."
                 })}>
                <div className="label">Default</div>
            </div>
        )
    }
    const label: HTMLElement = (<div className="label"/>)
    const updateLabel = () => label.textContent = label.title =
        output.value.getValue().mapOr(device => device.label, "Default")
    lifecycle.ownAll(
        TextScroller.install(label),
        output.value.catchupAndSubscribe(updateLabel)
    )
    const element: HTMLElement = (
        <div className={className} onpointerdown={(event) => {
            event.preventDefault()
            event.stopPropagation()
            openAudioOutputSettings(output)
        }}>{label}</div>
    )
    return element
}

// the mixer's output label and the app menu open the same dialog
export const openAudioOutputSettings = (output: AudioOutputDevice): void => {
    if (output.backend.nonEmpty()) {return openBackendDialog(output.backend.unwrap())}
    const dialog: HTMLDialogElement = (
        <Dialog headline="Select Audio Output Device"
                icon={IconSymbol.AudioDevice}
                cancelable={true}
                buttons={[{
                    text: "Cancel",
                    primary: false,
                    onClick: handler => handler.close()
                }]}>
            <AudioOutputDevices output={output}
                                provider={async device => {
                                    const {status, error} = await Promises.tryCatch(output.setOutput(device))
                                    dialog.close()
                                    if (status === "rejected") {
                                        await Dialogs.info({
                                            headline: "Could Not Change Audio-Output",
                                            message: String(error)
                                        })
                                    }
                                }}/>
        </Dialog>
    )
    Surface.get().body.appendChild(dialog)
    dialog.showModal()
}

// an output with a buffer size (the desktop app's native engine): both are chosen and applied with Ok
const openBackendDialog = (backend: AudioOutputBackend): void => {
    const lifecycle = new Terminator()
    const devices = backend.devices()
    const currentId = backend.current.getValue().mapOr(current => current.deviceId, "")
    const device = new DefaultObservableValue<OutputDevice>(
        devices.find(candidate => candidate.deviceId === currentId) ?? devices[0] ?? {deviceId: "", label: "Default"})
    const frames = new DefaultObservableValue<int>(backend.bufferSize.getValue())
    const offered = backend.exclusive.getValue()
    const exclusive = new DefaultObservableValue<boolean>(offered === true)
    const dialog: HTMLDialogElement = (
        <Dialog headline="Audio Output"
                icon={IconSymbol.AudioDevice}
                cancelable={true}
                style={{minWidth: "0", width: "max-content"}}
                buttons={[{
                    text: "Ok",
                    primary: true,
                    onClick: handler => {
                        backend.choose(device.getValue(), frames.getValue(), exclusive.getValue())
                        handler.close()
                    }
                }]}>
            <div className={settingsClassName}>
                <span>Device</span>
                <DropDown lifecycle={lifecycle}
                          owner={device}
                          provider={() => devices}
                          mapping={value => value.label}
                          width="16em"/>
                <span>Buffer Size</span>
                <DropDown lifecycle={lifecycle}
                          owner={frames}
                          provider={() => backend.bufferSizes}
                          mapping={value => `${value} samples (${(value / 48).toFixed(1)} ms)`}
                          width="16em"/>
                {isDefined(offered) && [
                    <span>Mode</span>,
                    <DropDown lifecycle={lifecycle}
                              owner={exclusive}
                              provider={() => [false, true]}
                              mapping={value => value ? "Exclusive (lowest latency)" : "Shared"}
                              width="16em"/>
                ]}
            </div>
        </Dialog>
    )
    dialog.addEventListener("close", () => lifecycle.terminate())
    Surface.get().body.appendChild(dialog)
    dialog.showModal()
}
