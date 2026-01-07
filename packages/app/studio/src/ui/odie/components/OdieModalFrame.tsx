import css from "./OdieModal.sass?inline"
import { createElement } from "@opendaw/lib-jsx"
import { Html } from "@opendaw/lib-dom"

const className = Html.adoptStyleSheet(css, "OdieModal")

export interface OdieModalProps {
    title: string
    icon?: string
    onClose: () => void
    children?: any
    width?: string
    height?: string
    position?: "center" | "right"
    headerContent?: any
}

export const OdieModalFrame = (props: OdieModalProps) => {

    // Dynamic Sizing
    // We can still use inline style for specific Dimensions if they vary per instance,
    // but the structural styles go to SASS.
    const frameStyle = {
        width: props.width || "900px",
        height: props.position === "right" ? "100vh" : (props.height || "80vh")
    }

    const content = <div className="content">
        {props.children}
    </div> as HTMLElement

    // Header
    const header = <div className="header">
        <div className="title-group">
            {props.icon && <div className="icon-box">{props.icon}</div>}
            <div className="title-text">{props.title}</div>
        </div>

        {props.headerContent && <div style={{ flex: "1", display: "flex", justifyContent: "center" }}>
            {props.headerContent}
        </div>}

        <button className="close-btn" onclick={() => close()}>✕</button>
    </div>

    const frame = <div className="frame" style={frameStyle} onclick={(e: Event) => e.stopPropagation()}>
        {header}
        {content}
    </div> as HTMLElement

    const isDocked = props.position === "right"

    // Overlay
    // We toggle the 'visible' class for animation
    const overlay = <div
        className={Html.buildClassList(className, "overlay", isDocked && "dock-right")}
        onclick={() => !isDocked && close()}>
        {frame}
    </div> as HTMLElement

    const close = () => {
        overlay.classList.remove("visible")
        setTimeout(() => {
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
            props.onClose()
        }, 300)
    }

    // Animate In
    requestAnimationFrame(() => {
        // Double RAF to ensure browser paints initial state (opacity 0) before adding class
        requestAnimationFrame(() => {
            overlay.classList.add("visible")
        })
    })

    return overlay
}
