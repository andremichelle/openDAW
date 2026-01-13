import css from "./UsersPage.sass?inline"
import {Await, createElement, Frag, PageContext, PageFactory, replaceChildren} from "@moises-ai/lib-jsx"
import {Html} from "@moises-ai/lib-dom"
import type {StudioService} from "@/service/StudioService.ts"
import {ThreeDots} from "@/ui/spinner/ThreeDots"
import {Colors} from "@moises-ai/studio-enums"

const className = Html.adoptStyleSheet(css, "UsersPage")

type UsersData = Record<string, number>

export const UsersPage: PageFactory<StudioService> = ({lifecycle}: PageContext<StudioService>) => {
    return (
        <div className={className}>
            <h1>Peak Concurrent Users</h1>
            <Await
                factory={() => fetch("https://api.opendaw.studio/users/graph.json", {
                    mode: "cors",
                    credentials: "include"
                })
                    .then(response => response.json())
                    .then(data => data as UsersData)}
                failure={({reason}) => <p style={{color: Colors.orange.toString()}}>Failed to load data: {reason}</p>}
                loading={() => <ThreeDots/>}
                success={(data: UsersData) => {
                    const entries = Object.entries(data).sort(([a], [b]) => a.localeCompare(b))
                    const values = entries.map(([, v]) => v)
                    const labels = entries.map(([k]) => k)
                    const maxValue = Math.max(...values)
                    const minValue = Math.min(...values)
                    const padding = {top: 20, right: 20, bottom: 60, left: 50}
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
                                            const dateLabel = labels[i].slice(5)
                                            const centerX = x + (barWidth - barPadding) / 2
                                            return (
                                                <Frag>
                                                    <rect x={x} y={y} width={barWidth - barPadding} height={barHeight}
                                                          fill={Colors.blue} rx="4" ry="4"/>
                                                    <text x={`${centerX}`} y={`${y - 6}`} fill={Colors.cream}
                                                          font-size="11" font-family="sans-serif"
                                                          text-anchor="middle">{value}</text>
                                                    <text x={`${centerX}`} y={`${padding.top + chartHeight + 8}`}
                                                          fill={Colors.shadow} font-size="10" font-family="sans-serif"
                                                          text-anchor="end"
                                                          transform={`rotate(-45, ${centerX}, ${padding.top + chartHeight + 8})`}
                                                    >{dateLabel}</text>
                                                </Frag>
                                            )
                                        })}
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
