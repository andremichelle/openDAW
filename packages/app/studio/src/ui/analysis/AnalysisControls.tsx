import {createElement, JsxValue} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {DefaultObservableValue, Lifecycle, MutableObservableValue} from "@opendaw/lib-std"
import {Colors} from "@opendaw/studio-enums"
import {Checkbox} from "@/ui/components/Checkbox"
import {RadioGroup} from "@/ui/components/RadioGroup"
import {DropDown} from "@/ui/composite/DropDown"

export const owned = <T, >(lifecycle: Lifecycle, initial: T): DefaultObservableValue<T> =>
    lifecycle.own(new DefaultObservableValue(initial))

export const card = (title: string, controlRow: JsxValue, body: JsxValue,
                     full: boolean = false, cardClass: string = ""): HTMLElement => (
    <div className={Html.buildClassList("card", full && "full", cardClass)}>
        <div className="card-head">
            <span className="title">{title}</span>
            <span className="controls">{controlRow}</span>
        </div>
        <div className="card-body">{body}</div>
    </div>
)

export const toggle = (lifecycle: Lifecycle, model: MutableObservableValue<boolean>, label: string): HTMLElement => (
    <Checkbox lifecycle={lifecycle} model={model}>
        <span>{label}</span>
    </Checkbox>
)

export const radio = (lifecycle: Lifecycle, model: MutableObservableValue<string>,
                      ...options: ReadonlyArray<string>): HTMLElement => (
    <RadioGroup lifecycle={lifecycle} model={model}
                elements={options.map(label => ({value: label, element: (<span>{label}</span>)}))}/>
)

export const dropdown = (lifecycle: Lifecycle, model: MutableObservableValue<string>, width: string,
                         ...options: ReadonlyArray<string>): HTMLElement => (
    <DropDown lifecycle={lifecycle} owner={model} provider={() => options}
              mapping={value => value} appearance={{color: Colors.gray}} width={width}/>
)
