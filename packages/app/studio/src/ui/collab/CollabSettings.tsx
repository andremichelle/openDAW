import css from "./CollabSettings.sass?inline"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"

const className = Html.adoptStyleSheet(css, "CollabSettings")

const ENDPOINT_KEY = "opendaw-stdb-endpoint"
const DEFAULT_ENDPOINT = "wss://maincloud.spacetimedb.com"

export const CollabSettings = () => {
    const input: HTMLInputElement = <input
        type="text"
        value={localStorage.getItem(ENDPOINT_KEY) ?? DEFAULT_ENDPOINT}
        placeholder={DEFAULT_ENDPOINT}
    />
    const statusLabel: HTMLSpanElement = <span/>
    const handleSave = () => {
        localStorage.setItem(ENDPOINT_KEY, input.value)
        statusLabel.textContent = "Saved!"
        setTimeout(() => statusLabel.textContent = "", 2000)
    }
    const handleReset = () => {
        localStorage.removeItem(ENDPOINT_KEY)
        input.value = DEFAULT_ENDPOINT
    }
    return (
        <div className={className}>
            <h3>Collaboration Server</h3>
            <label>SpacetimeDB Endpoint{input}</label>
            <div className="collab-settings-actions">
                <button onclick={handleSave}>Save</button>
                <button onclick={handleReset}>Reset to Default</button>
                {statusLabel}
            </div>
        </div>
    )
}
