import { createElement } from "@opendaw/lib-jsx"
import { Icon } from "@/ui/components/Icon.tsx"
import { IconSymbol } from "@opendaw/studio-enums"
import { OdieService } from "./OdieService"
import { OdieChat } from "./OdieChat"
import { Html } from "@opendaw/lib-dom"

import css from "../workspace/PanelPlaceholder.sass?inline"

const className = Html.adoptStyleSheet(css, "PanelPlaceholder")

type Construct = {
    service: OdieService
}

export const OdiePanel = ({ service }: Construct) => {
    // We reuse PanelPlaceholder classes to mimic the look
    // .PanelPlaceholder.right (orientation)

    const closeButton = (
        <button className="close-button"
            style={{ cursor: "pointer", padding: "0 8px", background: "none", border: "none" }}
            aria-label="Close"
            onclick={(e: MouseEvent) => {
                e.preventDefault()
                e.stopPropagation()
                service.toggle()
            }}>
            <Icon symbol={IconSymbol.Close} />
        </button>
    )
    // closeButton.onclick handled inline above for type safety with HTMLButtonElement

    return (
        <div className={Html.buildClassList(className, "right")}
            style={{
                height: "100%",
                display: "flex",
                flexDirection: "column",
                borderLeft: "1px solid var(--color-edge-soft)",
                background: "var(--color-gap)"
            }}>
            <header>
                <span>Odie</span>
                <div style={{ flex: "1" }} />
                {closeButton}
            </header>
            <div style={{ flex: "1", display: "flex", overflow: "hidden" }}>
                {OdieChat({ service })}
            </div>
        </div>
    )
}
