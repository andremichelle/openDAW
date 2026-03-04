import {createElement} from "@opendaw/lib-jsx"
import {PresenceData} from "@opendaw/studio-core"

type CursorOverlayProps = {
    readonly participants: ReadonlyArray<PresenceData>
}

export const CursorOverlay = ({participants}: CursorOverlayProps) => {
    return (
        <div className="cursor-overlay" style={{
            position: "absolute",
            inset: "0",
            pointerEvents: "none",
            zIndex: "1000"
        }}>
            {participants.map(participant => (
                <div
                    key={participant.identity}
                    className="remote-cursor"
                    style={{
                        position: "absolute",
                        left: `${participant.cursorX}px`,
                        top: `${participant.cursorY}px`,
                        transition: "left 0.1s, top 0.1s",
                    }}
                >
                    <svg width="16" height="20" viewBox="0 0 16 20" fill={participant.color}>
                        <path d="M0 0 L0 16 L4 12 L8 20 L10 19 L6 11 L12 11 Z"/>
                    </svg>
                    <span
                        className="cursor-label"
                        style={{
                            background: participant.color,
                            color: "white",
                            fontSize: "11px",
                            padding: "1px 4px",
                            borderRadius: "3px",
                            whiteSpace: "nowrap",
                            position: "absolute",
                            left: "14px",
                            top: "12px",
                        }}
                    >
                        {participant.displayName}
                    </span>
                </div>
            ))}
        </div>
    )
}
