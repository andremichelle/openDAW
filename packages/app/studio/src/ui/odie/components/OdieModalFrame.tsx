import { createElement } from "@opendaw/lib-jsx"
import { Html } from "@opendaw/lib-dom"
import css from "./OdieDialog.sass?inline"

// [ANTIGRAVITY] Adopt Standard Studio Styles
const className = Html.adoptStyleSheet(css, "odie-dialog")

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
    const isDocked = props.position === "right"

    const content = <div className="content">
        {props.children}
    </div> as HTMLElement

    const header = <div className="header">
        <div className="title-group">
            {props.icon && <div className="icon-box">{props.icon}</div>}
            <div className="title-text">{props.title}</div>
        </div>

        {props.headerContent && <div style={{ flex: "1", display: "flex", justifyContent: "center" }}>
            {props.headerContent}
        </div>}

        <button className="close-btn"
            onclick={() => close()}
        >✕</button>
    </div>

    // Dynamic classes/styles for the frame
    const frameClass = Html.buildClassList(className, "component", isDocked && "docked")
    const frameStyle: any = {}

    // Legacy prop support (though standard CSS handles most now)
    if (props.width) frameStyle.width = props.width
    if (props.height && !isDocked) frameStyle.height = props.height

    const frame = <div className={frameClass} style={frameStyle} onclick={(e: Event) => e.stopPropagation()}>
        {header}
        {content}
    </div> as HTMLElement

    const overlayClass = Html.buildClassList(className, "overlay", isDocked && "docked")
    const overlay = <div className={overlayClass} onclick={() => !isDocked && close()}>
        {frame}
    </div> as HTMLElement

    const close = () => {
        // Animate Out
        overlay.style.opacity = "0"
        // Use CSS classes or simple transforms for exit? 
        // We replicate existing behavior for safety
        frame.style.transform = isDocked ? "translateX(100%)" : "translateY(10px) scale(0.98)"

        setTimeout(() => {
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
            props.onClose()
        }, 200)
    }

    // Animate In
    requestAnimationFrame(() => {
        overlay.style.opacity = "1"
        // The CSS animation 'slide-up' might conflict if we manually set transform here.
        // But OdieDialog.sass doesn't define the animation on .component automatically yet, 
        // or we rely on the transition defined in .overlay?
        // Let's stick to the simple manual transition for the Entrance to match Exit logic.
        // Actually, CSS transitions are cleaner.
        // Ideally we'd toggle a class "visible". 
        // But for now, let's just use the JS hook as before to ensure it works.
        // The SASS didn't define transition on .component, so let's add inline transition just for entrance
        frame.style.transition = "transform 0.2s cubic-bezier(0.16, 1, 0.3, 1)"
        frame.style.transform = isDocked ? "translateX(0)" : "translateY(0) scale(1)"
    })

    // Set initial state for animation
    frame.style.transform = isDocked ? "translateX(100%)" : "translateY(10px) scale(0.98)"

    return overlay
}
