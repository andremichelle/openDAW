import { createElement } from "@opendaw/lib-jsx"
import { AutomatableParameterFieldAdapter } from "@opendaw/studio-adapters"
import { VisualKnob } from "./components/VisualKnob"
import { Svg } from "@opendaw/lib-dom"
import { PI_HALF, TAU } from "@opendaw/lib-std"
import "./OdieRenderEngine.sass"

// ═══════════════════════════════════════════════════════════════════════════════
// Widget Type Definitions
// ═══════════════════════════════════════════════════════════════════════════════

interface ComparisonTableParams {
    headers: string[]
    rows: string[][]
}

interface SmartKnobParams {
    label: string
    param: string
    trackName?: string
    value: number
    min: number
    max: number
    originalValue?: number
    deviceType?: string
    deviceIndex?: number
    paramPath?: string
}

interface ControlGridParams {
    trackName: string
    title?: string
    knobs: SmartKnobParams[]
}

interface StepListParams {
    title?: string
    options: string[]
}

interface MidiGridParams {
    notes: Array<{
        pitch: number
        velocity?: number
        time: number
        duration: number
    }>
    bars?: number
}

interface ImageGalleryParams {
    url: string
    prompt: string
}

interface ErrorCardParams {
    title: string
    message: string
    actions?: Array<{
        label: string
        actionId: string
        context?: Record<string, string | number | boolean | undefined>
    }>
}

type WidgetComponentName =
    | "comparison_table"
    | "smart_knob"
    | "control_grid"
    | "step_list"
    | "midi_grid"
    | "image_gallery"
    | "error_card"

export interface OdieWidgetPayload {
    type: "ui_component"
    component: WidgetComponentName
    params: unknown
}

export interface WidgetActionCallback {
    (action: {
        type: string
        name: string
        componentId: string
        context: Record<string, string | number | boolean | undefined>
    }): void
}

interface WidgetProps<T> {
    payload: T
}

// ═══════════════════════════════════════════════════════════════════════════════
// Widget Implementations
// ═══════════════════════════════════════════════════════════════════════════════

const ComparisonTable = ({ payload }: WidgetProps<{ headers: string[], rows: string[][] }>) => {
    return (
        <div className="odie-widget-table">
            <table>
                <thead>
                    <tr>
                        {payload.headers.map((h, i) => <th key={i}>{h}</th>)}
                    </tr>
                </thead>
                <tbody>
                    {payload.rows.map((row, r) => (
                        <tr key={r}>
                            {row.map((cell, c) => <td key={c}>{cell}</td>)}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}

const SmartKnob = ({ payload, onAction, adapter, key: _key }: {
    payload: SmartKnobParams
    onAction?: WidgetActionCallback
    adapter?: AutomatableParameterFieldAdapter<number>
    key?: number | string
}) => {
    const initialValue = (adapter && typeof adapter.getValue === 'function') ? adapter.getValue() : (payload.value !== undefined ? payload.value : 0.5)
    let localValue = initialValue

    const min = payload.min !== undefined ? payload.min : 0
    const max = payload.max !== undefined ? payload.max : 1
    const range = (max - min) || 1
    const getUnitValue = (val: number) => (val - min) / range

    const radius = 28
    const trackWidth = 3
    const angleOffset = Math.PI / 5.0
    const minI = 0.65
    const maxI = 1.0

    const trackRadius = Math.floor(radius - trackWidth * 0.5)
    const angleMin = PI_HALF + angleOffset
    const angleRange = (TAU - angleOffset * 2.0)

    let isDragging = false
    let startY = 0
    let startValue = 0

    const handlePointerDown = (e: PointerEvent) => {
        isDragging = true
        startY = e.clientY
        startValue = localValue
        const target = e.currentTarget as HTMLElement
        target.setPointerCapture(e.pointerId)
        e.preventDefault()
    }

    const handlePointerMove = (e: PointerEvent) => {
        if (!isDragging) return
        const deltaY = startY - e.clientY
        const sensitivity = range / 200

        localValue = Math.max(min, Math.min(max, startValue + deltaY * sensitivity))

        if (adapter && typeof adapter.setValue === 'function') {
            adapter.setValue(localValue)
        }

        const knobContainer = (e.currentTarget as HTMLElement)
        // With setPointerCapture, currentTarget is the captured element (the knob div)

        const valueDisplay = knobContainer.querySelector('.knob-value') as HTMLElement
        if (valueDisplay) {
            valueDisplay.textContent = localValue.toFixed(2)
        }

        const safeValue = (localValue - min) / range
        const angleVal = angleMin + safeValue * angleRange

        const valueArc = knobContainer.querySelector('.knob-value-arc')
        if (valueArc) {
            const d = Svg.pathBuilder()
                .circleSegment(0, 0, trackRadius, angleMin - 1.0 / trackRadius, angleVal + 1.0 / trackRadius)
                .get()
            valueArc.setAttribute('d', d)
        }

        const indicatorLine = knobContainer.querySelector('.knob-indicator-line')
        if (indicatorLine) {
            const cos = Math.cos(angleVal) * trackRadius
            const sin = Math.sin(angleVal) * trackRadius
            const d = Svg.pathBuilder()
                .moveTo(cos * minI, sin * minI)
                .lineTo(cos * maxI, sin * maxI)
                .get()
            indicatorLine.setAttribute('d', d)
        }
    }

    const handlePointerUp = (e: PointerEvent) => {
        if (!isDragging) return
        isDragging = false
        const target = e.currentTarget as HTMLElement
        target.releasePointerCapture(e.pointerId)

        if (onAction && localValue !== payload.value) {
            onAction({
                type: "userAction",
                name: "knob_adjust",
                componentId: payload.param,
                context: {
                    param: payload.param,
                    trackName: payload.trackName,
                    value: localValue,
                    previousValue: payload.value,
                    deviceType: payload.deviceType,
                    deviceIndex: payload.deviceIndex,
                    paramPath: payload.paramPath
                }
            })
        }
    }

    const knobColor = "#4fd1c5"

    return (
        <div
            className="odie-widget-knob"
            onpointerdown={handlePointerDown}
            onpointermove={handlePointerMove}
            onpointerup={handlePointerUp}
            onpointercancel={handlePointerUp}
        >
            <label className="knob-label">
                {payload.label}
            </label>

            <div className="knob-container">
                <VisualKnob
                    value={getUnitValue(localValue)}
                    color={knobColor}
                    suggestionValue={getUnitValue(payload.value)}
                    originalValue={payload.originalValue !== undefined ? getUnitValue(payload.originalValue) : undefined}
                />
            </div>

            <span className="knob-value">
                {localValue.toFixed(2)}
            </span>
        </div>
    )
}


const StepList = ({ payload, onAction }: {
    payload: StepListParams
    onAction?: WidgetActionCallback
}) => {
    const steps = payload.options
    return (
        <div className="odie-widget-steps">
            {payload.title && <div className="step-title">{payload.title}</div>}
            {steps.map((step, i) => (
                <div
                    key={i}
                    className="step-item"
                    onmousedown={(event: MouseEvent) => {
                        event.stopPropagation()
                        event.preventDefault()
                        if (onAction) {
                            onAction({
                                type: "userAction",
                                name: "step_select",
                                componentId: "step_list",
                                context: {
                                    value: step
                                }
                            })
                        }
                    }}
                >
                    <div className="step-index">{i + 1}.</div>
                    <div className="step-text">{step}</div>
                </div>
            ))}
        </div>
    )
}

const MidiGrid = ({ payload }: WidgetProps<{ notes: { pitch: number, time: number, duration: number }[] }>) => {
    return (
        <div className="odie-widget-midi">
            {payload.notes.map((n, i) => (
                <div key={i} className="midi-note" style={{
                    left: `${n.time * 25}%`,
                    width: `${n.duration * 25}%`,
                    bottom: `${(n.pitch % 12) * 8 + 4}px`,
                }} />
            ))}
            <div className="midi-label">MIDI Pattern</div>
        </div>
    )
}

const ControlGrid = ({ payload, onAction, resolver }: {
    payload: ControlGridParams
    onAction?: WidgetActionCallback
    resolver?: (target: string) => AutomatableParameterFieldAdapter<number> | undefined
}) => {
    const gridId = `control-grid-${crypto.randomUUID()}`
    return (
        <div id={gridId} className="odie-widget-grid">
            {payload.title && <div className="grid-title">{payload.title}</div>}
            <div className="grid-controls">
                {payload.knobs.map((knob, index) => {
                    let adapter: AutomatableParameterFieldAdapter<number> | undefined
                    if (resolver && knob.param) {
                        adapter = resolver(knob.param)
                    }
                    return (
                        <SmartKnob
                            key={index}
                            adapter={adapter}
                            payload={knob}
                            onAction={(action) => {
                                if (onAction) {
                                    onAction({
                                        ...action,
                                        context: {
                                            ...action.context,
                                            _targetGridId: gridId
                                        }
                                    })
                                }
                            }}
                        />
                    )
                })}
            </div>
            <div className="grid-status-toast">
            </div>
        </div>
    )
}

const ErrorCard = ({ payload, onAction }: {
    payload: ErrorCardParams
    onAction?: WidgetActionCallback
}) => {
    const actions = payload.actions ?? []
    return (
        <div className="odie-widget-error">
            <div className="error-header">
                <div className="error-icon">⚠️</div>
                <div className="error-title">{payload.title}</div>
            </div>
            <div className="error-message">
                {payload.message}
            </div>
            <div className="error-actions">
                {actions.map((action, index) => (
                    <button key={index}
                        onclick={(event: MouseEvent) => {
                            event.stopPropagation()
                            console.log(`🔘 [ErrorCard] Action clicked: ${action.actionId}`, action.context)
                            if (onAction) {
                                onAction({
                                    type: "userAction",
                                    name: "error_action",
                                    componentId: "error_card",
                                    context: {
                                        actionId: action.actionId,
                                        ...action.context
                                    }
                                })
                            }
                        }}
                    >
                        {action.label}
                    </button>
                ))}
            </div>
        </div>
    )
}

const ImageGallery = ({ payload }: WidgetProps<{ url: string, prompt: string }>) => {
    return (
        <div className="odie-widget-image">
            <img src={payload.url} alt={payload.prompt} />
            <div className="image-caption">
                Generated: "{payload.prompt}"
            </div>
        </div>
    )
}

export const OdieRenderEngine = {
    /**
     * Splits text into valid Widget Payloads and raw text fragments.
     */
    parseFragments(text: string): (OdieWidgetPayload | string)[] {
        const fragments: (OdieWidgetPayload | string)[] = []
        const regex = /```json\s*([\s\S]*?)\s*```/g

        let lastIndex = 0
        let match

        while ((match = regex.exec(text)) !== null) {
            if (match.index > lastIndex) {
                fragments.push(text.substring(lastIndex, match.index))
            }

            try {
                const json = JSON.parse(match[1])

                let componentName = ""
                let data = {}

                if (json.type === "ui_component" && json.component) {
                    componentName = json.component
                    data = json.data || {}
                } else if (json.ui_component) {
                    componentName = json.ui_component
                    data = json.data || {}
                } else if (json.type === "add_smart_control" && json.data?.control) {
                    const cType = json.data.control.control_type
                    if (cType === "knob") componentName = "smart_knob"
                    if (cType === "switch") componentName = "smart_switch"
                    data = {
                        label: json.data.control.label || "Control",
                        value: json.data.control.value || 0,
                        ...json.data.control
                    }
                }

                if (componentName) {
                    const aliasMap: Record<string, string> = {
                        "table": "comparison_table",
                        "knob": "smart_knob",
                        "steps": "step_list",
                        "list": "step_list",
                        "midi": "midi_grid",
                        "image": "image_gallery",
                        "grid": "control_grid",
                        "knobs": "control_grid"
                    }

                    const finalComponent = (aliasMap[componentName] || componentName) as WidgetComponentName
                    fragments.push({
                        type: "ui_component",
                        component: finalComponent,
                        params: data
                    })
                } else {
                    fragments.push(match[0])
                }
            } catch (e) {
                fragments.push(match[0])
            }

            lastIndex = regex.lastIndex
        }

        if (lastIndex < text.length) {
            fragments.push(text.substring(lastIndex))
        }

        // Post-Process: Group adjacent Smart Knobs into a Grid
        const groupedFragments: (OdieWidgetPayload | string)[] = []
        let currentGrid: OdieWidgetPayload | null = null

        for (let i = 0; i < fragments.length; i++) {
            const frag = fragments[i]
            const isKnob = typeof frag !== "string" && (frag.component === "smart_knob")
            const isWhitespace = typeof frag === "string" && !frag.trim()

            if (isKnob) {
                if (!currentGrid) {
                    currentGrid = {
                        type: "ui_component",
                        component: "control_grid",
                        params: { trackName: "", knobs: [frag.params as SmartKnobParams] }
                    }
                } else {
                    ((currentGrid.params as ControlGridParams).knobs).push(frag.params as SmartKnobParams)
                }
            } else if (isWhitespace) {
                const nextIndex = i + 1
                const nextFrag = nextIndex < fragments.length ? fragments[nextIndex] : null
                const nextIsKnob = nextFrag && typeof nextFrag !== "string" && nextFrag.component === "smart_knob"

                if (currentGrid && nextIsKnob) {
                    continue
                } else {
                    if (currentGrid) {
                        groupedFragments.push(currentGrid)
                        currentGrid = null
                    }
                    groupedFragments.push(frag)
                }
            } else {
                if (currentGrid) {
                    groupedFragments.push(currentGrid)
                    currentGrid = null
                }
                groupedFragments.push(frag)
            }
        }

        if (currentGrid) {
            groupedFragments.push(currentGrid)
        }

        return groupedFragments
    },

    extractPayload(text: string): OdieWidgetPayload | null {
        const fragments = this.parseFragments(text)
        const widget = fragments.find(f => typeof f !== "string")
        return (widget as OdieWidgetPayload) || null
    },

    render(
        payload: OdieWidgetPayload,
        onAction?: WidgetActionCallback,
        resolver?: (target: string) => AutomatableParameterFieldAdapter<number> | undefined
    ) {
        switch (payload.component) {
            case "comparison_table":
                return <ComparisonTable payload={payload.params as ComparisonTableParams} />
            case "smart_knob": {
                const params = payload.params as SmartKnobParams
                let adapter: AutomatableParameterFieldAdapter<number> | undefined
                if (resolver) {
                    adapter = resolver(params.param)
                }
                return <SmartKnob payload={params} onAction={onAction} adapter={adapter} />
            }
            case "control_grid":
                return <ControlGrid payload={payload.params as ControlGridParams} onAction={onAction} resolver={resolver} />
            case "step_list":
                return <StepList payload={payload.params as StepListParams} onAction={onAction} />
            case "midi_grid":
                return <MidiGrid payload={payload.params as MidiGridParams} />
            case "image_gallery":
                return <ImageGallery payload={payload.params as ImageGalleryParams} />
            case "error_card":
                return <ErrorCard payload={payload.params as ErrorCardParams} onAction={onAction} />
        }
    }
}
