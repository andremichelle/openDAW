import {Editing, Lifecycle, Terminable, Terminator} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Events} from "@opendaw/lib-dom"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {AutomatableParameterFieldAdapter} from "@opendaw/studio-adapters"
import {Icon} from "@/ui/components/Icon"
import {Checkbox} from "@/ui/components/Checkbox"
import {EditWrapper} from "@/ui/wrapper/EditWrapper.ts"

type Construct = {
    lifecycle: Lifecycle
    editing: Editing
    parameter: AutomatableParameterFieldAdapter<boolean>
}

const HoldThresholdMs = 250

export const SendButton = ({lifecycle, editing, parameter}: Construct) => {
    const model = EditWrapper.forAutomatableParameter(editing, parameter)
    const hold = lifecycle.own(new Terminator())
    let held = false
    let suppressClick = false
    const install = (element: HTMLElement): void => {
        lifecycle.ownAll(
            Events.subscribe(element, "pointerdown", (event: PointerEvent) => {
                if (event.button !== 0) {return}
                hold.terminate()
                held = false
                suppressClick = false
                const pressed = parameter.getValue()
                const timer = setTimeout(() => {
                    held = true
                    editing.modify(() => parameter.setValue(!pressed))
                }, HoldThresholdMs)
                const release = () => {
                    hold.terminate()
                    if (held) {
                        held = false
                        suppressClick = true
                        editing.modify(() => parameter.setValue(pressed), false)
                    }
                }
                hold.ownAll(
                    Terminable.create(() => clearTimeout(timer)),
                    Events.subscribe(window, "pointerup", release),
                    Events.subscribe(window, "pointercancel", release),
                    Events.subscribe(window, "blur", release)
                )
            }),
            Events.subscribe(element, "click", (event: MouseEvent) => {
                if (!suppressClick) {return}
                suppressClick = false
                event.preventDefault()
                event.stopPropagation()
            }, {capture: true})
        )
    }
    return (
        <Checkbox lifecycle={lifecycle} model={model} onInit={install}
                  appearance={{
                      activeColor: Colors.blue, framed: true,
                      tooltip: "Send audio into the layer (click toggles, hold sends momentarily)"
                  }}>
            <Icon symbol={IconSymbol.Play}/>
        </Checkbox>
    )
}
