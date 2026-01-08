import { createElement } from "@opendaw/lib-jsx"
import { AutomatableParameterFieldAdapter } from "@opendaw/studio-adapters"
import { VisualKnob } from "./components/VisualKnob"
import { Svg } from "@opendaw/lib-dom"
import { PI_HALF, TAU } from "@opendaw/lib-std"
import "./OdieRenderEngine.sass"

interface WidgetProps<T> {
    data: T
}

// --- WIDGET IMPLEMENTATIONS (Internal for now, will extract later) ---

// --- WIDGET IMPLEMENTATIONS ---

const ComparisonTable = ({ data }: WidgetProps<{ headers: string[], rows: string[][] }>) => {
    return (
        <div className="odie-widget-table">
            <table>
                <thead>
                    <tr>
                        {data.headers.map((h, i) => <th key={i}>{h}</th>)}
                    </tr>
                </thead>
                <tbody>
                    {data.rows.map((row, r) => (
                        <tr key={r}>
                            {row.map((cell, c) => <td key={c}>{cell}</td>)}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}

// [A2UI] Interactive Smart Knob with Drag Control
const SmartKnob = ({ data, onAction, adapter }: WidgetProps<{
    label: string,
    param: string,
    trackName?: string,
    value: number,
    min: number,
    max: number,
    originalValue?: number,
    deviceType?: string,
    deviceIndex?: number,
    paramPath?: string
}> & { onAction?: (action: any) => void, key?: any, adapter?: AutomatableParameterFieldAdapter<number> }) => {
    // Local state for drag interaction
    // If adapter exists, prefer its current value
    const initialValue = (adapter && typeof adapter.getValue === 'function') ? adapter.getValue() : (data.value !== undefined ? data.value : 0.5)
    let localValue = initialValue

    // Normalize to 0-1 for the VisualKnob
    const min = data.min !== undefined ? data.min : 0
    const max = data.max !== undefined ? data.max : 1
    const range = (max - min) || 1 // Avoid division by zero
    const getUnitValue = (val: number) => (val - min) / range

    // Design constants for recalculation
    // Using HaloDesign defaults from VisualKnob
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

    const handleMouseDown = (e: MouseEvent) => {
        isDragging = true
        startY = e.clientY
        startValue = localValue
        document.addEventListener('mousemove', handleMouseMove)
        document.addEventListener('mouseup', handleMouseUp)
        e.preventDefault()
    }

    const handleMouseMove = (e: MouseEvent) => {
        if (!isDragging) return

        // Invert Y: dragging up increases value
        const deltaY = startY - e.clientY
        const sensitivity = range / 200

        let newValue = startValue + deltaY * sensitivity
        newValue = Math.max(data.min, Math.min(data.max, newValue))
        localValue = newValue

        // Live Binding: Write to adapter if available
        if (adapter && typeof adapter.setValue === 'function') {
            adapter.setValue(localValue)
        }

        const knobContainer = (e.target as HTMLElement).closest('.odie-widget-knob')
        if (!knobContainer) return

        // 1. Update Value Text
        const valueDisplay = knobContainer.querySelector('.knob-value') as HTMLElement
        if (valueDisplay) {
            valueDisplay.textContent = localValue.toFixed(2)
        }

        // 2. Update SVG Paths (Visual Feedback)
        const safeValue = (localValue - data.min) / range
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

    const handleMouseUp = () => {
        if (!isDragging) return
        isDragging = false
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)

        // Fire action callback with final value
        if (onAction && localValue !== data.value) {
            onAction({
                type: "userAction",
                name: "knob_adjust",
                componentId: data.param,
                context: {
                    param: data.param,
                    trackName: data.trackName,
                    value: localValue,
                    previousValue: data.value,
                    // [Universal Control] Pass through deep params
                    deviceType: data.deviceType,
                    deviceIndex: data.deviceIndex,
                    paramPath: data.paramPath
                }
            })
        }
    }

    // Colors: Audio engineers love teal/orange. Let's pick a nice accent.
    const knobColor = "#4fd1c5" // Teal-400

    return (
        <div
            className="odie-widget-knob"
            onmousedown={handleMouseDown}
        >
            {/* Top: Label */}
            <span className="knob-label">
                {data.label}
            </span>

            {/* Middle: Knob (Scaled Up via CSS) */}
            <div className="knob-container">
                <VisualKnob
                    value={getUnitValue(localValue)}
                    color={knobColor}
                    suggestionValue={getUnitValue(data.value)}
                    originalValue={data.originalValue !== undefined ? getUnitValue(data.originalValue) : undefined}
                />
            </div>

            {/* Bottom: Value */}
            <span className="knob-value">
                {localValue.toFixed(2)}
            </span>
        </div>
    )
}


const StepList = ({ data, onAction }: WidgetProps<{ title?: string, steps: string[] }> & { onAction?: (action: any) => void }) => {
    return (
        <div className="odie-widget-steps">
            {data.title && <div className="step-title">{data.title}</div>}
            {data.steps.map((step, i) => (
                <div
                    key={i}
                    className="step-item"
                    // Native event handler for non-React environment - trying BOTH cases to be safe
                    // Use onmousedown to match SmartKnob behavior (proven to work)
                    onmousedown={(e: any) => {
                        e.stopPropagation()
                        e.preventDefault()

                        if (onAction) {
                            onAction({
                                name: "step_select",
                                context: {
                                    value: step,
                                    index: i
                                }
                            })
                        } else {
                            console.error("StepList: No onAction provided!")
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

const MidiGrid = ({ data }: WidgetProps<{ notes: { pitch: number, time: number, duration: number }[] }>) => {
    return (
        <div className="odie-widget-midi">
            {data.notes.map((n, i) => (
                <div key={i} className="midi-note" style={{
                    left: `${n.time * 25}%`,
                    width: `${n.duration * 25}%`,
                    bottom: `${(n.pitch % 12) * 8 + 4}px`, // +4 for padding
                }} />
            ))}
            <div className="midi-label">MIDI PREVIEW</div>
        </div>
    )
}

const ControlGrid = ({ data, onAction, resolver }: WidgetProps<{ title?: string, controls: any[] }> & { onAction?: (action: any) => void, resolver?: (target: string) => any }) => {
    // Generate a unique ID for this grid to target it for status updates
    const gridId = `control-grid-${crypto.randomUUID()}`

    return (
        <div id={gridId} className="odie-widget-grid">
            {data.title && <div className="grid-title">{data.title}</div>}

            {/* Controls Container */}
            <div className="grid-controls">
                {data.controls.map((ctrl, i) => {
                    let adapter: AutomatableParameterFieldAdapter<number> | undefined
                    if (resolver && ctrl.param) {
                        const found = resolver(ctrl.param)
                        if (found) adapter = found
                    }
                    return (
                        <SmartKnob
                            key={i}
                            adapter={adapter}
                            data={ctrl}
                            onAction={(action) => {
                                // Inject the gridId into the action context so the service knows where to send the toast
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

            {/* Ghost Status Toast Area */}
            <div className="grid-status-toast">
                {/* Content injected via DOM */}
            </div>
        </div>
    )
}

const ErrorCard = ({ data, onAction }: WidgetProps<{ title: string, message: string, actions: { label: string, id: string }[] }> & { onAction?: (action: any) => void }) => {
    return (
        <div className="odie-widget-error">
            <div className="error-header">
                <div className="error-icon">⚠️</div>
                <div className="error-title">{data.title}</div>
            </div>

            <div className="error-message">
                {data.message}
            </div>

            <div className="error-actions">
                {data.actions.map((action, i) => (
                    <button key={i}
                        onInit={(el: HTMLElement) => {
                            el.onclick = (e) => {
                                e.stopPropagation()
                                console.log("⚡ [ErrorCard] Button Clicked (via onInit):", action.id)
                                if (onAction) onAction({ name: "error_action", context: { actionId: action.id } })
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

const ImageGallery = ({ data }: WidgetProps<{ url: string, prompt: string }>) => {
    return (
        <div className="odie-widget-image">
            <img src={data.url} alt={data.prompt} />
            <div className="image-caption">
                Generated: "{data.prompt}"
            </div>
        </div>
    )
}

// --- RENDER ENGINE ---

export interface OdieWidgetPayload {
    type: "ui_component"
    component: string
    data: any
}

export const OdieRenderEngine = {
    /**
     * Tries to parse a string for a Widget JSON block.
     * Returns the payload if found, null otherwise.
     */
    /**
     * Splits text into valid Widget Payloads and raw text fragments.
     */
    parseFragments(text: string): (OdieWidgetPayload | string)[] {
        const fragments: (OdieWidgetPayload | string)[] = []
        // Relaxed Regex: Allows optional whitespace after ```json and before closing ```
        const regex = /```json\s*([\s\S]*?)\s*```/g

        let lastIndex = 0
        let match

        while ((match = regex.exec(text)) !== null) {
            // 1. Push preceding text
            if (match.index > lastIndex) {
                fragments.push(text.substring(lastIndex, match.index))
            }

            // 2. Try parse JSON
            try {
                const json = JSON.parse(match[1])

                // Unified Schema Handling: Support both Legacy and Simplified
                let componentName = ""
                let data = {}

                if (json.type === "ui_component" && json.component) {
                    componentName = json.component // Legacy Strict
                    data = json.data || {}
                } else if (json.ui_component) {
                    componentName = json.ui_component // New Simplified Standard
                    data = json.data || {}
                } else if (json.type === "add_smart_control" && json.data?.control) {
                    // [HALLUCINATION FIX] Map legacy/hallucinated 'add_smart_control' to 'smart_knob'
                    const cType = json.data.control.control_type
                    if (cType === "knob") componentName = "smart_knob"
                    if (cType === "switch") componentName = "smart_switch" // Future proof
                    // Remap flat structure if needed
                    data = {
                        label: json.data.control.label || "Control",
                        value: json.data.control.value || 0,
                        ...json.data.control
                    }
                }

                if (componentName) {
                    // Normalize Aliases (Postel's Law)
                    const aliasMap: Record<string, string> = {
                        "table": "comparison_table",
                        "knob": "smart_knob",
                        "steps": "step_list",
                        "list": "step_list",
                        "midi": "midi_grid",
                        "image": "image_gallery",
                        "grid": "control_grid",       // New alias
                        "knobs": "control_grid"       // Semantic alias
                    }

                    const finalComponent = aliasMap[componentName] || componentName

                    fragments.push({
                        type: "ui_component",
                        component: finalComponent,
                        data: data
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

        // 3. Post-Process: Group adjacent Smart Knobs into a Grid
        const groupedFragments: (OdieWidgetPayload | string)[] = []
        let currentGrid: OdieWidgetPayload | null = null

        for (let i = 0; i < fragments.length; i++) {
            const frag = fragments[i]
            const isKnob = typeof frag !== "string" && (frag.component === "smart_knob")
            const isWhitespace = typeof frag === "string" && !frag.trim()

            if (isKnob) {
                if (!currentGrid) {
                    // Start a new potential grid
                    currentGrid = {
                        type: "ui_component",
                        component: "control_grid",
                        data: { controls: [frag.data] }
                    }
                } else {
                    // Add to existing grid
                    currentGrid.data.controls.push(frag.data)
                }
            } else if (isWhitespace) {
                // If we have a grid forming, buffer this whitespace. 
                // If the NEXT item is a knob, we swallow this whitespace.
                // If the NEXT item is NOT a knob, we emit the grid, then this whitespace.
                // To simplify: We just peek ahead.
                const nextIndex = i + 1
                const nextFrag = nextIndex < fragments.length ? fragments[nextIndex] : null
                const nextIsKnob = nextFrag && typeof nextFrag !== "string" && nextFrag.component === "smart_knob"

                if (currentGrid && nextIsKnob) {
                    // Swallow whitespace
                    continue
                } else {
                    // Flush grid if exists
                    if (currentGrid) {
                        // If grid has only 1 item, downgrade back to knob? 
                        // User asked for "side by side", so grid is fine even for 1, but maybe safer to keep behavior.
                        // Actually, let's keep it as grid for consistency of styling.
                        // Optimization: If only 1, revert to smart_knob? 
                        // No, ControlGrid handles 1 fine.
                        groupedFragments.push(currentGrid)
                        currentGrid = null
                    }
                    groupedFragments.push(frag)
                }
            } else {
                // Content or other widget
                if (currentGrid) {
                    groupedFragments.push(currentGrid)
                    currentGrid = null
                }
                groupedFragments.push(frag)
            }
        }

        // Flush remaining grid
        if (currentGrid) {
            groupedFragments.push(currentGrid)
        }

        return groupedFragments
    },

    extractPayload(text: string): OdieWidgetPayload | null {
        // Legacy single-payload support (keeping for backward compat if needed, or redirecting)
        const fragments = this.parseFragments(text)
        const widget = fragments.find(f => typeof f !== "string") // Find first widget
        return (widget as OdieWidgetPayload) || null
    },

    render(payload: OdieWidgetPayload, onAction?: (action: any) => void, resolver?: (target: string) => any) {
        switch (payload.component) {
            case "comparison_table": return <ComparisonTable data={payload.data} />
            case "smart_knob":
                // [ANTIGRAVITY] Bind to real parameter if resolver exists
                let adapter: AutomatableParameterFieldAdapter<number> | undefined
                if (resolver) {
                    const found = resolver(payload.data.param)
                    if (found) adapter = found
                }
                return <SmartKnob data={payload.data} onAction={onAction} adapter={adapter} />
            case "control_grid":
                return <ControlGrid data={payload.data} onAction={onAction} resolver={resolver} />
            case "step_list":
                return <StepList data={payload.data} onAction={onAction} />
            case "midi_grid": return <MidiGrid data={payload.data} />
            case "image_gallery": return <ImageGallery data={payload.data} />
            case "error_card": return <ErrorCard data={payload.data} onAction={onAction} />
            default: return <div style={{ color: "red", fontSize: "0.8em" }}>Unknown Widget: {payload.component}</div>
        }
    }
}
