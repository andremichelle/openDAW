import { createElement } from "@opendaw/lib-jsx"
import { OdieModalFrame } from "./components/OdieModalFrame"

interface OdieConfirmModalProps {
    title: string
    message: string
    confirmLabel?: string
    cancelLabel?: string
    onConfirm: () => void
    onCancel: () => void
}

export const OdieConfirmModal = (props: OdieConfirmModalProps) => {
    let overlay: HTMLElement

    const close = () => {
        if (overlay) overlay.remove()
        props.onCancel()
    }

    const confirm = () => {
        if (overlay) overlay.remove()
        props.onConfirm()
    }

    const content = <div style={{
        display: "flex", flexDirection: "column", gap: "24px", padding: "16px"
    }}>
        <div style={{
            color: "#e2e8f0", fontSize: "15px", lineHeight: "1.5",
            textAlign: "center"
        }}>
            {props.message}
        </div>
        <div style={{
            display: "flex", gap: "12px", justifyContent: "center"
        }}>
            <button onclick={close} style={{
                padding: "10px 20px", borderRadius: "8px", border: "1px solid rgba(255,255,255,0.1)",
                background: "transparent", color: "#94a3b8", cursor: "pointer",
                fontFamily: "Inter, sans-serif", fontSize: "14px", fontWeight: "600",
                transition: "all 0.2s"
            }}
                onmouseenter={(e: any) => e.target.style.background = "rgba(255,255,255,0.05)"}
                onmouseleave={(e: any) => e.target.style.background = "transparent"}
            >
                {props.cancelLabel || "Cancel"}
            </button>
            <button onclick={confirm} style={{
                padding: "10px 20px", borderRadius: "8px", border: "none",
                background: "linear-gradient(135deg, #22c55e 0%, #16a34a 100%)",
                color: "white", cursor: "pointer",
                fontFamily: "Inter, sans-serif", fontSize: "14px", fontWeight: "600",
                boxShadow: "0 0 15px rgba(34, 197, 94, 0.3)",
                transition: "all 0.2s"
            }}
                onmouseenter={(e: any) => {
                    e.target.style.transform = "scale(1.02)"
                    e.target.style.boxShadow = "0 0 20px rgba(34, 197, 94, 0.5)"
                }}
                onmouseleave={(e: any) => {
                    e.target.style.transform = "scale(1)"
                    e.target.style.boxShadow = "0 0 15px rgba(34, 197, 94, 0.3)"
                }}
            >
                {props.confirmLabel || "Confirm"}
            </button>
        </div>
    </div>

    overlay = OdieModalFrame({
        title: props.title,
        icon: "⚠️",
        width: "400px",
        onClose: close,
        children: content
    })

    return overlay
}
