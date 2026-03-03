import css from "./AutomationPage.sass?inline"
import {createElement, PageContext, PageFactory} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {TAU, unitValue} from "@opendaw/lib-std"
import {EventCollection, Interpolation, LoopableRegion, PPQN, ValueEvent} from "@opendaw/lib-dsp"
import {TimelineRange, ValueStreamRenderer} from "@opendaw/studio-core"
import {Html} from "@opendaw/lib-dom"

const className = Html.adoptStyleSheet(css, "AutomationPage")

type EdgeCase = {
    label: string
    events: ReadonlyArray<ValueEvent>
    section: LoopableRegion.Region,
}

const section = {
    position: PPQN.Quarter * 2,
    loopOffset: PPQN.Quarter * 2,
    complete: PPQN.Bar * 2 + PPQN.Quarter * 2,
    loopDuration: PPQN.Bar
}

const EdgeCases: ReadonlyArray<EdgeCase> = [
    {
        label: "Empty",
        events: [],
        section
    },
    {
        label: "One Center",
        events: [
            {
                type: "value-event",
                position: PPQN.Quarter * 2,
                index: 0,
                value: 0.5,
                interpolation: Interpolation.Linear
            }
        ],
        section
    },
    {
        label: "One Left Outside",
        events: [
            {
                type: "value-event",
                position: -PPQN.Quarter,
                index: 0,
                value: 0.5,
                interpolation: Interpolation.Linear
            }
        ],
        section
    },
    {
        label: "One Right Outside",
        events: [
            {
                type: "value-event",
                position: PPQN.Quarter * 5,
                index: 0,
                value: 0.5,
                interpolation: Interpolation.Linear
            }
        ],
        section
    },
    {
        label: "Linear",
        events: [
            {type: "value-event", position: 0, index: 0, value: 0.0, interpolation: Interpolation.Linear},
            {
                type: "value-event",
                position: PPQN.Bar,
                index: 0,
                value: 1.0,
                interpolation: Interpolation.Linear
            }
        ],
        section
    },
    {
        label: "Linear Overlap",
        events: [
            {
                type: "value-event",
                position: -PPQN.Quarter,
                index: 0,
                value: 0.0,
                interpolation: Interpolation.Linear
            },
            {
                type: "value-event",
                position: PPQN.Bar + PPQN.Quarter,
                index: 0,
                value: 1.0,
                interpolation: Interpolation.Linear
            }
        ],
        section
    },
    {
        label: "First In",
        events: [
            {
                type: "value-event",
                position: PPQN.Quarter * 2,
                index: 0,
                value: 0.5,
                interpolation: Interpolation.Linear
            },
            {
                type: "value-event",
                position: PPQN.Bar,
                index: 0,
                value: 1.0,
                interpolation: Interpolation.Linear
            }
        ],
        section
    },
    {
        label: "Last In",
        events: [
            {type: "value-event", position: 0, index: 0, value: 0.0, interpolation: Interpolation.Linear},
            {
                type: "value-event",
                position: PPQN.Quarter * 2,
                index: 0,
                value: 0.5,
                interpolation: Interpolation.Linear
            }
        ],
        section
    },
    {
        label: "Both In",
        events: [
            {
                type: "value-event",
                position: PPQN.Quarter,
                index: 0,
                value: 0.0,
                interpolation: Interpolation.Linear
            },
            {
                type: "value-event",
                position: PPQN.Bar - PPQN.Quarter,
                index: 0,
                value: 1.0,
                interpolation: Interpolation.Linear
            }
        ],
        section
    },
    {
        label: "Two Center",
        events: [
            {
                type: "value-event",
                position: PPQN.Quarter * 2,
                index: 0,
                value: 1.0,
                interpolation: Interpolation.Linear
            },
            {
                type: "value-event",
                position: PPQN.Quarter * 2,
                index: 1,
                value: 0.0,
                interpolation: Interpolation.Linear
            }
        ],
        section
    },
    {
        label: "Two Center IO (top first)",
        events: [
            {type: "value-event", position: 0, index: 0, value: 0.5, interpolation: Interpolation.Linear},
            {
                type: "value-event",
                position: PPQN.Quarter * 2,
                index: 0,
                value: 1.0,
                interpolation: Interpolation.Linear
            },
            {
                type: "value-event",
                position: PPQN.Quarter * 2,
                index: 1,
                value: 0.0,
                interpolation: Interpolation.Linear
            },
            {
                type: "value-event",
                position: PPQN.Bar,
                index: 0,
                value: 0.5,
                interpolation: Interpolation.Linear
            }
        ],
        section
    },
    {
        label: "Two Center IO (bottom first)",
        events: [
            {type: "value-event", position: 0, index: 0, value: 0.5, interpolation: Interpolation.Linear},
            {
                type: "value-event",
                position: PPQN.Quarter * 2,
                index: 1,
                value: 1.0,
                interpolation: Interpolation.Linear
            },
            {
                type: "value-event",
                position: PPQN.Quarter * 2,
                index: 0,
                value: 0.0,
                interpolation: Interpolation.Linear
            },
            {
                type: "value-event",
                position: PPQN.Bar,
                index: 0,
                value: 0.5,
                interpolation: Interpolation.Linear
            }
        ],
        section
    },
    {
        label: "Interpolation.None",
        events: [
            {
                type: "value-event",
                position: PPQN.Quarter * 1,
                index: 0,
                value: 0.75,
                interpolation: Interpolation.Linear
            },
            {
                type: "value-event",
                position: PPQN.Quarter * 3,
                index: 0,
                value: 0.25,
                interpolation: Interpolation.Linear
            }
        ],
        section
    },
    {
        label: "Interpolation.None (clip-in)",
        events: [
            {
                type: "value-event",
                position: -PPQN.Quarter * 1,
                index: 0,
                value: 0.75,
                interpolation: Interpolation.None
            },
            {
                type: "value-event",
                position: PPQN.Quarter * 3,
                index: 0,
                value: 0.25,
                interpolation: Interpolation.Linear
            }
        ],
        section
    },
    {
        label: "Interpolation.None (clip-out)",
        events: [
            {
                type: "value-event",
                position: PPQN.Quarter * 1,
                index: 0,
                value: 0.75,
                interpolation: Interpolation.None
            },
            {
                type: "value-event",
                position: PPQN.Quarter * 5,
                index: 0,
                value: 0.25,
                interpolation: Interpolation.Linear
            }
        ],
        section
    },
    {
        label: "Interpolation None (clip-out with step)",
        events: [
            {type: "value-event", position: -960, index: 0, value: 0.5, interpolation: Interpolation.None},
            {type: "value-event", position: 960, index: 0, value: 0, interpolation: Interpolation.None},
            {type: "value-event", position: 2880, index: 0, value: 1, interpolation: Interpolation.None},
            {type: "value-event", position: 4800, index: 0, value: 0.5, interpolation: Interpolation.None}
        ],
        section
    },
    {
        label: "Interpolation.None (three events)",
        events: [
            {
                type: "value-event",
                position: PPQN.Quarter * 1,
                index: 0,
                value: 0.75,
                interpolation: Interpolation.None
            },
            {
                type: "value-event",
                position: PPQN.Quarter * 2,
                index: 0,
                value: 0.25,
                interpolation: Interpolation.None
            },
            {
                type: "value-event",
                position: PPQN.Quarter * 3,
                index: 0,
                value: 0.50,
                interpolation: Interpolation.None
            }
        ],
        section
    },
    {
        label: "Curve Exact",
        events: [
            {type: "value-event", position: 0, index: 0, value: 0.0, interpolation: Interpolation.Curve(0.7)},
            {
                type: "value-event",
                position: PPQN.Bar,
                index: 0,
                value: 1.0,
                interpolation: Interpolation.Curve(0.0)
            }
        ],
        section
    },
    {
        label: "Curve Fit",
        events: [
            {
                type: "value-event",
                position: PPQN.Quarter,
                index: 0,
                value: 0.0,
                interpolation: Interpolation.Curve(0.7)
            },
            {
                type: "value-event",
                position: PPQN.Bar - PPQN.Quarter,
                index: 0,
                value: 1.0,
                interpolation: Interpolation.Curve(0.0)
            }
        ],
        section
    },
    {
        label: "Curve Overlap",
        events: [
            {
                type: "value-event",
                position: -PPQN.Quarter,
                index: 0,
                value: 0.0,
                interpolation: Interpolation.Curve(0.7)
            },
            {
                type: "value-event",
                position: PPQN.Bar + PPQN.Quarter,
                index: 0,
                value: 1.0,
                interpolation: Interpolation.Curve(0.0)
            }
        ],
        section
    },
    {
        label: "Curve Starts Half",
        events: [
            {
                type: "value-event",
                position: PPQN.Bar / 2,
                index: 0,
                value: 0.0,
                interpolation: Interpolation.Curve(0.7)
            },
            {
                type: "value-event",
                position: PPQN.Bar,
                index: 0,
                value: 1.0,
                interpolation: Interpolation.Curve(0.0)
            }
        ],
        section
    },
    {
        label: "Curve Stops Half",
        events: [
            {type: "value-event", position: 0, index: 0, value: 0.0, interpolation: Interpolation.Curve(0.7)},
            {
                type: "value-event",
                position: PPQN.Bar / 2,
                index: 0,
                value: 1.0,
                interpolation: Interpolation.Curve(0.0)
            }
        ],
        section
    },
    {
        label: "Curve Up-Repeat",
        events: [
            {
                type: "value-event",
                position: PPQN.Quarter * 0,
                index: 0,
                value: 0.0,
                interpolation: Interpolation.Curve(0.7)
            },
            {
                type: "value-event",
                position: PPQN.Quarter * 1,
                index: 0,
                value: 1.0,
                interpolation: Interpolation.Curve(0.7)
            },
            {
                type: "value-event",
                position: PPQN.Quarter * 1,
                index: 1,
                value: 0.0,
                interpolation: Interpolation.Curve(0.7)
            },
            {
                type: "value-event",
                position: PPQN.Quarter * 2,
                index: 0,
                value: 1.0,
                interpolation: Interpolation.Curve(0.7)
            },
            {
                type: "value-event",
                position: PPQN.Quarter * 2,
                index: 1,
                value: 0.0,
                interpolation: Interpolation.Curve(0.7)
            },
            {
                type: "value-event",
                position: PPQN.Quarter * 3,
                index: 0,
                value: 1.0,
                interpolation: Interpolation.Curve(0.7)
            },
            {
                type: "value-event",
                position: PPQN.Quarter * 3,
                index: 1,
                value: 0.0,
                interpolation: Interpolation.Curve(0.7)
            },
            {
                type: "value-event",
                position: PPQN.Quarter * 4,
                index: 0,
                value: 1.0,
                interpolation: Interpolation.Curve(0.7)
            }
        ],
        section
    },
    {
        label: "Curve Bounce",
        events: [
            {
                type: "value-event",
                position: PPQN.Quarter * 0,
                index: 0,
                value: 0.0,
                interpolation: Interpolation.Curve(0.8)
            },
            {
                type: "value-event",
                position: PPQN.Quarter * 1,
                index: 0,
                value: 1.0,
                interpolation: Interpolation.Curve(0.2)
            },
            {
                type: "value-event",
                position: PPQN.Quarter * 2,
                index: 0,
                value: 0.0,
                interpolation: Interpolation.Curve(0.8)
            },
            {
                type: "value-event",
                position: PPQN.Quarter * 3,
                index: 0,
                value: 1.0,
                interpolation: Interpolation.Curve(0.2)
            },
            {
                type: "value-event",
                position: PPQN.Quarter * 4,
                index: 0,
                value: 0.0,
                interpolation: Interpolation.Curve(0.8)
            },
            {
                type: "value-event",
                position: PPQN.Quarter * 5,
                index: 0,
                value: 1.0,
                interpolation: Interpolation.Curve(0.2)
            }
        ],
        section
    },
    {
        label: "Approx Sine",
        events: [
            {
                type: "value-event",
                position: PPQN.Quarter * 0,
                index: 0,
                value: 0.5,
                interpolation: Interpolation.Curve(0.8)
            },
            {
                type: "value-event",
                position: PPQN.Quarter * 1,
                index: 0,
                value: 1.0,
                interpolation: Interpolation.Curve(0.2)
            },
            {
                type: "value-event",
                position: PPQN.Quarter * 2,
                index: 0,
                value: 0.5,
                interpolation: Interpolation.Curve(0.8)
            },
            {
                type: "value-event",
                position: PPQN.Quarter * 3,
                index: 0,
                value: 0.0,
                interpolation: Interpolation.Curve(0.2)
            },
            {
                type: "value-event",
                position: PPQN.Quarter * 4,
                index: 0,
                value: 0.5,
                interpolation: Interpolation.Curve(0.8)
            }
        ],
        section
    },
    {
        label: "Linear Issue",
        events: [
            {
                type: "value-event",
                position: PPQN.Quarter,
                index: 0,
                value: 0.25,
                interpolation: Interpolation.Curve(0.9405259683098594)
            },
            {type: "value-event", position: PPQN.Quarter, index: 1, value: 0, interpolation: Interpolation.Linear},
            {type: "value-event", position: PPQN.Quarter * 3, index: 0, value: 0.5, interpolation: Interpolation.Linear}
        ],
        section
    }
]

export const AutomationPage: PageFactory<StudioService> = ({}: PageContext<StudioService>) => {
    const range = new TimelineRange()
    range.width = 256
    range.maxUnits = PPQN.Bar * 6
    range.showUnitInterval(0, PPQN.Bar * 3)

    const unitMin = range.unitMin
    const unitMax = range.unitMax
    const height = 48
    const loopColor = "rgba(64, 255, 64, 0.25)"
    const contentColor = "rgba(255, 255, 255, 0.5)"

    return (
        <div className={className}>
            <div>
                <h1>Automation Edge Cases</h1>
                <div>
                    {EdgeCases.map(({label, section, events}) => {
                        const canvas: HTMLCanvasElement = (
                            <canvas
                                width={range.width * devicePixelRatio}
                                height={height * devicePixelRatio}
                                style={{
                                    width: `${range.width}px`,
                                    height: `${height}px`
                                }}
                            />
                        )
                        const context: CanvasRenderingContext2D = canvas.getContext("2d")!
                        const radius = 3 * devicePixelRatio
                        const x0 = range.unitToX(section.position) * devicePixelRatio
                        const x1 = range.unitToX(section.complete) * devicePixelRatio
                        context.fillStyle = "rgba(0, 0, 0, 0.25)"
                        context.fillRect(x0, 0, x1 - x0, height * devicePixelRatio)

                        const actualHeight = height * devicePixelRatio
                        const valueToY = (x: unitValue): number => (actualHeight - radius) - x * (actualHeight - radius * 2)
                        const eventCollection = EventCollection.create(ValueEvent.Comparator)
                        events.forEach(event => eventCollection.add(event))
                        for (const pass of LoopableRegion.locateLoops(section, unitMin, unitMax)) {
                            if (pass.index > 0) {
                                const x = Math.floor(range.unitToX(pass.resultStart) * devicePixelRatio)
                                context.fillStyle = loopColor
                                context.fillRect(x, 0, devicePixelRatio, actualHeight)
                            }
                            const windowMin = pass.resultStart - pass.rawStart
                            const windowMax = pass.resultEnd - pass.rawStart
                            const iterator = ValueEvent.iterateWindow(eventCollection, windowMin, windowMax)
                            ValueStreamRenderer.render(context, range, iterator, valueToY, contentColor, 0.2, 0.0, pass)
                            context.strokeStyle = "rgba(255, 255, 255, 0.25)"
                        }
                        const offset = section.position - section.loopOffset
                        for (const event of ValueEvent.iterateWindow(eventCollection, offset, offset + section.loopDuration)) {
                            const x = range.unitToX(offset + section.loopDuration + event.position) * devicePixelRatio
                            const y = valueToY(event.value)
                            context.beginPath()
                            context.arc(x, y, radius, 0.0, TAU)
                            context.stroke()
                        }

                        const N = 9

                        context.fillStyle = "rgba(255, 255, 0, 0.5)"
                        context.beginPath()
                        for (let i = 1; i < N; i++) {
                            const position = i / N * section.loopDuration
                            const x = range.unitToX(offset + section.loopDuration + position) * devicePixelRatio
                            context.moveTo(x, 0)
                            context.lineTo(x, actualHeight)
                        }
                        context.stroke()

                        context.strokeStyle = "none"
                        const iteratable = ValueEvent.quantise(eventCollection, 0, section.loopDuration, N)

                        for (let result = iteratable.next(); ; result = iteratable.next()) {
                            if (result.done) {
                                break
                            } else {
                                const {value: {position, value}} = result
                                const x = range.unitToX(offset + section.loopDuration + position) * devicePixelRatio
                                const y = valueToY(value)
                                context.beginPath()
                                context.arc(x, y, radius, 0.0, TAU)
                                context.fillStyle = "rgba(255, 0, 0, 0.5)"
                                context.fill()
                            }
                        }
                        return (
                            <div className="edge-case">
                                <h5>{label}</h5>
                                {canvas}
                            </div>
                        )
                    })}
                </div>
            </div>
        </div>
    )
}