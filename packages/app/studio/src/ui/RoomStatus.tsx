import css from "./RoomStatus.sass?inline"
import {createElement, replaceChildren} from "@opendaw/lib-jsx"
import {isDefined, Lifecycle, Nullable, Optional, RuntimeNotifier, Terminator} from "@opendaw/lib-std"
import {Clipboard, Html} from "@opendaw/lib-dom"
import {StudioService} from "@/service/StudioService"
import {AwarenessUserState, RoomAwareness} from "@/service/RoomAwareness"
import {Promises} from "@opendaw/lib-runtime"
import {Icon} from "@/ui/components/Icon"
import {IconSymbol} from "@opendaw/studio-enums"

const className = Html.adoptStyleSheet(css, "room-status")

type Construct = { lifecycle: Lifecycle, service: StudioService }

export const RoomStatus = ({lifecycle, service}: Construct) => {
    const element: HTMLElement = <div className={className}/>
    const roomLifecycle = lifecycle.own(new Terminator())
    lifecycle.own(service.roomAwareness.catchupAndSubscribe(owner => {
        roomLifecycle.terminate()
        const awareness: Nullable<RoomAwareness> = owner.getValue()
        if (isDefined(awareness)) {
            element.style.display = ""
            const roomLabel: HTMLElement = (
                <div className="room-label">
                    <Icon symbol={IconSymbol.Copy}/>
                    <span className="room-name"
                          title="Click to copy join link"
                          onclick={async () => {
                              const joinUrl = `${location.origin}/join/${awareness.roomName}`
                              const {status} = await Promises.tryCatch(Clipboard.writeText(joinUrl))
                              if (status === "resolved") {
                                  await RuntimeNotifier.info({
                                      headline: "Clipboard",
                                      message: `Join link copied to clipboard.`
                                  })
                              }
                          }}>{`Room '${awareness.roomName}'`}</span>
                </div>
            )
            const render = () => {
                const states = awareness.awareness.getStates()
                const localId = awareness.clientID
                const users: Array<{ name: string, color: string, self: boolean }> = []
                states.forEach((state, clientId) => {
                    const user: Optional<AwarenessUserState> = state.user
                    if (isDefined(user)) {
                        users.push({name: user.name, color: user.color, self: clientId === localId})
                    }
                })
                users.sort((first, second) => first.self === second.self ? 0 : first.self ? -1 : 1)
                replaceChildren(element, roomLabel, ...users.map(user => (
                    <div className={user.self ? "user self" : "user"}>
                        <span className="dot" style={{backgroundColor: user.color}}/>
                        <span>{user.name}</span>
                    </div>
                )))
            }
            const awarenessApi = awareness.awareness
            awarenessApi.on("change", render)
            roomLifecycle.own({terminate: () => awarenessApi.off("change", render)})
            render()
        } else {
            element.style.display = "none"
            replaceChildren(element)
        }
    }))
    element.style.display = "none"
    return element
}
