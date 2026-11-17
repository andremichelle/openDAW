import css from "./AgentConnectDialog.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {IconSymbol} from "@opendaw/studio-enums"
import {Dialog} from "@/ui/components/Dialog"
import {Surface} from "@/ui/surface/Surface"
import {AgentConnection} from "@/script/AgentConnection"

const className = Html.adoptStyleSheet(css, "AgentConnectDialog")

export namespace AgentConnectDialog {
    export const show = (connection: AgentConnection): void => {
        const urlInput: HTMLInputElement = (
            <input className="default input" type="text" value={connection.url} required={true}/>
        )
        const approve = () => {
            const url = urlInput.value.trim()
            if (url.length > 0) {connection.connect(url)}
        }
        const dialog: HTMLDialogElement = (
            <Dialog headline="Connect Agent"
                    icon={IconSymbol.Robot}
                    cancelable={true}
                    buttons={[
                        {text: "Cancel", onClick: handler => handler.close()},
                        {
                            text: "Connect",
                            primary: true,
                            onClick: handler => {
                                approve()
                                handler.close()
                            }
                        }
                    ]}>
                <div className={className}>
                    <p>An AI agent writes and runs scripts in this studio through a local relay.</p>
                    <div className="group">
                        <label>Relay URL</label>
                        {urlInput}
                    </div>
                </div>
            </Dialog>
        )
        dialog.onkeydown = event => {
            if (event.code === "Enter") {
                approve()
                dialog.close()
            }
        }
        Surface.get().flyout.appendChild(dialog)
        dialog.showModal()
        urlInput.focus()
        urlInput.select()
    }
}
