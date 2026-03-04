import {useCallback, useState} from "react"

type ShareDialogProps = {
    readonly shareUrl: string
    readonly onClose: () => void
    readonly onPromoteRoom: () => void
    readonly isPersistent: boolean
}

export const ShareDialog = ({shareUrl, onClose, onPromoteRoom, isPersistent}: ShareDialogProps) => {
    const [copied, setCopied] = useState(false)
    const handleCopy = useCallback(async () => {
        await navigator.clipboard.writeText(shareUrl)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
    }, [shareUrl])
    return (
        <div className="share-dialog">
            <h3>Share this session</h3>
            <div className="share-url-row">
                <input type="text" value={shareUrl} readOnly />
                <button onClick={handleCopy}>{copied ? "Copied!" : "Copy Link"}</button>
            </div>
            <p className="share-hint">
                Anyone with this link can join and collaborate in real-time.
            </p>
            {!isPersistent && (
                <div className="share-persist">
                    <p>This session is temporary and will expire after everyone leaves.</p>
                    <button onClick={onPromoteRoom}>Make Persistent</button>
                </div>
            )}
            <button className="share-close" onClick={onClose}>Close</button>
        </div>
    )
}
