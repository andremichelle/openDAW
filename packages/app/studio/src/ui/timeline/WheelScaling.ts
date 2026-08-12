import {clamp} from "@opendaw/lib-std"
import {Events} from "@opendaw/lib-dom"
import {StudioPreferences, TimelineRange} from "@opendaw/studio-core"

export namespace WheelScaling {
    const DeltaModeToPixels: ReadonlyArray<number> = [1.0, 33.0, 400.0]
    const QuantumFloor = 2.0
    const QuantumDecayMs = 300.0
    const StepPerTick = 0.1

    // Devices report wildly different deltas per notch, so we track the largest recent
    // magnitude (decaying between gestures) and express any event as a fraction of it.
    const calibration = {quantum: 0.0, time: 0.0}

    export const scaleOf = (event: WheelEvent): number => {
        const delta = event.deltaY * (DeltaModeToPixels.at(event.deltaMode) ?? 1.0)
        if (delta === 0.0) {return 0.0}
        const time = performance.now()
        const decayed = calibration.quantum * Math.exp((calibration.time - time) / QuantumDecayMs)
        calibration.quantum = Math.max(Math.abs(delta), decayed, QuantumFloor)
        calibration.time = time
        const speed = StudioPreferences.settings.pointer["wheel-zoom-speed"] / 100.0
        return delta / calibration.quantum * StepPerTick * speed
    }

    export const apply = (element: Element, range: TimelineRange, event: WheelEvent): void => {
        const rect = element.getBoundingClientRect()
        // Before the first layout pass the range has no width yet, which maps any x far outside
        // the visible interval and makes scaleBy jump away from the pointer.
        const anchor = clamp(range.xToValue(event.clientX - rect.left), range.min, range.max)
        range.scaleBy(scaleOf(event), anchor)
    }

    export const install = (element: Element, range: TimelineRange) =>
        Events.subscribe(element, "wheel", (event: WheelEvent) => {
            event.preventDefault()
            apply(element, range, event)
        }, {passive: false})
}
