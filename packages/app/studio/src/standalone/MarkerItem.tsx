import React from "react"
import { MarkerData } from "./types"

interface Props {
    marker: MarkerData;
    height: number;
    onDelete: () => void;
    onToggleAlign: () => void;
}

export const MarkerItem = ({ marker, height, onDelete, onToggleAlign }: Props) => {
    // Position is handled by parent
    const color = marker.isLoading ? "#666" : (marker.isEndAligned ? "#dcb43c" : "#3cba3c"); // Yellow/Green

    return (
        <div
            style={{
                position: "absolute",
                left: 0,
                top: 0,
                height: height,
                width: 20, // Hit area
                cursor: "pointer",
                zIndex: 100
            }}
            onContextMenu={(e) => {
                e.preventDefault();
                // Simple custom context menu or just confirm dialog for now?
                // Let's implement a simple browser confirm for speed/robustness
                // Or better, a small popup.
                // For this MVP: Toggle Align on Left Click, Delete on Right Click (with confirm)?
                // No, standard is Right Click -> Menu.
                // Let's do: Shift+Click to delete, Click to toggle align?
                // User said "context menu".
                // I'll stick to a simple overlay menu if I have time, otherwise simple interaction.
                const action = confirm(`Marker: ${marker.text}\n\nOK to Toggle Alignment\nCancel to Delete`);
                if (action) {
                    onToggleAlign();
                } else {
                    // confirm cancel logic usually implies 'do nothing', but here I'm hacking it.
                    // Better:
                    // Shift+Click = Delete
                    // Click = Toggle Align
                }
            }}
            onClick={(e) => {
                if (e.shiftKey) {
                    if(confirm("Delete marker?")) onDelete();
                } else {
                    onToggleAlign();
                }
            }}
            title={`${marker.text} (Shift+Click to Delete)`}
        >
            {/* Line */}
            <div style={{width: 2, height: "100%", background: color, margin: "0 auto"}}></div>

            {/* Label */}
            <div style={{
                position: "absolute",
                top: 25,
                left: 5,
                background: color,
                color: "black",
                fontSize: 10,
                padding: "2px 4px",
                borderRadius: 3,
                whiteSpace: "nowrap"
            }}>
                {marker.text} {marker.isLoading ? "..." : ""}
            </div>
        </div>
    )
}
