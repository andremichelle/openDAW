import css from "./DropDown.sass?inline"
import {Func, Lifecycle, MutableObservableValue, Provider} from "@opendaw/lib-std"
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
}

export const DropDown = <T, >({lifecycle, owner, provider, mapping, appearance, width}: Construct<T>) => {
    const injectLabel = Inject.value(mapping(owner.getValue()))
    lifecycle.own(owner.subscribe(owner => {injectLabel.value = mapping(owner.getValue())}))
    return (
        <div className={className}>
            <MenuButton root={MenuItem.root().setRuntimeChildrenProcedure(parent => {
                for (const value of provider()) {
                    parent.addMenuItem(MenuItem.default({
                        label: mapping(value),
                        checked: value === owner.getValue()
                    }).setTriggerProcedure(() => owner.setValue(value)))
                }
            })} appearance={appearance ?? {framed: true, color: Colors.dark, activeColor: Colors.gray}}>
                <label style={{minWidth: width ?? "unset"}}>{injectLabel}<Icon symbol={IconSymbol.Dropdown}/></label>
            </MenuButton>
        </div>
    )
}