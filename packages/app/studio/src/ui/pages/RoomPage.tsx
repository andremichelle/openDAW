import {createElement, PageContext, PageFactory} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService"
import {JoinScreen} from "@/ui/collab/JoinScreen"

export const RoomPage: PageFactory<StudioService> = ({path}: PageContext<StudioService>) => {
    const segments = path.split("/")
    const roomId = segments[2] ?? ""
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
                onJoin={(displayName: string) => {
                    console.debug(`Joining room ${roomId} as ${displayName}`)
                }}
                onCancel={() => {
                    history.back()
                }}
                isConnecting={false}
            />
        </div>
    )
}
