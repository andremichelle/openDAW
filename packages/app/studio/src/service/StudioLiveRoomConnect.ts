import {Errors, Option, Optional, panic, Progress, RuntimeNotifier, Terminator, TimeSpan, UUID} from "@opendaw/lib-std"
import {Promises, Wait} from "@opendaw/lib-runtime"
import {SampleStorage, SoundfontStorage, Workers, YService} from "@opendaw/studio-core"
import {P2PSession, type SignalingSocket} from "@opendaw/studio-p2p"
import {StudioService} from "@/service/StudioService"
import {showConnectRoomDialog} from "@/service/StudioLiveRoomDialog.tsx"
import {RoomAwareness, writeIdentity} from "@/service/RoomAwareness"
import {newRoomSessionId, reportRoomResult, RoomResultStatus, startRoomDurationHeartbeat} from "@/service/RoomStatsReporter"
import {ChatService} from "@/chat/ChatService"
import {Events} from "@opendaw/lib-dom"
import {RouteLocation} from "@opendaw/lib-jsx"

const classifyConnectError = (error: unknown): RoomResultStatus => {
    if (Errors.isAbort(error)) {return "abort"}
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes("Timeout")) {return "sync_timeout"}
    return "unknown"
}

export const connectRoom = async (service: StudioService, prefillRoomName?: Optional<string>): Promise<void> => {
    const result = await showConnectRoomDialog(prefillRoomName).catch(() => null)
    if (result === null) {return}
    const {roomName, userName, userColor} = result
    writeIdentity(userName, userColor)
    const progressDialog = RuntimeNotifier.progress({
        headline: "Connecting to Room...",
        message: "Please wait while we connect to the room..."
    })
    const sessionId = newRoomSessionId()
    const sourceProfile = service.projectProfileService.getValue()
    const sourceCover = sourceProfile.flatMap(profile => profile.cover)
    const sourceCoverId = sourceProfile.mapOr(profile => profile.coverId, "")
    const {status, value: roomResult, error} = await Promises.tryCatch(
        YService.getOrCreateRoom(sourceProfile.map(profile => profile.project), service, roomName))
    if (status === "resolved") {
        reportRoomResult(sessionId, "success")
        const heartbeat = startRoomDurationHeartbeat(sessionId)
        const pagehideHandler = () => heartbeat.finalize()
        window.addEventListener("pagehide", pagehideHandler)
        const {project, provider} = roomResult
        const p2pSession = new P2PSession({
            chainedSampleProvider: service.chainedSampleProvider,
            chainedSoundfontProvider: service.chainedSoundfontProvider,
            createSocket: url => new WebSocket(url) as SignalingSocket,
            localPeerId: UUID.toString(UUID.generate()),
            assetReader: {
                hasSample: uuid => SampleStorage.get().exists(uuid),
                hasSoundfont: uuid => Workers.Opfs.exists(`${SoundfontStorage.Folder}/${UUID.toString(uuid)}`),
                hasCover: async uuid => service.projectProfileService.getValue()
                    .mapOr(profile => profile.coverId === UUID.toString(uuid) && profile.cover.nonEmpty(), false),
                readSample: async uuid => {
                    const path = `${SampleStorage.Folder}/${UUID.toString(uuid)}`
                    const [wavBytes, metaBytes] = await Promise.all([
                        Workers.Opfs.read(`${path}/audio.wav`),
                        Workers.Opfs.read(`${path}/meta.json`)
                    ])
                    return [wavBytes.buffer as ArrayBuffer, JSON.parse(new TextDecoder().decode(metaBytes))]
                },
                readSoundfont: uuid => SoundfontStorage.get().load(uuid),
                readCover: async uuid => service.projectProfileService.getValue()
                    .flatMap(profile => profile.coverId === UUID.toString(uuid) ? profile.cover : Option.None)
                    .unwrapOrElse(() => panic(`No cover for ${UUID.toString(uuid)}`))
            }
        }, roomName, "wss://live.opendaw.studio")
        project.own(p2pSession)
        const terminator = new Terminator()
        project.own(terminator)
        terminator.own({terminate: () => heartbeat.finalize()})
        terminator.own({terminate: () => window.removeEventListener("pagehide", pagehideHandler)})
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
        service.projectProfileService.getValue().ifSome(profile => {
            // Creator: the room project is a copy of the source, so the same cover-id already has its bytes locally.
            if (profile.coverId !== "" && profile.coverId === sourceCoverId) {
                sourceCover.ifSome(cover => profile.setFetchedCover(cover))
            }
            const fetchCover = async () => {
                const coverId = profile.coverId
                if (coverId === "" || profile.cover.nonEmpty()) {return}
                const {status, value} = await Promises.tryCatch(
                    p2pSession.fetchCover(UUID.parse(coverId), Progress.Empty))
                if (status === "resolved" && profile.coverId === coverId) {profile.setFetchedCover(value)}
            }
            terminator.own(profile.subscribeCoverId(() => {fetchCover()}))
            fetchCover()
        })
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
        reportRoomResult(sessionId, classifyConnectError(error))
        console.warn(error)
        RuntimeNotifier.notify({message: "Could not connect to room.", icon: "Warning"})
    }
    progressDialog.terminate()
}
