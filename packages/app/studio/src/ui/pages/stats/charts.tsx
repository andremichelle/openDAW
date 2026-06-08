import {createElement, Frag, replaceChildren} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {Lifecycle, ObservableValue} from "@opendaw/lib-std"
import {Colors} from "@opendaw/studio-enums"
import {DailySeries} from "./data"

type ChartProps = {
    lifecycle: Lifecycle
    series: ObservableValue<DailySeries>
    color?: string
    showAxis?: boolean
    showTrend?: boolean
    peakLabels?: boolean
}

const DEFAULT_PADDING = {top: 16, right: 16, bottom: 28, left: 40}
const COMPACT_PADDING = {top: 8, right: 8, bottom: 8, left: 8}
const GRID_LINES = 4
const LABEL_MIN_DISTANCE = 24
const X_LABEL_MIN_DISTANCE = 32

const formatAxisLabel = (label: string): string => label.includes("-") ? label.slice(5) : label

const latencyBarColor = (label: string): string => {
    if (label.startsWith(">")) {return Colors.red.toString()}
    const ms = parseInt(label, 10)
    if (ms < 10) {return Colors.green.toString()}
    if (ms < 50) {return Colors.yellow.toString()}
    return Colors.orange.toString()
}

const niceStep = (rawStep: number): number => {
    const exponent = Math.floor(Math.log10(Math.max(1, rawStep)))
    for (let magnitudeExp = exponent; magnitudeExp <= exponent + 3; magnitudeExp++) {
        const magnitude = Math.pow(10, magnitudeExp)
        for (const mantissa of [1, 2.5, 5, 10]) {
            const candidate = mantissa * magnitude
            if (Number.isInteger(candidate) && candidate >= 1 && candidate >= rawStep) {return candidate}
        }
    }
    return Math.max(1, Math.ceil(rawStep))
}

const buildAreaPath = (points: ReadonlyArray<readonly [number, number]>, baseY: number): string => {
    if (points.length === 0) return ""
    const segments = points.map(([x, y], index) => `${index === 0 ? "M" : "L"} ${x} ${y}`)
    const [firstX] = points[0]
    const [lastX] = points[points.length - 1]
    return `${segments.join(" ")} L ${lastX} ${baseY} L ${firstX} ${baseY} Z`
}

const buildLinePath = (points: ReadonlyArray<readonly [number, number]>): string =>
    points.map(([x, y], index) => `${index === 0 ? "M" : "L"} ${x} ${y}`).join(" ")

export const LineChart = ({lifecycle, series, color, showAxis = true, showTrend = true}: ChartProps) => {
    const accent = color ?? Colors.blue.toString()
    const padding = showAxis ? DEFAULT_PADDING : COMPACT_PADDING
    return (
        <div className="chart" onInit={element => {
            const render = () => {
                Html.empty(element)
                const data = series.getValue()
                if (data.length === 0) return
                const width = element.clientWidth
                const height = element.clientHeight
                if (width === 0 || height === 0) return
                const chartWidth = Math.max(1, width - padding.left - padding.right)
                const chartHeight = Math.max(1, height - padding.top - padding.bottom)
                const values = data.map(([, value]) => value)
                const labels = data.map(([date]) => date)
                const maxValue = Math.max(...values)
                const minValue = Math.min(0, ...values)
                const valueRange = Math.max(1, maxValue - minValue)
                const stepX = values.length > 1 ? chartWidth / (values.length - 1) : 0
                const points: ReadonlyArray<readonly [number, number]> = values.map((value, index) => {
                    const x = padding.left + index * stepX
                    const y = padding.top + chartHeight - ((value - minValue) / valueRange) * chartHeight
                    return [x, y] as const
                })
                const baseY = padding.top + chartHeight
                const gradientId = `lineFill-${Math.random().toString(36).slice(2, 8)}`
                const dateLabelMinSpacing = 64
                const dateLabelStep = stepX === 0 ? values.length : Math.max(1, Math.ceil(dateLabelMinSpacing / stepX))
                replaceChildren(element, (
                    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height}>
                        <defs>
                            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                                <stop offset="0%" stop-color={accent} stop-opacity="0.5"/>
                                <stop offset="100%" stop-color={accent} stop-opacity="0"/>
                            </linearGradient>
                        </defs>
                        {showAxis && (() => {
                            const lines = Math.min(GRID_LINES, Math.max(1, Math.floor(maxValue)))
                            return Array.from({length: lines + 1}, (_, index) => {
                                const y = padding.top + (chartHeight / lines) * index
                                const value = Math.round(maxValue - (valueRange / lines) * index)
                                return (
                                    <Frag>
                                        <line x1={padding.left} y1={y} x2={width - padding.right} y2={y}
                                              stroke="rgba(255, 255, 255, 0.2)" stroke-width="1" stroke-opacity="0.4"/>
                                        <text x={`${padding.left - 6}`} y={`${y + 4}`}
                                              fill={Colors.shadow.toString()} font-size="10"
                                              font-family="sans-serif" text-anchor="end">{value}</text>
                                    </Frag>
                                )
                            })
                        })()}
                        <path d={buildAreaPath(points, baseY)} fill={`url(#${gradientId})`}/>
                        <path d={buildLinePath(points)} fill="none" stroke={accent}
                              stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
                        {showAxis && labels.map((label, index) => index % dateLabelStep === 0 && (
                            <text x={`${padding.left + index * stepX}`}
                                  y={`${baseY + 16}`}
                                  fill={Colors.shadow.toString()} font-size="10"
                                  font-family="sans-serif" text-anchor="middle">{formatAxisLabel(label)}</text>
                        ))}
                        {showTrend && values.length > 1 && (() => {
                            const count = values.length
                            const sumX = (count - 1) * count / 2
                            const sumY = values.reduce((sum, value) => sum + value, 0)
                            const sumXY = values.reduce((sum, value, index) => sum + index * value, 0)
                            const sumXX = values.reduce((sum, _, index) => sum + index * index, 0)
                            const denominator = count * sumXX - sumX * sumX
                            if (denominator === 0) return null
                            const slope = (count * sumXY - sumX * sumY) / denominator
                            const intercept = (sumY - slope * sumX) / count
                            const trendStart = intercept
                            const trendEnd = slope * (count - 1) + intercept
                            const [firstX] = points[0]
                            const [lastX] = points[points.length - 1]
                            const yStart = padding.top + chartHeight - ((trendStart - minValue) / valueRange) * chartHeight
                            const yEnd = padding.top + chartHeight - ((trendEnd - minValue) / valueRange) * chartHeight
                            return (
                                <line x1={firstX} y1={yStart} x2={lastX} y2={yEnd}
                                      stroke={Colors.blue.toString()} stroke-width="1"
                                      stroke-dasharray="4 3" stroke-opacity="0.8"/>
                            )
                        })()}
                    </svg>
                ))
            }
            lifecycle.own(Html.watchResize(element, render))
            lifecycle.own(series.subscribe(render))
        }}/>
    )
}

export const BarChart = ({lifecycle, series, color, showAxis = true, peakLabels = false}: ChartProps) => {
    const accent = color ?? Colors.purple.toString()
    const padding = showAxis ? DEFAULT_PADDING : COMPACT_PADDING
    return (
        <div className="chart" onInit={element => {
            const render = () => {
                Html.empty(element)
                const data = series.getValue()
                if (data.length === 0) return
                const width = element.clientWidth
                const height = element.clientHeight
                if (width === 0 || height === 0) return
                const chartWidth = Math.max(1, width - padding.left - padding.right)
                const chartHeight = Math.max(1, height - padding.top - padding.bottom)
                const values = data.map(([, value]) => value)
                const labels = data.map(([date]) => date)
                const maxValue = Math.max(...values, 1)
                const slotWidth = chartWidth / values.length
                const barWidth = Math.max(1, slotWidth * 0.7)
                const baseY = padding.top + chartHeight
                const valueStep = niceStep(LABEL_MIN_DISTANCE / 2 * maxValue / chartHeight)
                const axisMax = Math.max(valueStep, Math.ceil(maxValue / valueStep) * valueStep)
                const centerX = (index: number): number => padding.left + index * slotWidth + slotWidth / 2
                const xLabelIndices = (() => {
                    if (peakLabels) {
                        const selected: Array<number> = []
                        const placedX: Array<number> = []
                        const tryPlace = (index: number): void => {
                            const x = centerX(index)
                            if (placedX.every(placed => Math.abs(placed - x) >= X_LABEL_MIN_DISTANCE)) {
                                placedX.push(x)
                                selected.push(index)
                            }
                        }
                        values
                            .map((value, index) => ({value, index}))
                            .sort((left, right) => right.value - left.value)
                            .forEach(({index}) => tryPlace(index))
                        for (let index = 0; index < values.length; index++) {tryPlace(index)}
                        return selected
                    }
                    const dateLabelStep = Math.max(1, Math.ceil(64 / slotWidth))
                    return values.map((_, index) => index).filter(index => index % dateLabelStep === 0)
                })()
                replaceChildren(element, (
                    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height}>
                        {showAxis && (() => {
                            const ticks: Array<number> = []
                            for (let value = 0; value <= axisMax; value += valueStep) {ticks.push(value)}
                            return ticks.map(value => {
                                const y = padding.top + (1 - value / axisMax) * chartHeight
                                return (
                                    <Frag>
                                        <line x1={padding.left} y1={y} x2={width - padding.right} y2={y}
                                              stroke={"rgba(255, 255, 255, 0.2)"} stroke-width="1" stroke-opacity="0.4"/>
                                        <text x={`${padding.left - 6}`} y={`${y + 4}`}
                                              fill={Colors.shadow.toString()} font-size="10"
                                              font-family="sans-serif" text-anchor="end">{value}</text>
                                    </Frag>
                                )
                            })
                        })()}
                        {values.map((value, index) => {
                            const barHeight = (value / axisMax) * chartHeight
                            const x = padding.left + index * slotWidth + (slotWidth - barWidth) / 2
                            const y = baseY - barHeight
                            const fill = peakLabels ? latencyBarColor(labels[index]) : accent
                            return (
                                <rect x={x} y={y} width={barWidth} height={barHeight}
                                      fill={fill} rx="2" ry="2" opacity="0.85"/>
                            )
                        })}
                        {showAxis && xLabelIndices.map(index => (
                            <text x={`${centerX(index)}`}
                                  y={`${baseY + 16}`}
                                  fill={Colors.shadow.toString()} font-size="10"
                                  font-family="sans-serif" text-anchor="middle">{formatAxisLabel(labels[index])}</text>
                        ))}
                    </svg>
                ))
            }
            lifecycle.own(Html.watchResize(element, render))
            lifecycle.own(series.subscribe(render))
        }}/>
    )
}
