import css from "./OctaveSelector.sass?inline"
import {Events, Html} from "@moises-ai/lib-dom"
import {int, Lifecycle, MutableObservableValue, ObservableValue, Terminable} from "@moises-ai/lib-std"
import {createElement} from "@moises-ai/lib-jsx"
import {SlotState} from "@/ui/devices/instruments/PlayfieldDeviceEditor/SlotState"
import {Runtime} from "@moises-ai/lib-runtime"
import {SlotUtils} from "@/ui/devices/instruments/PlayfieldDeviceEditor/SlotUtils"

const className = Html.adoptStyleSheet(css, "OctaveSelector")

type Construct = {
    lifecycle: Lifecycle
    states: ReadonlyArray<ObservableValue<SlotState>>
    octave: MutableObservableValue<int>
    octaveIndex: int
}

export const OctaveSelector = ({lifecycle, states, octave, octaveIndex}: Construct) => {
    const gap = 1
    const size = 3
    const rows = octaveIndex < 10 ? 3 : 2
    const width = 4 * size + 3 * gap
    const height = rows * size + (rows - 1) * gap
    const indicator: Array<SVGRectElement> = []
    let slotIndex = 0
    for (let y = rows - 1; y >= 0; y--) {
        for (let x = 0; x < 4; x++) {
            const rect: SVGRectElement = (
                <rect x={`${x * (gap + size)}px`}
                      y={`${y * (gap + size)}px`}
                      width={`${size}px`}
                      height={`${size}px`}/>
            )
            rect.style.setProperty("--color", SlotUtils.color(slotIndex % 12))
            indicator.push(rect)
            const state = states[slotIndex++]
            rect.classList.add(state.getValue())
            lifecycle.own(state.subscribe(() => {
                rect.classList.remove(SlotState.Busy, SlotState.Playing)
                rect.classList.add(state.getValue())
            }))
        }
    }
    const svg: SVGSVGElement = (
        <svg fill="var(--color-black)"
             stroke="none"
             viewBox={`0 0 ${width} ${height}`}
             width={width}
             height={height}>
            {indicator}
        </svg>
    )
    const element: HTMLElement = (
        <div className={className}>
            {svg}
        </div>
    )
    const updateActiveState = () => element.classList.toggle("active", octave.getValue() === octaveIndex)
    let dragSwitch = Terminable.Empty
    lifecycle.ownAll(
        Events.subscribe(element, "click", () => octave.setValue(octaveIndex)),
        Events.subscribe(element, "dragenter", () => {
            element.classList.add("drag-over")
            dragSwitch = Runtime.scheduleTimeout(() => {
                element.classList.remove("drag-over")
                octave.setValue(octaveIndex)
            }, 1000)
        }),
        Events.subscribe(element, "dragleave", () => {
            element.classList.remove("drag-over")
            dragSwitch.terminate()
        }),
        octave.catchupAndSubscribe(updateActiveState)
    )
    return element
}