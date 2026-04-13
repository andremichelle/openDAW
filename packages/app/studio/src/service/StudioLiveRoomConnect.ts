import {Optional, RuntimeNotifier, Terminator, TimeSpan, UUID} from "@moises-ai/lib-std"
import {Promises, Wait} from "@moises-ai/lib-runtime"
import {SampleStorage, SoundfontStorage, Workers, YService} from "@moises-ai/studio-core"
import {P2PSession, type SignalingSocket} from "@opendaw/studio-p2p"
import {StudioService} from "@/service/StudioService"
import {showConnectRoomDialog} from "@/service/StudioLiveRoomDialog.tsx"
import {RoomAwareness, writeIdentity} from "@/service/RoomAwareness"
import {ChatService} from "@/chat/ChatService"
import {Events} from "@moises-ai/lib-dom"
import {RouteLocation} from "@moises-ai/lib-jsx"

export const connectRoom = async (service: StudioService, prefillRoomName?: Optional<string>): Promise<void> => {
    const result = await showConnectRoomDialog(prefillRoomName).catch(() => null)
    if (result === null) {return}
    const {roomName, userName, userColor} = result
    writeIdentity(userName, userColor)
    const progressDialog = RuntimeNotifier.progress({
        headline: "Connecting to Room...",
        message: "Please wait while we connect to the room..."
    })
    const {status, value: roomResult, error} = await Promises.tryCatch(
        YService.getOrCreateRoom(service.projectProfileService.getValue()
            .map(profile => profile.project), service, roomName))
    if (status === "resolved") {
        const {project, provider} = roomResult
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
        const terminator = new Terminator()
        project.own(terminator)
        const roomAwareness = new RoomAwareness(provider.awareness, roomName, userName, userColor)
        terminator.own(roomAwareness)
        terminator.own(Events.subscribe(window, "pointermove", (event: PointerEvent) => {
            const target = event.target
            if (target instanceof Element) {
                const panel = target.closest("[data-panel-type]")
                roomAwareness.panel.setValue(panel?.getAttribute("data-panel-type") ?? null)
            } else {
                roomAwareness.panel.setValue(null)
            }
        }))
        service.factoryFooterLabel().ifSome(factory => {
            const label = factory()
            terminator.own(label)
            const awareness = provider.awareness
            const update = () => label.setValue(String(awareness.getStates().size))
            awareness.on("update", update)
            terminator.own({terminate: () => awareness.off("update", update)})
            label.setTitle("Room Users")
            update()
        })
        RouteLocation.get().navigateTo("/")
        service.projectProfileService.setProject(project, roomName)
        service.setRoomAwareness(roomAwareness)
        terminator.own({terminate: () => service.setRoomAwareness(null)})
        service.setTrafficMeter(p2pSession.trafficMeter)
        terminator.own({terminate: () => service.setTrafficMeter(null)})
        const chatService = new ChatService(provider.doc, userName, userColor)
        terminator.own(chatService)
        service.chatService.wrap(chatService)
        terminator.own({terminate: () => service.chatService.clear()})
        await Wait.timeSpan(TimeSpan.seconds(1))
    } else {
        await RuntimeNotifier.info({
            headline: "Failed Connecting Room",
            message: String(error)
        })
    }
    progressDialog.terminate()
}
