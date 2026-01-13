import {Errors, Option, panic, RuntimeNotifier, TimeSpan, UUID} from "@moises-ai/lib-std"
import {BoxGraph} from "@moises-ai/lib-box"
import {Promises} from "@moises-ai/lib-runtime"
import {BoxIO, UserInterfaceBox} from "@moises-ai/studio-boxes"
import {ProjectSkeleton} from "@moises-ai/studio-adapters"
import {YSync} from "./YSync"
import * as Y from "yjs"
import {WebsocketProvider} from "y-websocket"
import {Project, ProjectEnv} from "../project"
import {ProjectMigration} from "../project/ProjectMigration"

// https://inspector.yjs.dev/

export namespace YService {
    const USE_LOCAL_SERVER = false
    const LOCAL_SERVER_URL = "wss://localhost:1234"
    const ONLINE_SERVER_URL = "wss://live.opendaw.studio"
    const serverUrl = USE_LOCAL_SERVER ? LOCAL_SERVER_URL : ONLINE_SERVER_URL

    export const getOrCreateRoom = async (optProject: Option<Project>,
                                          env: ProjectEnv,
                                          roomName: string): Promise<Project> => {
        if (roomName === "signaling") {return panic("Invalid room name: signaling")}
        const doc = new Y.Doc()
        const provider: WebsocketProvider = new WebsocketProvider(serverUrl, roomName, doc)
        console.debug("clientID:", doc.clientID)
        console.debug("Provider url:", provider.url)
        if (!provider.synced) {
            const {resolve, promise} = Promise.withResolvers<void>()
            const onSync = (isSynced: boolean) => {
                if (isSynced) {
                    provider.off("sync", onSync)
                    resolve()
                }
            }
            provider.on("sync", onSync)
            await Promises.timeout(promise, TimeSpan.seconds(10), "Timeout 'synced'")
        }
        const boxes = doc.getMap("boxes")
        const isRoomEmpty = boxes.size === 0
        if (isRoomEmpty) {
            const project = optProject.match({
                none: () => Project.new(env),
                some: project => project.copy()
            })
            const sync = await YSync.populateRoom({
                boxGraph: project.boxGraph,
                boxes,
                conflict: () => project.invalid()
            })
            project.own(sync)
            project.editing.disable()
            return project
        } else {
            if (optProject.nonEmpty()) {
                const approved = await RuntimeNotifier.approve({
                    headline: "Room Already Exists",
                    message: "Do you want to join it?",
                    approveText: "Join",
                    cancelText: "Cancel"
                })
                if (!approved) {
                    return Promise.reject(Errors.AbortError)
                }
            }
            const boxGraph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
            const sync = await YSync.joinRoom({boxGraph, boxes, conflict: () => project.invalid()})
            const mandatoryBoxes = ProjectSkeleton.findMandatoryBoxes(boxGraph)
            const skeleton: ProjectSkeleton = {boxGraph, mandatoryBoxes}
            await ProjectMigration.migrate(env, skeleton)
            const project = Project.fromSkeleton(env, skeleton, false)
            boxGraph.beginTransaction()
            // TODO How takes care to remove the user interface boxes?
            const userInterfaceBox = UserInterfaceBox.create(boxGraph, UUID.generate(),
                box => box.root.refer(mandatoryBoxes.rootBox.users))
            boxGraph.endTransaction()
            project.follow(userInterfaceBox)
            project.own(sync)
            project.editing.disable()
            return project
        }
    }
}