import css from "./RoomStatus.sass?inline"
import {createElement, replaceChildren} from "@opendaw/lib-jsx"
import {isDefined, Lifecycle, Nullable, Optional, Terminator} from "@opendaw/lib-std"
import {Clipboard, Html} from "@opendaw/lib-dom"
import {Surface} from "@/ui/surface/Surface"
import {StudioService} from "@/service/StudioService"
import {AwarenessUserState, RoomAwareness} from "@/service/RoomAwareness"
import {Promises} from "@opendaw/lib-runtime"
import {Icon} from "@/ui/components/Icon"
import {IconSymbol} from "@opendaw/studio-enums"
import {TrafficWatch} from "@/ui/TrafficWatch"
import {asCallPresence, CallPresence} from "@/call/CallTypes"
import {MenuItem} from "@opendaw/studio-core"
import {MenuButton} from "@/ui/components/MenuButton"
import {FollowAwarenessField, FollowService} from "@/follow/FollowService"
import {followersOf} from "@/follow/FollowMath"
import {asFollowTarget} from "@/follow/FollowTypes"

const className = Html.adoptStyleSheet(css, "room-status")

type RoomUser = {
    readonly clientId: number
    readonly name: string
    readonly color: string
    readonly self: boolean
    readonly call: Nullable<CallPresence>
    readonly following: boolean
    readonly leading: boolean
}

const followMenu = (follow: FollowService, user: RoomUser): MenuItem => MenuItem.root()
    .setRuntimeChildrenProcedure(parent => {
        const target = follow.target.getValue()
        if (user.self) {
            parent.addMenuItem(MenuItem.default({label: "Stop Following"})
                .setTriggerProcedure(() => follow.unfollow()))
        } else if (target === user.clientId) {
            parent.addMenuItem(MenuItem.default({label: "Stop Following"})
                .setTriggerProcedure(() => follow.unfollow()))
        } else {
            parent.addMenuItem(MenuItem.default({
                label: `Follow ${user.name}'s Playback`,
                selectable: follow.canFollow(user.clientId)
            }).setTriggerProcedure(() => follow.follow(user.clientId)))
        }
    })

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
                    <Icon symbol={IconSymbol.Share}/>
                    <span className="room-name"
                          title="Click to copy join link"
                          onclick={async () => {
                              const joinUrl = `${location.origin}/join/${awareness.roomName}`
                              const {status} = await Promises.tryCatch(Clipboard.writeText(joinUrl))
                              if (status === "resolved") {
                                  Surface.get(element).toast("Join link copied to clipboard", IconSymbol.Copy)
                              }
                          }}>{`Room '${awareness.roomName}'`}</span>
                </div>
            )
            const render = () => {
                const states = awareness.awareness.getStates()
                const localId = awareness.clientID
                const links = new Map<number, Nullable<number>>()
                states.forEach((state, clientId) => links.set(clientId, asFollowTarget(state[FollowAwarenessField])))
                const users: Array<RoomUser> = []
                states.forEach((state, clientId) => {
                    const user: Optional<AwarenessUserState> = state.user
                    if (isDefined(user)) {
                        users.push({
                            clientId, name: user.name, color: user.color, self: clientId === localId,
                            call: asCallPresence(state.call), following: isDefined(links.get(clientId)),
                            leading: followersOf(links, clientId).length > 0
                        })
                    }
                })
                users.sort((first, second) => first.self === second.self ? 0 : first.self ? -1 : 1)
                const trafficWatch = <TrafficWatch lifecycle={roomLifecycle}
                                                   trafficMeter={service.trafficMeter.getValue()}/>
                replaceChildren(element, roomLabel, ...users.map(user => (
                    <div className={user.self ? "user self" : "user"}>
                        <span className="dot" style={{backgroundColor: user.color}}/>
                        {service.followService.match({
                            none: () => <span>{user.name}</span>,
                            some: followService => user.self && !user.following ? <span>{user.name}</span> : (
                                <MenuButton root={followMenu(followService, user)} style={{color: "inherit"}}>
                                    <span>{user.name}</span>
                                </MenuButton>
                            )
                        })}
                        {user.leading && (
                            <span className="follow leading"><Icon symbol={IconSymbol.Broadcast}/></span>
                        )}
                        {user.following && (
                            <span className="follow"><Icon symbol={IconSymbol.Headphone}/></span>
                        )}
                        {isDefined(user.call) && (
                            <span className={user.call.mic ? "call" : "call muted"}>
                                <Icon symbol={user.call.mic ? IconSymbol.CallMic : IconSymbol.CallMicOff}/>
                            </span>
                        )}
                        {isDefined(user.call) && user.call.camera && (
                            <span className="call"><Icon symbol={IconSymbol.CallCamera}/></span>
                        )}
                        {isDefined(user.call) && user.call.hand && (
                            <span className="call hand" style={{animationDelay: `-${Math.round(performance.now() % 2000)}ms`}}>
                                <Icon symbol={IconSymbol.CallHand}/>
                            </span>
                        )}
                    </div>
                )), trafficWatch)
            }
            const awarenessApi = awareness.awareness
            awarenessApi.on("change", render)
            roomLifecycle.own({terminate: () => awarenessApi.off("change", render)})
            roomLifecycle.own(service.followService.subscribe(() => render()))
            render()
        } else {
            element.style.display = "none"
            replaceChildren(element)
        }
    }))
    element.style.display = "none"
    return element
}
