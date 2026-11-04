import {DefaultObservableValue, Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Events} from "@opendaw/lib-dom"

export type PanelTab = "modulators" | "grooves"

// Kept for the session, so the panel reopens on the tab it was left on
export const panelTab = new DefaultObservableValue<PanelTab>("modulators")

// The headline of the modulation panel names both lists, the active one lit
export const PanelTabs = ({lifecycle, active}: { lifecycle: Lifecycle, active: PanelTab }): HTMLElement => {
    const tab = (value: PanelTab, label: string): HTMLElement => (
        <span className={value === active ? "tab active" : "tab"} onInit={element => lifecycle.own(
            Events.subscribe(element, "click", () => panelTab.setValue(value)))}>{label}</span>
    )
    return <span className="tabs">{tab("modulators", "Modulators")}{tab("grooves", "Grooves")}</span>
}
