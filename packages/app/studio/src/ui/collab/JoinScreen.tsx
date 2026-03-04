import css from "./JoinScreen.sass?inline"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"

const className = Html.adoptStyleSheet(css, "JoinScreen")

type JoinScreenProps = {
    readonly roomId: string
    readonly onJoin: (displayName: string) => void
    readonly onCancel: () => void
    readonly isConnecting: boolean
}

export const JoinScreen = ({roomId, onJoin, onCancel, isConnecting}: JoinScreenProps) => {
    const savedName = localStorage.getItem("opendaw-display-name") ?? ""
    const input: HTMLInputElement = <input
        type="text"
        value={savedName}
        placeholder="Enter your name"
        maxLength={32}
        autofocus={true}
    />
    let joinSubmitted = false
    const handleJoin = () => {
        if (joinSubmitted) {return}
        const name = input.value.trim()
        if (name.length === 0) {return}
        joinSubmitted = true
        localStorage.setItem("opendaw-display-name", name)
        joinButton.disabled = true
        joinButton.textContent = "Connecting..."
        input.disabled = true
        onJoin(name)
    }
    input.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key === "Enter") {handleJoin()}
    })
    const joinButton: HTMLButtonElement = <button
        onclick={handleJoin}
        disabled={isConnecting}
    >{isConnecting ? "Connecting..." : "Join"}</button>
    input.addEventListener("input", () => {
        joinButton.disabled = isConnecting || input.value.trim().length === 0
    })
    if (savedName.trim().length === 0) {joinButton.disabled = true}
    return (
        <div className={className}>
            <h2>Join Session</h2>
            <p>Room: <code>{roomId}</code></p>
            <label>Your name{input}</label>
            <div className="join-actions">
                {joinButton}
                <button onclick={onCancel}>Cancel</button>
            </div>
        </div>
    )
}
