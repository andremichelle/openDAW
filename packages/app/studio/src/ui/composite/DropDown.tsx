import css from "./DropDown.sass?inline"
import {Func, isDefined, Lifecycle, MutableObservableValue, Predicate, Procedure, Provider} from "@opendaw/lib-std"
import {MenuButton} from "@/ui/components/MenuButton.tsx"
import {createElement, Inject} from "@opendaw/lib-jsx"
import {MenuItem} from "@opendaw/studio-core"
import {Appearance} from "../components/ButtonCheckboxRadio"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {Icon} from "@/ui/components/Icon"
import {Html} from "@opendaw/lib-dom"

const className = Html.adoptStyleSheet(css, "DropDown")

type Construct<T> = {
    lifecycle: Lifecycle
    owner: MutableObservableValue<T>
    provider: Provider<Iterable<T>>
    mapping: Func<T, string>
    appearance?: Appearance
    width?: string
    // further items above the values, e.g. actions that are no value
    head?: Procedure<MenuItem>
    // further items below the values, e.g. actions that are no value
    extra?: Procedure<MenuItem>
    // values listed but not choosable
    selectable?: Predicate<T>
}

export const DropDown = <T, >({lifecycle, owner, provider, mapping, appearance, width, head, extra, selectable}: Construct<T>) => {
    const injectLabel = Inject.value(mapping(owner.getValue()))
    lifecycle.own(owner.subscribe(owner => {injectLabel.value = mapping(owner.getValue())}))
    return (
        <div className={className}>
            <MenuButton root={MenuItem.root().setRuntimeChildrenProcedure(parent => {
                head?.(parent)
                let first = true
                for (const value of provider()) {
                    parent.addMenuItem(MenuItem.default({
                        label: mapping(value),
                        separatorBefore: first && isDefined(head),
                        checked: value === owner.getValue(),
                        selectable: selectable?.(value) ?? true
                    }).setTriggerProcedure(() => owner.setValue(value)))
                    first = false
                }
                extra?.(parent)
            })} appearance={appearance ?? {framed: true, color: Colors.dark, activeColor: Colors.gray}}>
                <label style={{minWidth: width ?? "unset", maxWidth: "100%"}}>
                    <span className="text">{injectLabel}</span>
                    <Icon symbol={IconSymbol.Dropdown}/>
                </label>
            </MenuButton>
        </div>
    )
}