import css from "./StudioLiveRoomDialog.sass?inline"
import {Errors, isDefined, Optional, RuntimeNotifier} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {Clipboard, Html} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {Dialog} from "@/ui/components/Dialog"
import {Surface} from "@/ui/surface/Surface"
import {readIdentity, userColors} from "@/service/RoomAwareness"

const className = Html.adoptStyleSheet(css, "StudioLiveRoomDialog")

export type RoomDialogResult = { roomName: string, userName: string, userColor: string }

export const showConnectRoomDialog = (prefillRoomName?: Optional<string>): Promise<RoomDialogResult> => {
    const {resolve, reject, promise} = Promise.withResolvers<RoomDialogResult>()
    const identity = readIdentity()
    const hasRoomName = isDefined(prefillRoomName) && prefillRoomName.length > 0
    const urlPreview: HTMLElement = (
        <span className="url-preview"
              onclick={async () => {
                  const text = urlPreview.textContent
                  if (text.length > 0
                      && roomInput.value.trim().length > 0 && roomInput.checkValidity()
                      && nameInput.value.trim().length > 0) {
                      const {status} = await Promises.tryCatch(Clipboard.writeText(text))
                      if (status === "resolved") {
                          await RuntimeNotifier.info({headline: "Clipboard", message: "Join link copied to clipboard."})
                      } else {
                          await RuntimeNotifier.info({headline: "Clipboard", message: "Could not copy to clipboard."})
                      }
                  }
              }}/>
    )
    const updateUrlPreview = () => {
        urlPreview.textContent = `${location.origin}/join/${roomInput.value}`
        const copyable = roomInput.value.trim().length > 0 && roomInput.checkValidity()
        urlPreview.classList.toggle("copyable", copyable)
    }
    const roomInput: HTMLInputElement = (
        <input className="default input" type="text" placeholder="Required" maxLength={16} required={true}
               pattern="[a-z0-9._-]+"
               title="Only lowercase letters, numbers, hyphens, dots, and underscores"
               value={hasRoomName ? prefillRoomName : ""} disabled={hasRoomName}/>
    )
    const nameInput: HTMLInputElement = (
        <input className="default input" type="text" placeholder="Required" value={identity.name} maxLength={16}
               required={true}/>
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
        if (roomName.length === 0 || userName.length === 0 || !roomInput.checkValidity()) {return}
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
                <p>
                    Live rooms let you collaborate with others in real time.
                    Share the room name and anyone can join your session.
                </p>
                <p>
                    All data is exchanged directly between participants,
                    nothing is stored on the server.
                    Assets are kept locally in each user's browser.
                </p>
                <div className="group">
                    <label>Room Name</label>
                    {roomInput}
                    {urlPreview}
                </div>
                <div className="group">
                    <label>Your Name</label>
                    {nameInput}
                </div>
                <div className="group">
                    <label>Your Color</label>
                    {colorSwatches}
                </div>
                <p style={{color: Colors.orange.toString()}}>
                    Rooms disappear shortly after the last user leaves.
                    Make sure to save your project before leaving!
                </p>
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
    updateUrlPreview()
    if (hasRoomName) {
        nameInput.focus()
    } else {
        roomInput.addEventListener("input", () => {
            roomInput.value = roomInput.value.toLowerCase()
            updateUrlPreview()
        })
        roomInput.focus()
    }
    return promise
}
