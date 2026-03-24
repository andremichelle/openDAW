import css from "./StudioLiveRoom.sass?inline"
import {Errors, RuntimeNotifier, UUID} from "@opendaw/lib-std"
import {Html} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {Promises} from "@opendaw/lib-runtime"
import {IconSymbol} from "@opendaw/studio-enums"
import {SampleStorage, SoundfontStorage, Workers, YService} from "@opendaw/studio-core"
import {P2PSession, type SignalingSocket} from "@opendaw/studio-p2p"
import {Dialog} from "@/ui/components/Dialog"
import {Surface} from "@/ui/surface/Surface"
import {StudioService} from "@/service/StudioService"

const className = Html.adoptStyleSheet(css, "StudioLiveRoom")

const showConnectRoomDialog = (): Promise<string> => {
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

export const connectRoom = async (service: StudioService): Promise<void> => {
    const roomName = await showConnectRoomDialog().catch(() => null)
    if (roomName === null) {return}
    const progressDialog = RuntimeNotifier.progress({
        headline: "Connecting to Room...",
        message: "Please wait while we connect to the room..."
    })
    const {status, value: project, error} = await Promises.tryCatch(
        YService.getOrCreateRoom(service.projectProfileService.getValue()
            .map(profile => profile.project), service, roomName))
    if (status === "resolved") {
        const p2pSession = new P2PSession({
            chainedSampleProvider: service.chainedSampleProvider,
            chainedSoundfontProvider: service.chainedSoundfontProvider,
            createSocket: url => new WebSocket(url) as SignalingSocket,
            localPeerId: UUID.toString(UUID.generate()),
            assetReader: {
                hasSample: uuid => SampleStorage.get().exists(uuid),
                hasSoundfont: uuid => Workers.Opfs.exists(`${SoundfontStorage.Folder}/${UUID.toString(uuid)}`),
                readSample: async uuid => {
                    const path = `${SampleStorage.Folder}/${UUID.toString(uuid)}`
                    const [wavBytes, metaBytes] = await Promise.all([
                        Workers.Opfs.read(`${path}/audio.wav`),
                        Workers.Opfs.read(`${path}/meta.json`)
                    ])
                    return [wavBytes.buffer as ArrayBuffer, JSON.parse(new TextDecoder().decode(metaBytes))]
                },
                readSoundfont: uuid => SoundfontStorage.get().load(uuid)
            }
        }, roomName, "wss://live.opendaw.studio")
        project.own(p2pSession)
        service.projectProfileService.setProject(project, roomName)
    } else {
        await RuntimeNotifier.info({
            headline: "Failed Connecting Room",
            message: String(error)
        })
    }
    progressDialog.terminate()
}
