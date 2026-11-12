import {int, isDefined} from "@opendaw/lib-std"
import {createElement, JsxValue} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {AutomatableParameterFieldAdapter} from "@opendaw/studio-adapters"
import {ControlContext, createParameterInput, createParameterToggle} from "../NanoDeviceEditor/ParameterControls"

// Groups of name and value cells under one coloured head, the cells filling the rows left to right.
export namespace SamplerStacks {
    export type Cell = { readonly name: string, readonly control: JsxValue, readonly key?: object }
    export type Tab = { readonly name: string, readonly cells: ReadonlyArray<Cell> }
    export type Tabbed = { readonly element: HTMLElement, readonly tabs: ReadonlyArray<HTMLElement> }
    // the name elements of a cell's key, lit while something points at it
    export type Highlights = Map<object, Array<HTMLElement>>

    export const value = (context: ControlContext, parameter: AutomatableParameterFieldAdapter): Cell =>
        ({name: parameter.name, control: createParameterInput(context, parameter), key: parameter})

    export const toggle = (context: ControlContext, parameter: AutomatableParameterFieldAdapter<boolean>): Cell =>
        ({name: parameter.name, control: createParameterToggle(context, parameter), key: parameter})

    export const highlight = (highlights: Highlights, key: object, enabled: boolean): void =>
        highlights.get(key)?.forEach(name => name.classList.toggle("highlight", enabled))

    const render = (cells: ReadonlyArray<Cell>, highlights?: Highlights): ReadonlyArray<JsxValue> => cells.map(cell => {
        const name: HTMLElement = <div className="name">{cell.name}</div>
        const key = cell.key
        if (isDefined(key) && isDefined(highlights)) {highlights.set(key, [...highlights.get(key) ?? [], name])}
        return [name, cell.control]
    })

    export const stack = (color: string, heading: string, pairs: int, cells: ReadonlyArray<Cell>,
                          highlights?: Highlights): HTMLElement => (
        <div className={`parameter-stack ${color} pairs-${pairs}`}>
            <div className="label">{heading}</div>
            {render(cells, highlights)}
        </div>
    )

    // one group whose head switches between sets of cells of the same shape
    export const tabbed = (color: string, pairs: int, entries: ReadonlyArray<Tab>, highlights?: Highlights): Tabbed => {
        const bodies: ReadonlyArray<HTMLElement> = entries.map(({cells}, index) => (
            <div className={Html.buildClassList("body", index > 0 && "hidden")}>{render(cells, highlights)}</div>
        ))
        const tabs: ReadonlyArray<HTMLElement> = entries.map(({name}, index) => (
            <div className={Html.buildClassList("tab", index === 0 && "active")} onclick={() => {
                tabs.forEach((tab, other) => tab.classList.toggle("active", other === index))
                bodies.forEach((body, other) => body.classList.toggle("hidden", other !== index))
            }}>{name}</div>
        ))
        const element: HTMLElement = (
            <div className={`parameter-stack tabbed ${color} pairs-${pairs}`}>
                <div className="label">{tabs}</div>
                {bodies}
            </div>
        )
        return {element, tabs}
    }
}
