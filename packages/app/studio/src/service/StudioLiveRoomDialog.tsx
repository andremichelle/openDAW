import css from "./StudioLiveRoomDialog.sass?inline"
import {Errors} from "@opendaw/lib-std"
import {Html} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {IconSymbol} from "@opendaw/studio-enums"
import {Dialog} from "@/ui/components/Dialog"
import {Surface} from "@/ui/surface/Surface"

const className = Html.adoptStyleSheet(css, "StudioLiveRoomDialog")

export const showConnectRoomDialog = (): Promise<string> => {
    const {resolve, reject, promise} = Promise.withResolvers<string>()
    const inputField: HTMLInputElement = (
        <input className="default input" type="text" placeholder="Enter a room name"/>
    )
    const approve = () => {
        const value = inputField.value.trim()
        if (value.length === 0) {return}
        resolve(value)
    }
    const dialog: HTMLDialogElement = (
        <Dialog headline="Join Live Room"
                icon={IconSymbol.Connected}
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
                <p>Rooms are transient and will disappear shortly after the last user leaves.
                    Do not forget to save your project before leaving.</p>
                <p>Share the room name with other users so they can join.
                    No assets are stored on the server.
                    They are exchanged directly between users via a P2P network
                    and stored locally in each user's browser (OPFS).</p>
                {inputField}
            </div>
        </Dialog>
    )
    dialog.oncancel = () => reject(Errors.AbortError)
    dialog.onkeydown = event => {
        if (event.code === "Enter") {
            approve()
            dialog.close()
        }
    }
    Surface.get().flyout.appendChild(dialog)
    dialog.showModal()
    inputField.focus()
    return promise
}
