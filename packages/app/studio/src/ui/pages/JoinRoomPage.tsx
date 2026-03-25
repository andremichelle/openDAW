import {PageContext, PageFactory, RouteLocation} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService"
import {connectRoom} from "@/service/StudioLiveRoomConnect"

export const JoinRoomPage: PageFactory<StudioService> = ({service, path}: PageContext<StudioService>) => {
    const roomName = path.replace(/^\/join\//, "").trim()
    if (roomName.length > 0) {
        queueMicrotask(() => {
            RouteLocation.get().navigateTo("/")
            connectRoom(service, roomName).finally()
        })
    } else {
        queueMicrotask(() => RouteLocation.get().navigateTo("/"))
    }
    return null
}
