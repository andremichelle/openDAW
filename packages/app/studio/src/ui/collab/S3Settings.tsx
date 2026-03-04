import {createElement} from "@opendaw/lib-jsx"

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
        return JSON.parse(raw) as S3ConfigState
    } catch {
        return {bucket: "", region: "", accessKeyId: "", secretAccessKey: "", endpoint: ""}
    }
}

export const S3Settings = () => {
    const config = loadConfig()
    const bucketInput: HTMLInputElement = <input type="text" value={config.bucket}/>
    const regionInput: HTMLInputElement = <input type="text" value={config.region}/>
    const accessKeyInput: HTMLInputElement = <input type="text" value={config.accessKeyId}/>
    const secretKeyInput: HTMLInputElement = <input type="password" value={config.secretAccessKey}/>
    const endpointInput: HTMLInputElement = <input type="text" value={config.endpoint} placeholder="https://minio.local:9000"/>
    const statusLabel: HTMLSpanElement = <span/>
    const handleSave = () => {
        if (bucketInput.value.length === 0 || regionInput.value.length === 0
            || accessKeyInput.value.length === 0 || secretKeyInput.value.length === 0) {
            statusLabel.textContent = "All fields except endpoint are required."
            setTimeout(() => statusLabel.textContent = "", 3000)
            return
        }
        const data: S3ConfigState = {
            bucket: bucketInput.value,
            region: regionInput.value,
            accessKeyId: accessKeyInput.value,
            secretAccessKey: secretKeyInput.value,
            endpoint: endpointInput.value,
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
        statusLabel.textContent = "Saved!"
        setTimeout(() => statusLabel.textContent = "", 2000)
    }
    const handleClear = () => {
        localStorage.removeItem(STORAGE_KEY)
        bucketInput.value = ""
        regionInput.value = ""
        accessKeyInput.value = ""
        secretKeyInput.value = ""
        endpointInput.value = ""
    }
    return (
        <div className="s3-settings">
            <h3>S3 Storage (Optional)</h3>
            <p>Configure your own S3-compatible storage for persistent asset hosting.</p>
            <label>Bucket{bucketInput}</label>
            <label>Region{regionInput}</label>
            <label>Access Key ID{accessKeyInput}</label>
            <label>Secret Access Key{secretKeyInput}</label>
            <label>Custom Endpoint (optional){endpointInput}</label>
            <div className="s3-actions">
                <button onclick={handleSave}>Save</button>
                <button onclick={handleClear}>Clear</button>
                {statusLabel}
            </div>
        </div>
    )
}
