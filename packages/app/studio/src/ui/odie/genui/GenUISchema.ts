
export type UIComponentType = "container" | "knob" | "switch" | "label" | "meter"

export interface UIComponentBase {
    id: string
    type: UIComponentType
    label?: string
    style?: Record<string, string | number>
}

export interface UIKnob extends UIComponentBase {
    type: "knob"
    targetParam: string // e.g., "vaporisateur.cutoff"
    min?: number
    max?: number
    step?: number
    unit?: string
}

export interface UISwitch extends UIComponentBase {
    type: "switch"
    targetParam: string
    onValue?: any
    offValue?: any
}

export interface UILabel extends UIComponentBase {
    type: "label"
    text: string
    variant?: "h1" | "h2" | "body" | "caption"
}

export interface UIMeter extends UIComponentBase {
    type: "meter"
    targetSource: string // e.g., "vaporisateur.output"
}

export interface UIContainer extends UIComponentBase {
    type: "container"
    layout: "row" | "column" | "grid"
    children: UIComponent[]
    gap?: number
}

export type UIComponent = UIKnob | UISwitch | UILabel | UIMeter | UIContainer

export interface GenUIPayload {
    title: string
    root: UIComponent
}
