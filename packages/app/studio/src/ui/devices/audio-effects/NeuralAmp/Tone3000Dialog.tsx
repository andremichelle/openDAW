import css from "./Tone3000Dialog.sass?inline"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {Dialogs} from "@/ui/components/dialogs"

const className = Html.adoptStyleSheet(css, "Tone3000Dialog")

export const showTone3000Dialog = (): Promise<void> => {
    return Dialogs.show({
        headline: "TONE3000",
        okText: "Continue",
        cancelable: true,
        growWidth: true,
        buttons: [{text: "Cancel", onClick: handler => handler.close()}],
        content: (
            <div className={className}>
                <p>
                    openDAW has partnered with <strong>TONE3000</strong> to give you access to a massive library
                    of Neural Amp Modeler (NAM) captures of real analog gear, created by a global community of
                    musicians.
                </p>
                <div>
                    <strong>How it works:</strong>
                    <ol>
                        <li>Sign in with your email (one-time passcode, no password needed)</li>
                        <li>Browse or search for a tone, and audition it with the preview player</li>
                        <li>Select the tone to send it back to your device</li>
                    </ol>
                </div>
                <p className="hint">
                    Make sure popups are enabled for this site.
                </p>
            </div>
        )
    })
}
