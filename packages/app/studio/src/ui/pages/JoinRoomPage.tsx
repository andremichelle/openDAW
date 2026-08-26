import {createElement, PageContext, PageFactory, RouteLocation} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService"
import {connectRoom} from "@/service/StudioLiveRoomConnect"

export const JoinRoomPage: PageFactory<StudioService> = ({service, path}: PageContext<StudioService>) => {
    const roomName = path.replace(/^\/join\//, "").trim()
    if (roomName.length > 0) {
        connectRoom(service, roomName)
            .catch(() => RouteLocation.get().replaceWith("/"))
    } else {
        queueMicrotask(() => RouteLocation.get().replaceWith("/"))
    }
    return <div style={{flex: "1", backgroundColor: "var(--color-background)"}}/>
}