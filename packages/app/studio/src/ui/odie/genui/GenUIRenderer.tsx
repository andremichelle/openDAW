import { createElement } from "@opendaw/lib-jsx"
import { Lifecycle, Nullable } from "@opendaw/lib-std"
import { UIComponent, UIContainer, UIKnob, UISwitch, UILabel } from "./GenUISchema"
import { ParameterLabel } from "@/ui/components/ParameterLabel"
import { RelativeUnitValueDragging } from "@/ui/wrapper/RelativeUnitValueDragging"
import { AutomatableParameterFieldAdapter, DeviceBoxAdapter } from "@opendaw/studio-adapters"

// --- STYLES ---
const containerStyle = (layout: "row" | "column" | "grid", gap: number = 4) => ({
    display: "flex",
    flexDirection: layout === "grid" ? "row" : layout,
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
// In the actual system, this resolves real Project parameters.
// Fallback adapter for prototype rendering.
const getMockAdapter = (paramName: string): AutomatableParameterFieldAdapter<number> => {
    return {
        name: paramName,
        id: paramName,
        value: 0.5,
        displayValue: "50%",
        normalizedValue: 0.5,
        catchupAndSubscribeControlSources: (_cb: unknown) => ({ terminate: () => { } }),
        catchupAndSubscribe: (_cb: unknown) => ({ terminate: () => { } }),
        subscribe: (_cb: unknown) => ({ terminate: () => { } }),
        stringMapping: { x: (_val: unknown) => ({ value: "50", unit: "%" }) },
        valueMapping: { y: (val: number) => val },
        getControlledUnitValue: () => 0.5,
    } as unknown as AutomatableParameterFieldAdapter<number>
}

type ParamResolver = (target: string) => Nullable<AutomatableParameterFieldAdapter<number>>

export const GenUIRenderer = (props: { lifecycle: Lifecycle, component: UIComponent, resolver?: ParamResolver, key?: string | number }) => {
    const { lifecycle, component, resolver } = props

    if (!component || !component.type) return <div style={{ color: "red" }}>Invalid Component</div>

    switch (component.type) {
        case "container":
            return <GenUIContainer lifecycle={lifecycle} component={component as UIContainer} resolver={resolver} />
        case "knob":
            return <GenUIKnob lifecycle={lifecycle} component={component as UIKnob} resolver={resolver} />
        case "switch":
            return <GenUISwitch lifecycle={lifecycle} component={component as UISwitch} />
        case "label": {
            const label = component as UILabel
            return <div style={(label.style || {}) as any} className={`genui-label-${label.variant || "body"}`}>{label.text}</div>
        }
        case "meter":
            return <div style={{ width: "10px", height: "50px", background: "#333" }}></div>
        default:
            return <div style={{ color: "red" }}>Unknown Component: {(component as unknown as { type: string }).type}</div>
    }
}

const GenUIContainer = ({ lifecycle, component, resolver }: { lifecycle: Lifecycle, component: UIContainer, resolver?: ParamResolver }) => {
    return (
        <div style={containerStyle(component.layout, component.gap) as any}>
            {component.children.map((child, i) => (
                <GenUIRenderer key={child.id || i} lifecycle={lifecycle} component={child} resolver={resolver} />
            ))}
        </div>
    )
}

const GenUIKnob = ({ lifecycle, component, resolver }: { lifecycle: Lifecycle, component: UIKnob, resolver?: ParamResolver }) => {
    let adapter: Nullable<AutomatableParameterFieldAdapter<number>> = null

    if (resolver) {
        adapter = resolver(component.targetParam)
        if (!adapter) {
            console.warn(`[GenUI] Could not resolve parameter: ${component.targetParam}`)
        }
    }

    if (!adapter) {
        adapter = getMockAdapter(component.targetParam)
    }

    return (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
            <span style={{ fontSize: "10px", marginBottom: "2px", opacity: "0.7" }}>{component.label || component.targetParam}</span>
            <RelativeUnitValueDragging lifecycle={lifecycle}
                parameter={adapter}
                editing={{} as any}
                supressValueFlyout={false}>
                <ParameterLabel
                    lifecycle={lifecycle}
                    adapter={adapter as unknown as DeviceBoxAdapter}
                    parameter={adapter}
                    midiLearning={{} as any}
                    editing={{} as any}
                    framed={true}
                    standalone={false}
                />
            </RelativeUnitValueDragging>
        </div>
    )
}

const GenUISwitch = ({ lifecycle: _lifecycle, component }: { lifecycle: Lifecycle, component: UISwitch }) => {
    return <div style={{ border: "1px solid white", padding: "2px" }}>SW: {component.label}</div>
}
