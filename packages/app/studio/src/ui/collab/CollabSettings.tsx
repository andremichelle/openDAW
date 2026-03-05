import css from "./CollabSettings.sass?inline"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"

const className = Html.adoptStyleSheet(css, "CollabSettings")

const ENDPOINT_KEY = "opendaw-stdb-endpoint"
const DEFAULT_ENDPOINT = import.meta.env.VITE_STDB_ENDPOINT ?? "wss://maincloud.spacetimedb.com"

const isValidWsEndpoint = (value: string): boolean => {
    try {
        const url = new URL(value)
        return url.protocol === "ws:" || url.protocol === "wss:"
    } catch {
        return false
    }
}

export const CollabSettings = () => {
    let statusTimeout: number | undefined
    const input: HTMLInputElement = <input
        type="text"
        value={localStorage.getItem(ENDPOINT_KEY) ?? DEFAULT_ENDPOINT}
        placeholder={DEFAULT_ENDPOINT}
    />
    const statusLabel: HTMLSpanElement = <span/>
    const showStatus = (text: string) => {
        statusLabel.textContent = text
        if (statusTimeout !== undefined) {window.clearTimeout(statusTimeout)}
        statusTimeout = window.setTimeout(() => {
            statusLabel.textContent = ""
            statusTimeout = undefined
        }, 2000)
    }
    const handleSave = () => {
        const endpoint = input.value.trim()
        if (endpoint.length === 0) {
            localStorage.removeItem(ENDPOINT_KEY)
            input.value = DEFAULT_ENDPOINT
            showStatus("Reset to default")
            return
        }
        if (!isValidWsEndpoint(endpoint)) {
            showStatus("Invalid endpoint (must be ws: or wss:)")
            return
        }
        localStorage.setItem(ENDPOINT_KEY, endpoint)
        showStatus("Saved!")
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
