import { isDefined, PI_HALF, TAU, unitValue } from "@opendaw/lib-std"
import { createElement } from "@opendaw/lib-jsx"
import { Html, Svg } from "@opendaw/lib-dom"
import css from "../../components/Knob.sass?inline"

// Reuse the native design constants
export const HaloDesign = {
    radius: 28, // Bigger native radius
    trackWidth: 3, // Thicker track
    angleOffset: Math.PI / 5.0,
    indicator: [0.65, 1.0] as [number, number], // Push indicators to OUTER rim
    indicatorWidth: 3, // Thicker ticks
    bodyRadius: 0.55 // Ratio for the solid inner knob
}

export interface VisualKnobProps {
    value: unitValue // User's Interactive Value (Teal)
    design?: typeof HaloDesign
    color?: string

    suggestionValue?: unitValue // Odie's Proposed Value (Purple)
    originalValue?: unitValue   // The value before Odie touched it (Grey)
}

// Adopt the styles once for this component usage
const className = Html.adoptStyleSheet(css, "knob")

/**
 * A purely visual Knob component that replicates the native OpenDAW look.
 * Visual Hierarchy:
 * 1. User Value (Main Arc + Indicator) - Bright, Active
 * 2. Suggestion (Ghost Indicator) - Colored, Reference
 * 3. Original (Tick Mark) - Subtle, History
 */
export const VisualKnob = ({ value: rawValue, design, color, suggestionValue, originalValue }: VisualKnobProps) => {
    const { radius, trackWidth, angleOffset, indicator: [min, max], indicatorWidth, bodyRadius } = { ...HaloDesign, ...design }

    // Clamp helper
    const clamp = (v: number) => Math.max(0.0, Math.min(1.0, v))
    const toAngle = (v: number) => (PI_HALF + angleOffset) + clamp(v) * (TAU - angleOffset * 2.0)

    const safeValue = clamp(rawValue)
    const trackRadius = Math.floor(radius - trackWidth * 0.5)

    // Geometry Constants
    const angleMin = PI_HALF + angleOffset
    const angleMax = PI_HALF - angleOffset
    const angleVal = toAngle(safeValue)

    // Main Value Arc
    const valuePathD = Svg.pathBuilder()
        .circleSegment(0, 0, trackRadius, angleMin - 1.0 / trackRadius, angleVal + 1.0 / trackRadius)
        .get()

    // Main Indicator
    const buildIndicator = (angle: number, iMin: number, iMax: number) => {
        const c = Math.cos(angle) * trackRadius
        const s = Math.sin(angle) * trackRadius
        return Svg.pathBuilder().moveTo(c * iMin, s * iMin).lineTo(c * iMax, s * iMax).get()
    }
    const indicatorPathD = buildIndicator(angleVal, min, max)

    // Secondary Indicators
    let suggestionPathD = ""
    if (suggestionValue !== undefined) {
        suggestionPathD = buildIndicator(toAngle(suggestionValue), min, max)
    }

    let originalPathD = ""
    if (originalValue !== undefined) {
        // Make original tick slightly shorter/subtle
        originalPathD = buildIndicator(toAngle(originalValue), min, max - 0.1)
    }

    const width = radius * 2.0
    const height = radius + Math.ceil(Math.cos(angleOffset) * radius)

    const svg: SVGSVGElement = (
        <svg viewBox={`0 0 ${width} ${height}`} classList={className} style={{ overflow: "visible" }}>
            <g fill="none"
                stroke="currentColor"
                stroke-width={trackWidth}
                transform={`translate(${radius}, ${radius})`}>

                {/* 1. Background Knob Body (Solid Inner Circle) */}
                <circle r={radius * bodyRadius} stroke="none" fill="rgba(255,255,255,0.1)" />

                {/* 2. Track Background */}
                <path stroke="currentColor" stroke-opacity={0.2}
                    d={Svg.pathBuilder()
                        .circleSegment(0, 0, trackRadius, angleMin, angleMax)
                        .get()} />

                {/* 3. Original Value (Subtle Grey Tick) */}
                {originalPathD && (
                    <path
                        d={originalPathD}
                        stroke="rgba(255,255,255,0.4)"
                        stroke-width={2}
                        stroke-linecap="round"
                    />
                )}

                {/* 4. Suggestion Value (Odie Purple - High Vis) */}
                {suggestionPathD && (
                    <path
                        d={suggestionPathD}
                        stroke="#a78bfa"
                        stroke-width={3}
                        stroke-linecap="round"
                    />
                )}

                {/* 5. User Value (Active Teal Arc + Indicator) */}
                <path d={valuePathD} classList="knob-value-arc" />
                <path d={indicatorPathD}
                    classList="knob-indicator-line"
                    stroke-linecap="round"
                    stroke-width={indicatorWidth}
                    stroke="white" />
            </g>
        </svg>
    )

    if (isDefined(color)) {
        svg.style.color = color
    }

    return svg
}
