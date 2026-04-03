import css from "./RoomsPage.sass?inline"
import {Await, createElement, Frag, PageContext, PageFactory, replaceChildren} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import type {StudioService} from "@/service/StudioService.ts"
import {ThreeDots} from "@/ui/spinner/ThreeDots"
import {Colors} from "@opendaw/studio-enums"

const className = Html.adoptStyleSheet(css, "RoomsDurationPage")

type RoomsData = Record<string, number>

export const RoomsDurationPage: PageFactory<StudioService> = ({lifecycle}: PageContext<StudioService>) => {
    return (
        <div className={className}>
            <h1>Total Room Duration Per Day</h1>
            <Await
                factory={() => fetch("https://live.opendaw.studio/stats/rooms-duration.json", {mode: "cors"})
                    .then(response => response.json())
                    .then(data => data as RoomsData)}
                failure={({reason}) => <p style={{color: Colors.orange.toString()}}>Failed to load data: {reason}</p>}
                loading={() => <ThreeDots/>}
                success={(data: RoomsData) => {
                    const entries = Object.entries(data).sort(([a], [b]) => a.localeCompare(b))
                    const values = entries.map(([, v]) => v)
                    const labels = entries.map(([k]) => k)
                    const maxValue = Math.max(...values)
                    const minValue = Math.min(...values)
                    const years = [...new Set(labels.map(label => label.slice(0, 4)))]
                    const yearColors = [Colors.blue, Colors.green, Colors.purple, Colors.orange]
                    const yearColorMap = new Map(years.map((year, index) => [year, yearColors[index % yearColors.length]]))
                    const padding = {top: 20, right: 20, bottom: 80, left: 50}
                    const gridLines = 5
                    return (
                        <div className="chart" onInit={element => {
                            lifecycle.own(Html.watchResize(element, () => {
                                Html.empty(element)
                                const width = element.clientWidth
                                const height = element.clientHeight
                                if (width === 0 || height === 0) return
                                const chartWidth = width - padding.left - padding.right
                                const chartHeight = height - padding.top - padding.bottom
                                const barWidth = chartWidth / values.length
                                const barPadding = barWidth * 0.2
                                const dateLabelMinSpacing = 48
                                const dateLabelStep = Math.max(1, Math.ceil(dateLabelMinSpacing / barWidth))
                                const valueLabelMinWidth = 20
                                const showValueLabels = barWidth >= valueLabelMinWidth
                                replaceChildren(element, (
                                    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height}>
                                        {Array.from({length: gridLines + 1}, (_, i) => {
                                            const y = padding.top + (chartHeight / gridLines) * i
                                            const value = Math.round(maxValue - ((maxValue - minValue) / gridLines) * i)
                                            return (
                                                <Frag>
                                                    <line x1={padding.left} y1={y} x2={width - padding.right} y2={y}
                                                          stroke={Colors.shadow} stroke-width="1"/>
                                                    <text x={`${padding.left - 8}`} y={`${y + 4}`} fill={Colors.shadow}
                                                          font-size="11" font-family="sans-serif" text-anchor="end"
                                                    >{value}</text>
                                                </Frag>
                                            )
                                        })}
                                        {values.map((value, i) => {
                                            const barHeight = ((value - minValue) / (maxValue - minValue)) * chartHeight * 0.9 + chartHeight * 0.1
                                            const x = padding.left + i * barWidth + barPadding / 2
                                            const y = padding.top + chartHeight - barHeight
                                            const year = labels[i].slice(0, 4)
                                            const dateLabel = labels[i].slice(5)
                                            const centerX = x + (barWidth - barPadding) / 2
                                            const barColor = yearColorMap.get(year) ?? Colors.blue
                                            return (
                                                <Frag>
                                                    <rect x={x} y={y} width={barWidth - barPadding} height={barHeight}
                                                          fill={barColor} rx="4" ry="4"/>
                                                    {showValueLabels && <text x={`${centerX}`} y={`${y - 6}`}
                                                          fill={Colors.cream}
                                                          font-size="11" font-family="sans-serif"
                                                          text-anchor="middle">{value}</text>}
                                                    {i % dateLabelStep === 0 && <text x={`${centerX}`}
                                                          y={`${padding.top + chartHeight + 8}`}
                                                          fill={Colors.shadow} font-size="10" font-family="sans-serif"
                                                          text-anchor="end"
                                                          transform={`rotate(-45, ${centerX}, ${padding.top + chartHeight + 8})`}
                                                    >{dateLabel}</text>}
                                                </Frag>
                                            )
                                        })}
                                        {years.map(year => {
                                            const firstIndex = labels.findIndex(label => label.startsWith(year))
                                            const lastIndex = labels.length - 1 - [...labels].reverse()
                                                .findIndex(label => label.startsWith(year))
                                            const x1 = padding.left + firstIndex * barWidth
                                            const x2 = padding.left + (lastIndex + 1) * barWidth
                                            const centerX = (x1 + x2) / 2
                                            const labelY = padding.top + chartHeight + 50
                                            const color = yearColorMap.get(year) ?? Colors.blue
                                            return (
                                                <text x={`${centerX}`} y={`${labelY}`}
                                                      fill={color} font-size="13" font-weight="bold"
                                                      font-family="sans-serif" text-anchor="middle"
                                                >{year}</text>
                                            )
                                        })}
                                        {(() => {
                                            const windowSize = Math.max(1, Math.round(values.length / 15))
                                            const points = values.map((_, i) => {
                                                const start = Math.max(0, i - Math.floor(windowSize / 2))
                                                const end = Math.min(values.length, start + windowSize)
                                                const slice = values.slice(start, end)
                                                const avg = slice.reduce((sum, val) => sum + val, 0) / slice.length
                                                const barHeight = ((avg - minValue) / (maxValue - minValue)) * chartHeight * 0.9 + chartHeight * 0.1
                                                const x = padding.left + i * barWidth + barWidth / 2
                                                const y = padding.top + chartHeight - barHeight
                                                return `${x},${y}`
                                            })
                                            return <polyline points={points.join(" ")} fill="none"
                                                            stroke={Colors.orange} stroke-width="2"
                                                            stroke-linejoin="round"/>
                                        })()}
                                    </svg>
                                ))
                            }))
                        }}/>
                    )
                }}
            />
        </div>
    )
}
