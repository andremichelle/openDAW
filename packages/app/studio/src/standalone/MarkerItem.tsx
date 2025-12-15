import {createElement} from "@opendaw/lib-jsx"
import {MarkerData} from "./types"

interface Props {
    marker: MarkerData;
    height: number;
    onDelete: () => void;
    onToggleAlign: () => void;
}

export const MarkerItem = ({ marker, height, onDelete, onToggleAlign }: Props) => {
    const color = marker.isLoading ? "#666" : (marker.isEndAligned ? "#dcb43c" : "#3cba3c");

    const element = (
        <div
            style={{
                position: "absolute",
                left: "0px",
                top: "0px",
                height: `${height}px`,
                width: "20px",
                cursor: "pointer",
                zIndex: "100"
            }}
            title={`${marker.text} (Shift+Click to Delete)`}
        >
            <div style={{width: "2px", height: "100%", background: color, margin: "0 auto"}}></div>
            <div style={{
                position: "absolute",
                top: "25px",
                left: "5px",
                background: color,
                color: "black",
                fontSize: "10px",
                padding: "2px 4px",
                borderRadius: "3px",
                whiteSpace: "nowrap"
            }}>
                {marker.text} {marker.isLoading ? "..." : ""}
            </div>
        </div>
    )

    element.oncontextmenu = (e: any) => {
        e.preventDefault();
        const action = confirm(`Marker: ${marker.text}\n\nOK to Toggle Alignment\nCancel to Delete`);
        if (action) onToggleAlign();
    }

    element.onclick = (e: any) => {
        if (e.shiftKey) {
            if(confirm("Delete marker?")) onDelete();
        } else {
            onToggleAlign();
        }
    }

    return element
}
