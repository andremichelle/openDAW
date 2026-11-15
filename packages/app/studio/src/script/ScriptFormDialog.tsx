import css from "./ScriptFormDialog.sass?inline"
import {DefaultObservableValue, isDefined, Lifecycle, Nullable, Provider, Terminator} from "@opendaw/lib-std"
import {createElement, JsxValue} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {IconSymbol} from "@opendaw/studio-enums"
import {DialogField, DialogRequest, DialogValue} from "@opendaw/studio-scripting"
import {Dialog} from "@/ui/components/Dialog"
import {Surface} from "@/ui/surface/Surface"
import {TextInput} from "@/ui/components/TextInput"
import {NumberInput} from "@/ui/components/NumberInput"
import {Checkbox} from "@/ui/components/Checkbox"
import {Slider} from "@/ui/components/Slider"
import {Icon} from "@/ui/components/Icon"
import {DropDown} from "@/ui/composite/DropDown"
import {ScriptFormValues} from "@/script/ScriptFormValues"

const className = Html.adoptStyleSheet(css, "ScriptFormDialog")

export namespace ScriptFormDialog {
    export const show = ({headline, okText, fields}: DialogRequest): Promise<Nullable<ReadonlyArray<DialogValue>>> => {
        const {resolve, promise} = Promise.withResolvers<Nullable<ReadonlyArray<DialogValue>>>()
        const lifecycle = new Terminator()
        const values: Array<Provider<DialogValue>> = []
        const rows = fields.map(field => renderField(lifecycle, field, values))
        const dialog: HTMLDialogElement = (
            <Dialog headline={headline}
                    icon={IconSymbol.Code}
                    cancelable={true}
                    buttons={[
                        {text: "Cancel", onClick: handler => handler.close()},
                        {
                            text: okText,
                            primary: true,
                            onClick: handler => {
                                resolve(values.map(value => value()))
                                handler.close()
                            }
                        }
                    ]}>
                <div className={className}>
                    <div className="grid">{rows}</div>
                </div>
            </Dialog>
        )
        dialog.addEventListener("close", () => resolve(null))
        Surface.get().body.appendChild(dialog)
        dialog.showModal()
        return promise.finally(() => lifecycle.terminate())
    }

    const renderField = (lifecycle: Lifecycle, field: DialogField, values: Array<Provider<DialogValue>>): JsxValue => {
        if (field.type === "section") {return <div className="section">{field.label}</div>}
        if (field.type === "slider") {
            const {guard, mapper, maxChars, step, decimal, mapping} = ScriptFormValues.slider(field)
            const model = lifecycle.own(new DefaultObservableValue(field.value))
            values.push(() => model.getValue())
            return [
                <div>{`${field.label}:`}</div>,
                <Slider lifecycle={lifecycle} model={model} mapping={mapping} guard={guard}/>,
                <div className="readout">
                    <NumberInput lifecycle={lifecycle} model={model} guard={guard} mapper={mapper}
                                 maxChars={maxChars} step={step} decimal={decimal}/>
                    {isDefined(field.unit) && <span className="unit">{field.unit}</span>}
                </div>
            ]
        }
        return [<div>{`${field.label}:`}</div>, <div className="control">{renderControl(lifecycle, field, values)}</div>]
    }

    const renderControl = (lifecycle: Lifecycle,
                           field: Exclude<DialogField, { type: "section" | "slider" }>,
                           values: Array<Provider<DialogValue>>): JsxValue => {
        switch (field.type) {
            case "text": {
                const model = lifecycle.own(new DefaultObservableValue(field.value))
                values.push(() => model.getValue())
                return <TextInput lifecycle={lifecycle} model={model}/>
            }
            case "checkbox": {
                const model = lifecycle.own(new DefaultObservableValue(field.value))
                values.push(() => model.getValue())
                return <Checkbox lifecycle={lifecycle} model={model}><Icon symbol={IconSymbol.Checkbox}/></Checkbox>
            }
            case "dropdown": {
                const {options} = field
                const model = lifecycle.own(new DefaultObservableValue(field.value))
                const longest = options.reduce((length, option) => Math.max(length, option.label.length), 0)
                values.push(() => model.getValue())
                return (
                    <DropDown lifecycle={lifecycle}
                              owner={model}
                              provider={() => options.map(option => option.value)}
                              mapping={value => options.find(option => option.value === value)?.label ?? ""}
                              width={`${longest + 4}ch`}/>
                )
            }
            case "number": {
                const {guard, mapper, maxChars, step, decimal} = ScriptFormValues.number(field)
                const model = lifecycle.own(new DefaultObservableValue(field.value))
                values.push(() => model.getValue())
                return [
                    <NumberInput lifecycle={lifecycle} model={model} guard={guard} mapper={mapper}
                                 maxChars={maxChars} step={step} decimal={decimal}/>,
                    isDefined(field.unit) && <span className="unit">{field.unit}</span>
                ]
            }
        }
    }
}
