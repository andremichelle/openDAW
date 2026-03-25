import css from "./StudioLiveRoomDialog.sass?inline"
import {Errors} from "@opendaw/lib-std"
import {Html} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {IconSymbol} from "@opendaw/studio-enums"
import {Dialog} from "@/ui/components/Dialog"
import {Surface} from "@/ui/surface/Surface"
import {readIdentity, userColors} from "@/service/RoomAwareness"

const className = Html.adoptStyleSheet(css, "StudioLiveRoomDialog")

export type RoomDialogResult = { roomName: string, userName: string, userColor: string }

export const showConnectRoomDialog = (): Promise<RoomDialogResult> => {
    const {resolve, reject, promise} = Promise.withResolvers<RoomDialogResult>()
    const identity = readIdentity()
    const roomInput: HTMLInputElement = (
        <input className="default input" type="text" placeholder="Required" maxLength={16} required={true}/>
    )
    const nameInput: HTMLInputElement = (
        <input className="default input" type="text" placeholder="Required" value={identity.name} maxLength={16} required={true}/>
    )
    let selectedColor = identity.color
    const colorSwatches: HTMLElement = (
        <div className="color-swatches">
            {userColors().map(color => {
                const swatch: HTMLElement = (
                    <span className={color === selectedColor ? "swatch selected" : "swatch"}
                          style={{backgroundColor: color}}
                          onclick={() => {
                              selectedColor = color
                              colorSwatches.querySelectorAll(".swatch").forEach(element =>
                                  element.classList.toggle("selected", (element as HTMLElement).style.backgroundColor === swatch.style.backgroundColor))
                          }}/>
                )
                return swatch
            })}
        </div>
    )
    const approve = () => {
        const roomName = roomInput.value.trim()
        const userName = nameInput.value.trim()
        if (roomName.length === 0 || userName.length === 0) {return}
        resolve({roomName, userName, userColor: selectedColor})
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
                <label>Room Name</label>
                {roomInput}
                <label>Your Name</label>
                {nameInput}
                <label>Your Color</label>
                {colorSwatches}
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
    roomInput.focus()
    return promise
}
