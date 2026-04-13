import css from "./StudioLiveRoomDialog.sass?inline"
import {Errors, isDefined, Optional, RuntimeNotifier} from "@moises-ai/lib-std"
import {Promises} from "@moises-ai/lib-runtime"
import {Clipboard, Html} from "@moises-ai/lib-dom"
import {createElement} from "@moises-ai/lib-jsx"
import {Colors, IconSymbol} from "@moises-ai/studio-enums"
import {Dialog} from "@/ui/components/Dialog"
import {Surface} from "@/ui/surface/Surface"
import {readIdentity, userColors} from "@/service/RoomAwareness"

const className = Html.adoptStyleSheet(css, "StudioLiveRoomDialog")

const randomRoomName = (length: number = 11): string => {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
    const values = crypto.getRandomValues(new Uint8Array(length))
    return Array.from(values, byte => chars[byte % chars.length]).join("")
}

const randomUserName = (): string => {
    const adjectives = [
        "Analog", "Electric", "Acoustic", "Harmonic", "Sonic",
        "Melodic", "Ambient", "Tonal", "Stereo", "Resonant",
        "Phantom", "Cosmic", "Modular", "Spectral", "Orbital",
        "Neon", "Lucid", "Astral", "Magnetic", "Chromatic"
    ]
    const nouns = [
        "Maestro", "Voyager", "Pioneer", "Prophet", "Nomad",
        "Atom", "Aurora", "Echo", "Nova", "Prism",
        "Opus", "Rebel", "Ghost", "Oracle", "Nexus",
        "Drifter", "Vertex", "Sphinx", "Cipher", "Pilot"
    ]
    const [a, b] = crypto.getRandomValues(new Uint8Array(2))
    return `${adjectives[a % adjectives.length]} ${nouns[b % nouns.length]}`
}

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
               pattern="[a-z0-9\.\-_]+"
               title="Only lowercase letters, numbers, hyphens, dots, and underscores"
               value={hasRoomName ? prefillRoomName : randomRoomName()} disabled={hasRoomName}/>
    )
    const nameInput: HTMLInputElement = (
        <input className="default input" type="text" placeholder="Required"
               value={identity.name.length > 0 ? identity.name : randomUserName()} maxLength={16}
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
                              colorSwatches.querySelectorAll<HTMLElement>(".swatch").forEach(element =>
                                  element.classList.toggle("selected",
                                      element.style.backgroundColor === swatch.style.backgroundColor))
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
        roomInput.select()
    }
    return promise
}