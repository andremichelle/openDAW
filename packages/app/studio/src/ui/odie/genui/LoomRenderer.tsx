import { createElement } from "@opendaw/lib-jsx"
import { Lifecycle } from "@opendaw/lib-std"
import { UIComponent, UIContainer, UIKnob, UISwitch } from "./GenUISchema"
import { ParameterLabel } from "@/ui/components/ParameterLabel"
import { RelativeUnitValueDragging } from "@/ui/wrapper/RelativeUnitValueDragging"
import { AutomatableParameterFieldAdapter } from "@opendaw/studio-adapters"

// --- STYLES ---
const containerStyle = (layout: "row" | "column" | "grid", gap: number = 4) => ({
    display: "flex",
    flexDirection: layout === "grid" ? "row" : layout, // Grid TODO
    flexWrap: layout === "grid" ? "wrap" : "nowrap",
    gap: `${gap}px`,
    alignItems: "center",
    justifyContent: "center",
    padding: "4px",
    background: "rgba(255, 255, 255, 0.02)",
    borderRadius: "4px",
    border: "1px solid rgba(255, 255, 255, 0.05)"
})

// --- MOCK ADAPTER FACTORY ---
// In the real system, this will look up actual Project parameters.
// For the prototype, we return a dummy adapter so the UI renders without crashing.
const getMockAdapter = (paramName: string): AutomatableParameterFieldAdapter<number> => {
    return {
        name: paramName,
        id: paramName,
        value: 0.5,
        displayValue: "50%",
        normalizedValue: 0.5,
        // Mocking the critical methods needed by ParameterLabel
        catchupAndSubscribeControlSources: (_cb: any) => ({ terminate: () => { } }),
        catchupAndSubscribe: (_cb: any) => ({ terminate: () => { } }),
        subscribe: (_cb: any) => ({ terminate: () => { } }),
        stringMapping: { x: (_val: any) => ({ value: "50", unit: "%" }) },
        valueMapping: { y: (val: any) => val },
        getControlledUnitValue: () => 0.5,
    } as any
}


// [ANTIGRAVITY] Real Parameter Resolution
type ParamResolver = (target: string) => AutomatableParameterFieldAdapter<number> | null

export const LoomRenderer = (props: { lifecycle: Lifecycle, component: UIComponent, resolver?: ParamResolver, key?: string | number }) => {
    const { lifecycle, component, resolver } = props

    // Explicit check to ensure TS knows component type
    if (!component || !component.type) return <div style={{ color: "red" }}>Invalid Component</div>

    switch (component.type) {
        case "container":
            return <LoomContainer lifecycle={lifecycle} component={component as UIContainer} resolver={resolver} />
        case "knob":
            return <LoomKnob lifecycle={lifecycle} component={component as UIKnob} resolver={resolver} />
        case "switch":
            return <LoomSwitch lifecycle={lifecycle} component={component as UISwitch} />
        case "label":
            const label = component as any
            return <div style={{ ...label.style }} className={`genui-label-${label.variant || "body"}`}>{label.text}</div>
        case "meter":
            return <div style={{ width: "10px", height: "50px", background: "#333" }}></div> // Placeholder
        default:
            return <div style={{ color: "red" }}>Unknown Component: {(component as any).type}</div>
    }
}

const LoomContainer = ({ lifecycle, component, resolver }: { lifecycle: Lifecycle, component: UIContainer, resolver?: ParamResolver }) => {
    return (
        <div style={containerStyle(component.layout, component.gap) as any}>
            {component.children.map((child, i) => (
                <LoomRenderer key={child.id || i} lifecycle={lifecycle} component={child} resolver={resolver} />
            ))}
        </div>
    )
}

const LoomKnob = ({ lifecycle, component, resolver }: { lifecycle: Lifecycle, component: UIKnob, resolver?: ParamResolver }) => {
    // 1. Try to resolve real parameter
    let adapter: AutomatableParameterFieldAdapter<number> = null as any

    if (resolver) {
        const found = resolver(component.targetParam)
        if (found) {
            adapter = found
        } else {
            console.warn(`[Loom] Could not resolve parameter: ${component.targetParam}`)
        }
    }

    // 2. Fallback to Mock if not found (keeps UI from crashing)
    if (!adapter) {
        adapter = getMockAdapter(component.targetParam)
    }

    return (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
            <span style={{ fontSize: "10px", marginBottom: "2px", opacity: "0.7" }}>{component.label || component.targetParam}</span>
            {/* We wrap it in the standard Dragging behavior for authenticity */}
            <RelativeUnitValueDragging lifecycle={lifecycle}
                parameter={adapter as any}
                editing={{} as any} // Mock BoxEditing
                supressValueFlyout={false}>
                <ParameterLabel
                    lifecycle={lifecycle}
                    adapter={null as any} // The low-level component might need the DeviceAdapter, mock null for now
                    parameter={adapter as any}
                    midiLearning={{} as any} // Mock MIDILearning
                    editing={{} as any} // Mock BoxEditing
                    framed={true}
                    standalone={false}
                />
            </RelativeUnitValueDragging>
        </div>
    )
}

// TODO: Implement Switch
const LoomSwitch = ({ lifecycle: _lifecycle, component }: { lifecycle: Lifecycle, component: UISwitch }) => {
    return <div style={{ border: "1px solid white", padding: "2px" }}>SW: {component.label}</div>
}
