import {createElement, PageContext, PageFactory, RouteLocation} from "@moises-ai/lib-jsx"
import {StudioService} from "@/service/StudioService"
import {connectRoom} from "@/service/StudioLiveRoomConnect"

export const JoinRoomPage: PageFactory<StudioService> = ({service, path}: PageContext<StudioService>) => {
    const roomName = path.replace(/^\/join\//, "").trim()
    if (roomName.length > 0) {
        connectRoom(service, roomName)
            .catch(() => RouteLocation.get().navigateTo("/"))
    } else {
        queueMicrotask(() => RouteLocation.get().navigateTo("/"))
    }
    return <div style={{flex: "1", backgroundColor: "var(--color-background)"}}/>
}