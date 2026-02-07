import { DefaultObservableValue, Procedure, Terminator } from "@opendaw/lib-std"
import { Dialog } from "@/ui/components/Dialog.tsx"
import { createElement } from "@opendaw/lib-jsx"
import { Icon } from "@/ui/components/Icon.tsx"
import { RadioGroup } from "@/ui/components/RadioGroup.tsx"
import { IconSymbol } from "@opendaw/studio-enums"

const Icons = [
    IconSymbol.AudioBus, IconSymbol.Waveform, IconSymbol.Flask, IconSymbol.BassGuitar, IconSymbol.Guitar,
    IconSymbol.DrumSet, IconSymbol.Microphone, IconSymbol.Saxophone, IconSymbol.Heart, IconSymbol.Robot
] as const

// TODO Find a more appropriate place

export const showNewAudioBusOrAuxDialog = (suggestName: string,
    factory: Procedure<{ name: string, icon: IconSymbol }>,
    defaultIcon: IconSymbol): void => {
    const lifecycle = new Terminator()
    const iconValue = new DefaultObservableValue(defaultIcon)
    const input: HTMLInputElement = <input type="text" value={suggestName} autofocus
        aria-label="Name"
        style={{
            width: "100%",
            backgroundColor: "rgba(0, 0, 0, 0.2)",
            outline: "none",
            border: "none"
        }} />
    const dialog: HTMLDialogElement = (
        <Dialog headline="Create Aux Bus"
            icon={IconSymbol.Add}
            cancelable={true}
            buttons={[{
                text: "Cancel",
                primary: false,
                onClick: handler => handler.close()
            }, {
                text: "Create",
                primary: true,
                onClick: handler => {
                    factory({ name: input.value, icon: iconValue.getValue() })
                    handler.close()
                }
            }]}>
            <div
                style={{ padding: "1em 0", display: "grid", gridTemplateRows: "auto auto 0px auto auto", rowGap: "4px" }}>
                <span>Icon</span>
                <RadioGroup lifecycle={lifecycle} model={iconValue} elements={Icons.map(icon => ({
                    value: icon,
                    element: (<Icon symbol={icon} style={{ fontSize: "1.5em" }} />)
                }))} style={{ gap: "0.5em" }} />
                <div />
                <span>Name</span>
                {input}
            </div>
        </Dialog>
    )
    input.onfocus = () => input.select()
    input.onblur = () => input.focus()
    input.onkeydown = event => {
        if (event.code === "Enter") {
            factory({ name: input.value, icon: iconValue.getValue() })
            dialog.close()
        }
    }
    document.body.appendChild(dialog)
    dialog.addEventListener("close", () => lifecycle.terminate(), { once: true })
    dialog.showModal()
}