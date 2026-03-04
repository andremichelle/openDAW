import {createElement, PageContext, PageFactory} from "@opendaw/lib-jsx"
import {RouteLocation} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService"
import {JoinScreen} from "@/ui/collab/JoinScreen"
import {CollabState} from "@opendaw/studio-core"

export const RoomPage: PageFactory<StudioService> = ({path, service}: PageContext<StudioService>) => {
    const segments = path.split("/")
    const roomId = segments[2] ?? ""
    const isConnecting = service.collabService.state === CollabState.Connecting
    return (
        <div style={{
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            flex: "1 0 0",
            background: "var(--surface-bg, #1a1a1a)"
        }}>
            <JoinScreen
                roomId={roomId}
                onJoin={async (displayName: string) => {
                    console.debug(`Joining room ${roomId} as ${displayName}`)
                    const boxGraph = service.createCollabBoxGraph()
                    service.collabService.joinRoom(roomId, displayName, boxGraph)
                    const subscription = service.collabService.onChange.subscribe(state => {
                        if (state === CollabState.Connected) {
                            subscription.terminate()
                            service.loadCollabProject(boxGraph)
                            service.switchScreen("default")
                        } else if (state === CollabState.Disconnected) {
                            subscription.terminate()
                            RouteLocation.get().navigateTo("/")
                        }
                    })
                }}
                onCancel={() => {
                    RouteLocation.get().navigateTo("/")
                }}
                isConnecting={isConnecting}
            />
        </div>
    )
}
