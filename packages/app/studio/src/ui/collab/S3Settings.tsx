import {createElement} from "@opendaw/lib-jsx"

type S3SettingsProps = {
    readonly onSave: (config: S3ConfigInput) => void
    readonly onClear: () => void
    readonly initialConfig?: S3ConfigInput
}

export type S3ConfigInput = {
    readonly bucket: string
    readonly region: string
    readonly accessKeyId: string
    readonly secretAccessKey: string
    readonly endpoint: string
}

export const S3Settings = ({onSave, onClear, initialConfig}: S3SettingsProps) => {
    const config = initialConfig ?? {bucket: "", region: "", accessKeyId: "", secretAccessKey: "", endpoint: ""}
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
        onSave({
            bucket: bucketInput.value,
            region: regionInput.value,
            accessKeyId: accessKeyInput.value,
            secretAccessKey: secretKeyInput.value,
            endpoint: endpointInput.value,
        })
        statusLabel.textContent = "Saved!"
        setTimeout(() => statusLabel.textContent = "", 2000)
    }
    const handleClear = () => {
        onClear()
        bucketInput.value = ""
        regionInput.value = ""
        accessKeyInput.value = ""
        secretKeyInput.value = ""
        endpointInput.value = ""
        statusLabel.textContent = "Cleared!"
        setTimeout(() => statusLabel.textContent = "", 2000)
    }
    return (
        <div className="s3-settings">
            <h3>S3 Storage (Optional)</h3>
            <p>Configure your own S3-compatible storage for persistent asset hosting. Credentials are stored securely in the database.</p>
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
