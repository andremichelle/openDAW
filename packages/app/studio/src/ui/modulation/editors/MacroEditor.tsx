import css from "./MacroEditor.sass?inline"
import {clampUnit, Lifecycle, Parameter} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Events, Html} from "@opendaw/lib-dom"
import {MacroModulatorBoxAdapter} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService.ts"
import {ModulatorEditor} from "@/ui/modulation/ModulatorEditor.tsx"
import {RelativeUnitValueDragging} from "@/ui/wrapper/RelativeUnitValueDragging.tsx"

const className = Html.adoptStyleSheet(css, "MacroEditor")

const INSET = 4
const THRESHOLD = 4

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    modulator: MacroModulatorBoxAdapter
}

export const MacroEditor = ({lifecycle, service, modulator}: Construct) => {
    const {editing} = service.project
    const {value} = modulator.namedParameter
    const options = {horizontal: true, ratio: 1.0, trackLength: 128}
    const print: HTMLElement = (<div className="print"/>)
    const slider: HTMLElement = (
        <div className="slider" onInit={element => lifecycle.ownAll(
            value.catchupAndSubscribe((owner: Parameter) => {
                element.style.setProperty("--value", owner.getControlledUnitValue().toString())
                const {value, unit} = owner.getPrintValue()
                print.textContent = `${value}${unit}`
            }),
            Html.watchResize(element, () => options.trackLength = element.clientWidth - INSET * 2),
            Events.subscribe(element, "pointerdown", (event: PointerEvent) => {
                const {left, width} = element.getBoundingClientRect()
                const track = width - INSET * 2
                const position = clampUnit((event.clientX - left - INSET) / track)
                if (Math.abs(position - value.getUnitValue()) * track <= THRESHOLD) {return}
                editing.modify(() => value.setUnitValue(position), false)
            }))}>
            <div className="track"/>
            <div className="fill"/>
            {print}
        </div>
    )
    return (
        <ModulatorEditor lifecycle={lifecycle} service={service} modulator={modulator}>
            <div className={className}>
                <div className="macro">
                    <RelativeUnitValueDragging lifecycle={lifecycle} editing={editing} parameter={value}
                                               supressValueFlyout={true} options={options}>
                        {slider}
                    </RelativeUnitValueDragging>
                </div>
            </div>
        </ModulatorEditor>
    )
}
