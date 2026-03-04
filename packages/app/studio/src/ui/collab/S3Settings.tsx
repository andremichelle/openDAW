import {useCallback, useState} from "react"

const STORAGE_KEY = "opendaw-s3-config"

type S3ConfigState = {
    bucket: string
    region: string
    accessKeyId: string
    secretAccessKey: string
    endpoint: string
}

const loadConfig = (): S3ConfigState => {
    try {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (raw === null) {return {bucket: "", region: "", accessKeyId: "", secretAccessKey: "", endpoint: ""}}
        return JSON.parse(raw)
    } catch {
        return {bucket: "", region: "", accessKeyId: "", secretAccessKey: "", endpoint: ""}
    }
}

export const S3Settings = () => {
    const [config, setConfig] = useState<S3ConfigState>(loadConfig)
    const [saved, setSaved] = useState(false)
    const handleSave = useCallback(() => {
        if (config.bucket.length === 0 || config.region.length === 0
            || config.accessKeyId.length === 0 || config.secretAccessKey.length === 0) {return}
        localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
    }, [config])
    const handleClear = useCallback(() => {
        localStorage.removeItem(STORAGE_KEY)
        setConfig({bucket: "", region: "", accessKeyId: "", secretAccessKey: "", endpoint: ""})
    }, [])
    const update = (field: keyof S3ConfigState, value: string) => {
        setConfig(prev => ({...prev, [field]: value}))
    }
    return (
        <div className="s3-settings">
            <h3>S3 Storage (Optional)</h3>
            <p>Configure your own S3-compatible storage for persistent asset hosting.</p>
            <label>Bucket<input type="text" value={config.bucket} onChange={event => update("bucket", event.target.value)} /></label>
            <label>Region<input type="text" value={config.region} onChange={event => update("region", event.target.value)} /></label>
            <label>Access Key ID<input type="text" value={config.accessKeyId} onChange={event => update("accessKeyId", event.target.value)} /></label>
            <label>Secret Access Key<input type="password" value={config.secretAccessKey} onChange={event => update("secretAccessKey", event.target.value)} /></label>
            <label>Custom Endpoint (optional)<input type="text" value={config.endpoint} onChange={event => update("endpoint", event.target.value)} placeholder="https://minio.local:9000" /></label>
            <div className="s3-actions">
                <button onClick={handleSave}>{saved ? "Saved!" : "Save"}</button>
                <button onClick={handleClear}>Clear</button>
            </div>
        </div>
    )
}
