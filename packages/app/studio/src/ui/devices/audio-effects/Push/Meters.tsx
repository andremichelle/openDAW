import css from "./Meters.sass?inline"
import {AnimationFrame, Html} from "@opendaw/lib-dom"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Colors} from "@opendaw/studio-enums"
import {gainToDb} from "@opendaw/lib-dsp"

const className = Html.adoptStyleSheet(css, "PushMeters")

const height = 140
const padding = 8
const innerHeight = height - padding * 2
const dbRange = 48

type Construct = {
    lifecycle: Lifecycle
    inputPeaks: Float32Array  // [peakL, peakR, rmsL, rmsR]
    outputPeaks: Float32Array // [peakL, peakR, rmsL, rmsR]
    reduction: Float32Array   // [reduction] in dB
}

export const Meters = ({lifecycle, inputPeaks, outputPeaks, reduction}: Construct) => {
    const meterWidth = 6
    const meterGap = 2
    const reductionWidth = 8
    const labelWidth = 14
    const totalWidth = labelWidth + meterWidth * 4 + meterGap * 3 + reductionWidth + meterGap

    // Create meter rects: [InpL_Peak, InpL_RMS, OutL_Peak, OutL_RMS, Reduction, OutR_Peak, OutR_RMS, InpR_Peak, InpR_RMS]
    const meterRects: ReadonlyArray<SVGRectElement> = [
        // InpL Peak (0.3 opacity)
        <rect x={labelWidth} y={innerHeight} width={meterWidth} height="0" fill="rgba(255, 255, 255, 0.3)" rx="1" ry="1"/>,
        // InpL RMS (full opacity)
        <rect x={labelWidth} y={innerHeight} width={meterWidth} height="0" fill="rgba(255, 255, 255, 1.0)" rx="1" ry="1"/>,
        // OutL Peak
        <rect x={labelWidth + meterWidth + meterGap} y={innerHeight} width={meterWidth} height="0" fill="rgba(255, 255, 255, 0.3)" rx="1" ry="1"/>,
        // OutL RMS
        <rect x={labelWidth + meterWidth + meterGap} y={innerHeight} width={meterWidth} height="0" fill="rgba(255, 255, 255, 1.0)" rx="1" ry="1"/>,
        // Reduction (center, orange)
        <rect x={labelWidth + (meterWidth + meterGap) * 2} y="0" width={reductionWidth} height="0" fill={Colors.orange} rx="1" ry="1"/>,
        // OutR Peak
        <rect x={labelWidth + (meterWidth + meterGap) * 2 + reductionWidth + meterGap} y={innerHeight} width={meterWidth} height="0" fill="rgba(255, 255, 255, 0.3)" rx="1" ry="1"/>,
        // OutR RMS
        <rect x={labelWidth + (meterWidth + meterGap) * 2 + reductionWidth + meterGap} y={innerHeight} width={meterWidth} height="0" fill="rgba(255, 255, 255, 1.0)" rx="1" ry="1"/>,
        // InpR Peak
        <rect x={labelWidth + (meterWidth + meterGap) * 3 + reductionWidth + meterGap} y={innerHeight} width={meterWidth} height="0" fill="rgba(255, 255, 255, 0.3)" rx="1" ry="1"/>,
        // InpR RMS
        <rect x={labelWidth + (meterWidth + meterGap) * 3 + reductionWidth + meterGap} y={innerHeight} width={meterWidth} height="0" fill="rgba(255, 255, 255, 1.0)" rx="1" ry="1"/>
    ]

    // Level meter: grows UP from bottom (0 dB = full, -48 dB = empty)
    const setLevelMeter = (meter: SVGRectElement, dbValue: number) => {
        // Clamp to -48..0 range
        const clampedDb = Math.max(-dbRange, Math.min(0, dbValue))
        // Calculate height: 0 dB -> full height, -48 dB -> 0 height
        const h = ((dbRange + clampedDb) / dbRange) * innerHeight
        meter.y.baseVal.value = innerHeight - h
        meter.height.baseVal.value = h
    }

    // Reduction meter: grows DOWN from top (0 dB = empty, -48 dB = full)
    const setReductionMeter = (meter: SVGRectElement, reductionDb: number) => {
        // Clamp to -48..0 range
        const clampedDb = Math.max(-dbRange, Math.min(0, reductionDb))
        // Calculate height: 0 dB -> 0 height, -48 dB -> full height
        const h = (-clampedDb / dbRange) * innerHeight
        meter.y.baseVal.value = 0
        meter.height.baseVal.value = h
    }

    lifecycle.own(AnimationFrame.add(() => {
        // PeakBroadcaster: [peakL, peakR, rmsL, rmsR] - values are in gain, convert to dB
        const [inpPeakL, inpPeakR, inpRmsL, inpRmsR] = inputPeaks
        const [outPeakL, outPeakR, outRmsL, outRmsR] = outputPeaks

        // Level meters grow from bottom
        setLevelMeter(meterRects[0], gainToDb(inpPeakL))
        setLevelMeter(meterRects[1], gainToDb(inpRmsL))
        setLevelMeter(meterRects[2], gainToDb(outPeakL))
        setLevelMeter(meterRects[3], gainToDb(outRmsL))
        // Reduction grows from top (already in dB)
        setReductionMeter(meterRects[4], reduction[0])
        setLevelMeter(meterRects[5], gainToDb(outPeakR))
        setLevelMeter(meterRects[6], gainToDb(outRmsR))
        setLevelMeter(meterRects[7], gainToDb(inpPeakR))
        setLevelMeter(meterRects[8], gainToDb(inpRmsR))
    }))

    // Background rects for meters
    const bgRects = [
        <rect x={labelWidth} y="0" width={meterWidth} height={innerHeight} fill="rgba(0, 0, 0, 0.3)" rx="1" ry="1"/>,
        <rect x={labelWidth + meterWidth + meterGap} y="0" width={meterWidth} height={innerHeight} fill="rgba(0, 0, 0, 0.3)" rx="1" ry="1"/>,
        <rect x={labelWidth + (meterWidth + meterGap) * 2} y="0" width={reductionWidth} height={innerHeight} fill="rgba(0, 0, 0, 0.3)" rx="1" ry="1"/>,
        <rect x={labelWidth + (meterWidth + meterGap) * 2 + reductionWidth + meterGap} y="0" width={meterWidth} height={innerHeight} fill="rgba(0, 0, 0, 0.3)" rx="1" ry="1"/>,
        <rect x={labelWidth + (meterWidth + meterGap) * 3 + reductionWidth + meterGap} y="0" width={meterWidth} height={innerHeight} fill="rgba(0, 0, 0, 0.3)" rx="1" ry="1"/>
    ]

    // dB labels (showing as positive numbers, representing dB below 0)
    const dbLabels = [0, 6, 12, 18, 24, 30, 36, 42, 48]

    return (
        <svg classList={className} viewBox={`0 0 ${totalWidth} ${height}`} width={totalWidth} height={height}>
            <g transform={`translate(0, ${padding})`}>
                {dbLabels.map(db => (
                    <text x="0"
                          y={((db / dbRange) * innerHeight).toString()}
                          font-size="7px"
                          fill="rgba(255, 255, 255, 0.3)"
                          alignment-baseline="middle">{db}</text>
                ))}
                {bgRects}
                {meterRects}
            </g>
        </svg>
    )
}
