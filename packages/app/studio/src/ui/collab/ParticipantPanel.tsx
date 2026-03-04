import {PresenceData} from "@opendaw/studio-core"

type ParticipantPanelProps = {
    readonly participants: ReadonlyArray<PresenceData>
    readonly localIdentity: string
    readonly isOpen: boolean
    readonly onToggle: () => void
}

export const ParticipantPanel = ({participants, localIdentity, isOpen, onToggle}: ParticipantPanelProps) => {
    const totalCount = participants.length + 1
    return (
        <div className="participant-panel">
            <button className="participant-toggle" onClick={onToggle}>
                <span className="participant-count">{totalCount}</span>
                <span>collaborators</span>
            </button>
            {isOpen && (
                <div className="participant-list">
                    <div className="participant-item local">
                        <span className="participant-dot" style={{background: "#4ECDC4"}} />
                        <span>You</span>
                    </div>
                    {participants.map(participant => (
                        <div key={participant.identity} className="participant-item">
                            <span className="participant-dot" style={{background: participant.color}} />
                            <span>{participant.displayName}</span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    )
}
