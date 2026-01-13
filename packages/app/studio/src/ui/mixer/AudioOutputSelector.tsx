import css from "./OutputSelector.sass?inline"
import {createElement} from "@moises-ai/lib-jsx"
import {Html} from "@moises-ai/lib-dom"
import {AudioOutputDevice} from "@/audio/AudioOutputDevice"
import {Surface} from "@/ui/surface/Surface"
import {IconSymbol} from "@moises-ai/studio-enums"
import {Dialog} from "@/ui/components/Dialog"
import {AudioOutputDevices} from "@/ui/mixer/AudioOutputDevices"
import {Promises} from "@moises-ai/lib-runtime"
import {Dialogs} from "@/ui/components/dialogs"
import {TextScroller} from "@/ui/TextScroller"
import {Lifecycle} from "@moises-ai/lib-std"

const className = Html.adoptStyleSheet(css, "OutputSelector")

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
        }}>{label}</div>
    )
    return element
}