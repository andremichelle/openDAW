import css from "./Meters.sass?inline"
import {AnimationFrame, Html} from "@moises-ai/lib-dom"
import {Lifecycle, ValueMapping} from "@moises-ai/lib-std"
import {createElement} from "@moises-ai/lib-jsx"
import {Colors} from "@moises-ai/studio-enums"
import {gainToDb} from "@moises-ai/lib-dsp"

const className = Html.adoptStyleSheet(css, "PushMeters")

type Construct = {
    lifecycle: Lifecycle
    inputPeaks: Float32Array  // [peakL, peakR, rmsL, rmsR]
    outputPeaks: Float32Array // [peakL, peakR, rmsL, rmsR]
    reduction: Float32Array   // [reduction] in dB
}

export const Meters = ({lifecycle, inputPeaks, outputPeaks, reduction}: Construct) => {
    const meterWidth = 7
    const meterGap = 4
    const labelWidth = 14
    const width = meterWidth * 5 + meterGap * 4 + labelWidth
    const paddingTop = 8
    const dbLabels = [3, 0, -3, -6, -9, -12, -15, -18, -21, -24] as const
    const mapping = ValueMapping.linear(-24, 3)
    const rmsFill = Colors.blue.toString()
    const peakFill = Colors.blue.opacity(0.3).toString()
    const textFill = "rgba(255, 255, 255, 0.25)"
    const backgroundFill = Colors.blue.brightness(-66).opacity(0.3).toString()
    const meterRects: ReadonlyArray<SVGRectElement> = [
        <rect x={labelWidth} width={meterWidth} height="0" fill={peakFill} rx="1" ry="1"/>,
        <rect x={labelWidth} width={meterWidth} height="0" fill={rmsFill} rx="1" ry="1"/>,
        <rect x={labelWidth + meterWidth + meterGap}
              width={meterWidth} height="0" fill={peakFill} rx="1" ry="1"/>,
        <rect x={labelWidth + meterWidth + meterGap}
              width={meterWidth} height="0" fill={rmsFill} rx="1" ry="1"/>,
        <rect x={labelWidth + (meterWidth + meterGap) * 2} y="0"
              width={meterWidth} height="0" fill={Colors.blue.toString()} rx="1" ry="1"/>,
        <rect x={labelWidth + (meterWidth + meterGap) * 2 + meterWidth + meterGap}
              width={meterWidth} height="0" fill={peakFill} rx="1" ry="1"/>,
        <rect x={labelWidth + (meterWidth + meterGap) * 2 + meterWidth + meterGap}
              width={meterWidth} height="0" fill={rmsFill} rx="1" ry="1"/>,
        <rect x={labelWidth + (meterWidth + meterGap) * 3 + meterWidth + meterGap}
              width={meterWidth} height="0" fill={peakFill} rx="1" ry="1"/>,
        <rect x={labelWidth + (meterWidth + meterGap) * 3 + meterWidth + meterGap}
              width={meterWidth} height="0" fill={rmsFill} rx="1" ry="1"/>
    ]
    const backgroundRects: ReadonlyArray<SVGRectElement> = [
        <rect x={labelWidth} y="0" width={meterWidth}
              fill={backgroundFill} rx="1" ry="1"/>,
        <rect x={labelWidth + meterWidth + meterGap} y="0" width={meterWidth}
              fill={backgroundFill} rx="1" ry="1"/>,
        <rect x={labelWidth + (meterWidth + meterGap) * 2} y="0" width={meterWidth}
              fill={backgroundFill} rx="1" ry="1"/>,
        <rect x={labelWidth + (meterWidth + meterGap) * 2 + meterWidth + meterGap} y="0"
              width={meterWidth} fill={backgroundFill} rx="1" ry="1"/>,
        <rect x={labelWidth + (meterWidth + meterGap) * 3 + meterWidth + meterGap} y="0"
              width={meterWidth} fill={backgroundFill} rx="1" ry="1"/>
    ]
    const labelTexts: ReadonlyArray<SVGTextElement> = dbLabels.map((db, index) => {
        const last = index === dbLabels.length - 1
        return (
            <text x={String(labelWidth - 4)} font-size="7px"
                  fill={textFill} alignment-baseline={last ? "bottom" : "middle"} text-anchor="end">{db}</text>
        )
    })
    const contentGroup: SVGGElement = (
        <g>
            {labelTexts}
            {backgroundRects}
            {meterRects}
        </g>
    )

    const svg: SVGSVGElement = (<svg classList={className}>{contentGroup}</svg>)

    let innerHeight = 0

    const setLevelMeter = (meter: SVGRectElement, dbValue: number) => {
        const h = mapping.x(Math.round(dbValue)) * innerHeight
        meter.y.baseVal.value = innerHeight - h
        meter.height.baseVal.value = h
    }

    const setReductionMeter = (meter: SVGRectElement, reductionDb: number) => {
        const h0 = (1.0 - mapping.x(0)) * innerHeight
        const h1 = (1.0 - mapping.x(Math.min(0, reductionDb))) * innerHeight
        meter.y.baseVal.value = h0
        meter.height.baseVal.value = h1 - h0
    }

    lifecycle.ownAll(
        Html.watchResize(svg, () => {
            if (!svg.isConnected) {return}
            const {clientHeight} = svg
            svg.setAttribute("viewBox", `0 0 ${width} ${clientHeight}`)
            innerHeight = clientHeight - paddingTop
            contentGroup.setAttribute("transform", `translate(0, ${paddingTop})`)
            backgroundRects.forEach((rect, index) => {
                if (index === 2) {
                    // Reduction background: 0dB to -24dB only
                    const zeroDbY = (1.0 - mapping.x(0)) * innerHeight
                    rect.y.baseVal.value = zeroDbY
                    rect.height.baseVal.value = innerHeight - zeroDbY
                } else {
                    rect.height.baseVal.value = innerHeight
                }
            })
            labelTexts.forEach((text, index) => text.setAttribute("y",
                String(Math.ceil((1.0 - mapping.x(dbLabels[index])) * innerHeight))))
        }),
        AnimationFrame.add(() => {
            const [inpPeakL, inpPeakR, inpRmsL, inpRmsR] = inputPeaks
            const [outPeakL, outPeakR, outRmsL, outRmsR] = outputPeaks
            setLevelMeter(meterRects[0], gainToDb(inpPeakL))
            setLevelMeter(meterRects[1], gainToDb(inpRmsL))
            setLevelMeter(meterRects[2], gainToDb(outPeakL))
            setLevelMeter(meterRects[3], gainToDb(outRmsL))
            setReductionMeter(meterRects[4], reduction[0])
            setLevelMeter(meterRects[5], gainToDb(outPeakR))
            setLevelMeter(meterRects[6], gainToDb(outRmsR))
            setLevelMeter(meterRects[7], gainToDb(inpPeakR))
            setLevelMeter(meterRects[8], gainToDb(inpRmsR))
        })
    )
    return svg
}