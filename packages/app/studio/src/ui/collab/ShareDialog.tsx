import {createElement} from "@opendaw/lib-jsx"

type ShareDialogProps = {
    readonly shareUrl: string
    readonly onClose: () => void
    readonly onPromoteRoom: () => void
    readonly isPersistent: boolean
}

export const ShareDialog = ({shareUrl, onClose, onPromoteRoom, isPersistent}: ShareDialogProps) => {
    const copyButton: HTMLButtonElement = <button>Copy Link</button>
    copyButton.addEventListener("click", async () => {
        await navigator.clipboard.writeText(shareUrl)
        copyButton.textContent = "Copied!"
        setTimeout(() => copyButton.textContent = "Copy Link", 2000)
    })
    return (
        <div className="share-dialog">
            <h3>Share this session</h3>
            <div className="share-url-row">
                <input type="text" value={shareUrl} readonly={true}/>
                {copyButton}
            </div>
            <p className="share-hint">
                Anyone with this link can join and collaborate in real-time.
            </p>
            {!isPersistent && (
                <div className="share-persist">
                    <p>This session is temporary and will expire after everyone leaves.</p>
                    <button onclick={onPromoteRoom}>Make Persistent</button>
                </div>
            )}
            <button className="share-close" onclick={onClose}>Close</button>
        </div>
    )
}
