import {Nullable} from "@opendaw/lib-std"

export namespace WheelAxis {
    export type Axis = "undecided" | "horizontal" | "vertical"

    const GestureGapMs = 150.0
    const DecisionPixels = 4.0
    const DeltaModePixel = 0

    let lastEvent: Nullable<WheelEvent> = null
    let lastTime = Number.NEGATIVE_INFINITY
    let sumX = 0.0
    let sumY = 0.0
    let axis: Axis = "undecided"

    export const of = (event: WheelEvent): Axis => {
        if (event === lastEvent) {return axis}
        lastEvent = event
        if (event.timeStamp - lastTime > GestureGapMs) {
            sumX = 0.0
            sumY = 0.0
            axis = "undecided"
        }
        lastTime = event.timeStamp
        if (axis !== "undecided") {return axis}
        sumX += Math.abs(event.deltaX)
        sumY += Math.abs(event.deltaY)
        if (event.deltaMode !== DeltaModePixel || sumX + sumY >= DecisionPixels) {
            axis = sumX > sumY ? "horizontal" : "vertical"
        }
        return axis
    }
}
