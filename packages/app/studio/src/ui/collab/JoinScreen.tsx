import {useCallback, useState} from "react"

type JoinScreenProps = {
    readonly roomId: string
    readonly onJoin: (displayName: string) => void
    readonly onCancel: () => void
    readonly isConnecting: boolean
}

export const JoinScreen = ({roomId, onJoin, onCancel, isConnecting}: JoinScreenProps) => {
    const savedName = localStorage.getItem("opendaw-display-name") ?? ""
    const [displayName, setDisplayName] = useState(savedName)
    const handleJoin = useCallback(() => {
        const name = displayName.trim()
        if (name.length === 0) {return}
        localStorage.setItem("opendaw-display-name", name)
        onJoin(name)
    }, [displayName, onJoin])
    return (
        <div className="join-screen">
            <h2>Join Session</h2>
            <p>Room: <code>{roomId}</code></p>
            <label>
                Your name
                <input
                    type="text"
                    value={displayName}
                    onChange={event => setDisplayName(event.target.value)}
                    placeholder="Enter your name"
                    maxLength={32}
                    autoFocus
                    onKeyDown={event => event.key === "Enter" && handleJoin()}
                />
            </label>
            <div className="join-actions">
                <button onClick={handleJoin} disabled={isConnecting || displayName.trim().length === 0}>
                    {isConnecting ? "Connecting..." : "Join"}
                </button>
                <button onClick={onCancel}>Cancel</button>
            </div>
        </div>
    )
}
