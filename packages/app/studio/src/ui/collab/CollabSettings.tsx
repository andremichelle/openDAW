import {useCallback, useState} from "react"

const ENDPOINT_KEY = "opendaw-stdb-endpoint"
const DEFAULT_ENDPOINT = "wss://live.opendaw.studio"

export const CollabSettings = () => {
    const [endpoint, setEndpoint] = useState(
        localStorage.getItem(ENDPOINT_KEY) ?? DEFAULT_ENDPOINT
    )
    const [saved, setSaved] = useState(false)
    const handleSave = useCallback(() => {
        localStorage.setItem(ENDPOINT_KEY, endpoint)
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
    }, [endpoint])
    const handleReset = useCallback(() => {
        localStorage.removeItem(ENDPOINT_KEY)
        setEndpoint(DEFAULT_ENDPOINT)
    }, [])
    return (
        <div className="collab-settings">
            <h3>Collaboration Server</h3>
            <label>
                SpacetimeDB Endpoint
                <input
                    type="text"
                    value={endpoint}
                    onChange={event => setEndpoint(event.target.value)}
                    placeholder={DEFAULT_ENDPOINT}
                />
            </label>
            <div className="collab-settings-actions">
                <button onClick={handleSave}>{saved ? "Saved!" : "Save"}</button>
                <button onClick={handleReset}>Reset to Default</button>
            </div>
        </div>
    )
}
