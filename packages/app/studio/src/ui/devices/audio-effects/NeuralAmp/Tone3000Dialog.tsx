import css from "./Tone3000Dialog.sass?inline"
import {createElement} from "@moises-ai/lib-jsx"
import {Html} from "@moises-ai/lib-dom"
import {Dialogs} from "@/ui/components/dialogs"

const className = Html.adoptStyleSheet(css, "Tone3000Dialog")

export const showTone3000Dialog = (): Promise<void> => {
    return Dialogs.show({
        headline: "Tone 3000",
        okText: "Open Tone 3000",
        cancelable: true,
        growWidth: true,
        buttons: [{text: "Cancel", onClick: handler => handler.close()}],
        content: (
            <div className={className}>
                <p>
                    openDAW partners with <strong>Tone 3000</strong> for NAM models.
                </p>
                <p>
                    <strong>Tone 3000</strong> is an online platform for sharing and downloading
                    NAM captures.<br/>
                    Browse thousands of amp, pedal, and full-rig tones from the community.
                </p>
                <div>
                    <strong>How it works:</strong>
                    <ol>
                        <li>Sign in with your email (one-time passcode, no password needed)</li>
                        <li>Browse or search for a tone</li>
                        <li>Click the <strong>Download</strong> button to send it back to your device</li>
                    </ol>
                </div>
                <p className="hint">
                    Make sure popups are enabled for this site.
                </p>
            </div>
        )
    })
}
