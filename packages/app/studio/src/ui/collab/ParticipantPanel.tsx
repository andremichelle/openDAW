import css from "./ParticipantPanel.sass?inline"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {PresenceData} from "@opendaw/studio-core"

const className = Html.adoptStyleSheet(css, "ParticipantPanel")

type ParticipantPanelProps = {
    readonly participants: ReadonlyArray<PresenceData>
    readonly isOpen: boolean
    readonly onToggle: () => void
}

export const ParticipantPanel = ({participants, isOpen, onToggle}: ParticipantPanelProps) => {
    const totalCount = participants.length + 1
    return (
        <div className={className}>
            <button className="participant-toggle" onclick={onToggle}>
                <span className="participant-count">{totalCount}</span>
                <span>collaborators</span>
            </button>
            {isOpen && (
                <div className="participant-list">
                    <div className="participant-item local">
                        <span className="participant-dot"/>
                        <span>You</span>
                    </div>
                    {participants.map(participant => (
                        <div key={participant.identity} className="participant-item">
                            <span className="participant-dot" style={{background: participant.color}}/>
                            <span>{participant.displayName}</span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    )
}
