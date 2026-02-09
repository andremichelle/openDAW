import css from "./OdieModal.sass?inline"
import { createElement } from "@opendaw/lib-jsx"
import { Html } from "@opendaw/lib-dom"
import { Terminator } from "@opendaw/lib-std"

const className = Html.adoptStyleSheet(css, "OdieModal")

export interface OdieModalProps {
    title: string
    icon?: string
    onClose: () => void
    children?: any
    width?: string
    height?: string
    modalPosition?: "center" | "right"
    headerContent?: any
}

export const OdieModalFrame = (props: OdieModalProps) => {

    // Dynamic Sizing
    // We can still use inline style for specific Dimensions if they vary per instance,
    // but the structural styles go to SASS.


    const frameStyle: any = {
        width: props.width || "600px",
        height: props.height || "auto",
        maxWidth: "90vw",
        maxHeight: "90vh"
    }

    const lifecycle = new Terminator()
    let renderLifecycle = new Terminator()
    // lifecycle.own(renderLifecycle) -- CAUSES LEAK

    // Helper: Close logic
    let isClosing = false
    let overlay: HTMLElement

    const close = () => {
        if (isClosing) return
        isClosing = true
        if (overlay) overlay.classList.remove("visible")
        setTimeout(() => {
            if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay)
            renderLifecycle.terminate() // Manually terminate render-specific resources
            lifecycle.terminate() // Manually terminate modal-specific resources
            props.onClose()
        }, 300)
    }

    overlay = (
        <div className={className} onmousedown={(e) => {
            if (e.target === overlay) close()
        }}>
            <div className={`modal-container ${props.modalPosition || "center"}`} style={frameStyle}>
                <div className="modal-header">
                    <div className="header-left">
                        {props.icon && <span className="icon">{props.icon}</span>}
                        <h3>{props.title}</h3>
                    </div>
                    <div className="header-right">
                        {props.headerContent}
                        <button className="close-button" onclick={close} aria-label="Close modal">×</button>
                    </div>
                </div>
                <div className="modal-content">
                    {props.children}
                </div>
            </div>
        </div>
    ) as HTMLElement

    // Animate in
    document.body.appendChild(overlay)
    setTimeout(() => overlay.classList.add("visible"), 10)

    return overlay
}
