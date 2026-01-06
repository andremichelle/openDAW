import { createElement } from "@opendaw/lib-jsx"

export interface OdieModalProps {
    title: string
    icon?: string
    onClose: () => void
    children?: any
    width?: string
    height?: string
    position?: "center" | "right"
    headerContent?: any // New prop for custom header controls
}

// --- MORRIS DESIGN SYSTEM ---
const DS = {
    overlay: {
        position: "fixed", top: "0", left: "0", width: "100vw", height: "100vh",
        background: "rgba(0, 0, 0, 0.6)",
        backdropFilter: "blur(8px)",
        zIndex: "9999",
        display: "flex", justifyContent: "center", alignItems: "center",
        opacity: "0", transition: "opacity 0.3s ease-out" // Animation Hook
    },
    frame: {
        position: "relative",
        background: "rgba(20, 20, 25, 0.95)",
        border: "1px solid rgba(255, 255, 255, 0.08)",
        borderRadius: "24px",
        boxShadow: "0 40px 80px -20px rgba(0, 0, 0, 0.8)",
        display: "flex", flexDirection: "column",
        overflow: "hidden",
        transform: "scale(0.95) translateY(20px)", transition: "all 0.3s cubic-bezier(0.16, 1, 0.3, 1)" // Apple-like spring
    },
    header: {
        height: "72px",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "0 32px",
        borderBottom: "1px solid rgba(255, 255, 255, 0.04)",
        background: "linear-gradient(180deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0) 100%)"
    },
    titleGroup: { display: "flex", alignItems: "center", gap: "16px" },
    iconBox: {
        width: "32px", height: "32px", borderRadius: "10px",
        background: "rgba(255, 255, 255, 0.1)",
        display: "flex", justifyContent: "center", alignItems: "center", fontSize: "18px"
    },
    titleText: {
        fontSize: "20px", fontWeight: "700", letterSpacing: "0.5px", color: "white",
        fontFamily: "'Inter', sans-serif"
    },
    closeBtn: {
        background: "transparent", border: "none", color: "rgba(255,255,255,0.4)",
        fontSize: "24px", cursor: "pointer", transition: "color 0.2s"
    },
    content: {
        flex: "1",
        overflowY: "auto",
        padding: "0" // Let children decide padding
    }
}

export const OdieModalFrame = (props: OdieModalProps) => {

    const content = <div style={DS.content}>
        {props.children}
    </div> as HTMLElement

    const header = <div style={DS.header}>
        <div style={DS.titleGroup}>
            {props.icon && <div className="odie-modal-icon" style={DS.iconBox}>{props.icon}</div>}
            <div className="odie-modal-title" style={DS.titleText}>{props.title}</div>
        </div>

        {/* Custom Header Content (Nav/Search) */}
        {props.headerContent && <div style={{ flex: "1", display: "flex", justifyContent: "center" }}>
            {props.headerContent}
        </div>}

        <button style={DS.closeBtn}
            onmouseover={(e: any) => e.target.style.color = "white"}
            onmouseout={(e: any) => e.target.style.color = "rgba(255,255,255,0.4)"}
            onclick={() => close()}
        >✕</button>
    </div>

    // Dynamic Styles based on docking
    const isDocked = props.position === "right";

    // OVERLAY: If docked, we don't want a backdrop blocking the rest of the screen? 
    // Actually for "Sidebar Mode" we usually want to interact with the DAW.
    // So the overlay should be *pointer-events: none* for the background, but active for the modal?
    // Or we just position the modal to the right.

    const overlayStyle = {
        ...DS.overlay,
        justifyContent: isDocked ? "flex-end" : "center", // Push to right
        background: isDocked ? "transparent" : DS.overlay.background, // Invisible overlay if docked
        pointerEvents: isDocked ? "none" : "auto" // Let clicks pass through to DAW on the left
    }

    const frameStyle = {
        ...DS.frame,
        width: props.width || "900px",
        height: isDocked ? "100vh" : (props.height || "80vh"), // Use prop or default
        borderRadius: isDocked ? "0" : "24px",
        borderRight: "none",
        borderTop: "none",
        borderBottom: "none",
        transform: isDocked ? "translateX(100%)" : "scale(0.95) translateY(20px)",
        pointerEvents: "auto"
    }

    const frame = <div className="odie-modal-frame" style={frameStyle} onclick={(e: Event) => e.stopPropagation()}>
        {header}
        {content}
    </div> as HTMLElement

    // Add class for title updates
    if (props.title) {
        // We need to inject the class into the header construction
        // Re-defining header to be safer
    }

    const overlay = <div style={overlayStyle} onclick={() => !isDocked && close()}>
        {frame}
    </div> as HTMLElement

    const close = () => {
        // Animate Out
        overlay.style.opacity = "0"
        frame.style.transform = isDocked ? "translateX(100%)" : "scale(0.95) translateY(20px)"
        setTimeout(() => {
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
            props.onClose()
        }, 300)
    }

    // Animate In
    requestAnimationFrame(() => {
        overlay.style.opacity = "1"
        frame.style.transform = isDocked ? "translateX(0)" : "scale(1) translateY(0)"
    })

    return overlay
}
