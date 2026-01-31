import { createElement } from "@opendaw/lib-jsx"
import { Lifecycle } from "@opendaw/lib-std"
import { Html } from "@opendaw/lib-dom"
import { GenUIRenderer } from "./genui/GenUIRenderer"
import type { OdieService } from "./OdieService"

// --- STYLES ---
const css = `
    component {
        display: flex;
        flex-direction: column;
        width: 320px;
        max-height: 60vh;
        background: #1a1a1a;
        color: #eee;
        font-family: 'Inter', sans-serif;
        border: 1px solid #333;
        border-radius: 12px;
        box-shadow: 0 10px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.05);
        overflow: hidden;
        transition: height 0.2s ease-out;
    }
    component .genui-header {
        padding: 10px 16px;
        background: #252525;
        border-bottom: 1px solid #333;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: #888;
        display: flex;
        justify-content: space-between;
        align-items: center;
        flex-shrink: 0;
    }
    component .genui-content {
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 16px;
        overflow-y: auto;
    }
`

const className = Html.adoptStyleSheet(css, "genui-panel")

export const OdieGenUIPanel = (props: { lifecycle: Lifecycle, service: OdieService }) => {
    const { lifecycle, service } = props

    const content = <div className="genui-content" />

    lifecycle.own(service.genUiPayload.subscribe(obs => {
        const payload = obs.getValue()
        // Clear previous content
        while (content.firstChild) content.lastChild?.remove()

        if (!payload) {
            content.appendChild(
                <div style={{ color: "#666", textAlign: "center", marginTop: "20px", fontSize: "12px" }}>
                    No active interface.
                </div>
            )
            return
        }

        // Render new payload
        const resolver = (path: string) => service.appControl?.resolveParameter(path) ?? null
        content.appendChild(<GenUIRenderer lifecycle={lifecycle} component={payload.root} resolver={resolver} />)
    }))

    return (
        <div className={className}>
            <div className="genui-header">
                <span>Studio Controls</span>
            </div>
            {content}
        </div>
    )
}
