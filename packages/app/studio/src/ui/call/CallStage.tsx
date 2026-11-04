import css from "./CallStage.sass?inline"
import {createElement, replaceChildren} from "@opendaw/lib-jsx"
import {DefaultObservableValue, isDefined, Lifecycle, Option, Terminator} from "@opendaw/lib-std"
import {AnimationFrame, Events, Html} from "@opendaw/lib-dom"
import {IconSymbol} from "@opendaw/studio-enums"
import {MenuItem} from "@opendaw/studio-core"
import {Icon, IconCartridge} from "@/ui/components/Icon"
import {Checkbox} from "@/ui/components/Checkbox"
import {MenuButton} from "@/ui/components/MenuButton"
import {TextTooltip} from "@/ui/surface/TextTooltip"
import {Surface} from "@/ui/surface/Surface"
import {StudioService} from "@/service/StudioService"
import {GlobalShortcuts} from "@/ui/shortcuts/GlobalShortcuts"
import {ShortcutTooltip} from "@/ui/shortcuts/ShortcutTooltip"
import {CallEvent, CallService, MaxCallSize} from "@/call/CallService"
import {CallParticipant} from "@/call/CallTypes"
import {CallTile} from "@/ui/call/CallTile"
import {installScrollbars} from "@/ui/components/Scrollbars"

const className = Html.adoptStyleSheet(css, "CallStage")

const describeEvent = (event: CallEvent): [string, IconSymbol] => {
    switch (event.type) {
        case "joined":
            return [`${event.name} joined the call`, IconSymbol.CallPhone]
        case "left":
            return [`${event.name} left the call`, IconSymbol.CallHangup]
        case "hand":
            return [`${event.name} raised a hand`, IconSymbol.CallHand]
        case "call-started":
            return [`${event.name} started a call. Join from the chat panel.`, IconSymbol.CallPhone]
        case "error":
            return [event.message, IconSymbol.Warning]
    }
}

const revealLabels: Record<MediaDeviceKind, string> = {
    audioinput: "Allow Microphone Access to List Microphones",
    audiooutput: "Allow Microphone Access to List Speakers",
    videoinput: "Allow Camera Access to List Cameras"
}

const deviceItems = (call: CallService, kind: MediaDeviceKind,
                     model: DefaultObservableValue<string>): ReadonlyArray<MenuItem> => {
    const list = call.devices.filter(device => device.kind === kind)
    const items = [MenuItem.default({label: "System Default", checked: model.getValue() === ""})
        .setTriggerProcedure(() => model.setValue(""))]
    if (call.isHidden(kind)) {
        items.push(MenuItem.default({label: revealLabels[kind]})
            .setTriggerProcedure(() => call.revealDevices(kind).then()))
        return items
    }
    list.filter(device => device.deviceId !== "default" && device.deviceId !== "communications")
        .forEach((device, index) => items.push(MenuItem.default({
            label: device.label === "" ? `Device ${index + 1}` : device.label,
            checked: model.getValue() === device.deviceId
        }).setTriggerProcedure(() => model.setValue(device.deviceId))))
    return items
}

const settingsMenu = (call: CallService): MenuItem => MenuItem.root().setRuntimeChildrenProcedure(parent => {
    parent.addMenuItem(
        MenuItem.default({label: "Microphone", icon: IconSymbol.CallMic})
            .setRuntimeChildrenProcedure(sub => sub.addMenuItem(...deviceItems(call, "audioinput", call.micId))),
        MenuItem.default({label: "Camera", icon: IconSymbol.CallCamera})
            .setRuntimeChildrenProcedure(sub => sub.addMenuItem(...deviceItems(call, "videoinput", call.cameraId))),
        MenuItem.default({label: "Speaker", icon: IconSymbol.Speaker, selectable: call.supportsSpeakerSelection})
            .setRuntimeChildrenProcedure(sub =>
                sub.addMenuItem(...deviceItems(call, "audiooutput", call.speakerId))),
        MenuItem.default({label: "Direct Audio (Stereo, No Voice Processing)", checked: call.music.getValue()})
            .setTriggerProcedure(() => call.music.setValue(!call.music.getValue())).addSeparatorBefore(),
        MenuItem.default({label: "Lower Call Volume During Playback", checked: call.duck.getValue()})
            .setTriggerProcedure(() => call.duck.setValue(!call.duck.getValue())),
        MenuItem.default({label: "Silence Call While Recording", checked: call.silenceRecording.getValue()})
            .setTriggerProcedure(() => call.silenceRecording.setValue(!call.silenceRecording.getValue())),
        MenuItem.default({label: "Mirror My Camera", checked: call.mirror.getValue()})
            .setTriggerProcedure(() => call.mirror.setValue(!call.mirror.getValue()))
    )
})

type Construct = { lifecycle: Lifecycle, service: StudioService, overlay: HTMLElement }

export const CallStage = ({lifecycle, service, overlay}: Construct) => {
    const element: HTMLElement = <div className={className}/>
    const callLifecycle = lifecycle.own(new Terminator())
    lifecycle.own(service.callService.catchupAndSubscribe((option: Option<CallService>) => {
        callLifecycle.terminate()
        Html.empty(element)
        overlay.classList.remove("call-live", "in-call")
        option.ifSome(call => renderCall(callLifecycle, call, element, overlay))
    }))
    return element
}

const renderCall = (lifecycle: Terminator, call: CallService, element: HTMLElement, overlay: HTMLElement): void => {
    const tiles = new Map<string, CallTile>()
    const pinned = lifecycle.own(new DefaultObservableValue<string>(""))
    const musicModel = call.music
    const attendees: HTMLElement = <span className="attendees"/>
    const musicRow: HTMLElement = (
        <div className="music-row">
            <Checkbox lifecycle={lifecycle} model={musicModel}>
                <Icon symbol={IconSymbol.Checkbox}/> Direct Audio
            </Checkbox>
        </div>
    )
    const grid: HTMLElement = <div className="grid"/>
    const body: HTMLElement = (
        <div className="body" onConnect={(host: HTMLElement) => lifecycle.own(installScrollbars(host))}>
            {grid}
        </div>
    )
    const tooltip = (target: Element, text: () => string) => lifecycle.own(TextTooltip.default(target, text))
    const iconButton = (symbol: IconSymbol, extraClass: string, onClick: () => void): HTMLButtonElement => (
        <button className={`control ${extraClass}`} onclick={onClick}><Icon symbol={symbol}/></button>
    )
    const micIcon = lifecycle.own(new DefaultObservableValue<IconSymbol>(IconSymbol.CallMic))
    const cameraIcon = lifecycle.own(new DefaultObservableValue<IconSymbol>(IconSymbol.CallCameraOff))
    const micButton: HTMLButtonElement = (
        <button className="control mic"><IconCartridge lifecycle={lifecycle} symbol={micIcon}/><span className="meter"/></button>
    )
    const cameraButton: HTMLButtonElement = (
        <button className="control camera" onclick={() => call.toggleCamera()}>
            <IconCartridge lifecycle={lifecycle} symbol={cameraIcon}/>
        </button>
    )
    const screenButton = iconButton(IconSymbol.CallScreen, "screen", () => call.toggleScreen())
    const handButton = iconButton(IconSymbol.CallHand, "hand", () => call.toggleHand())
    const leaveButton = iconButton(IconSymbol.CallHangup, "leave", () => call.leave())
    const joinButton: HTMLButtonElement = (
        <button className="join" onclick={() => call.join(false)}>
            <Icon symbol={IconSymbol.CallPhone}/><span>Join</span>
        </button>
    )
    const joinVideoButton: HTMLButtonElement = (
        <button className="join video" onclick={() => call.join(true)}>
            <Icon symbol={IconSymbol.CallCamera}/><span>Join with Video</span>
        </button>
    )
    const settingsButton: HTMLElement = (
        <div className="settings">
            <MenuButton root={settingsMenu(call)} appearance={{tooltip: "Call Settings"}}>
                <Icon symbol={IconSymbol.System}/>
            </MenuButton>
        </div>
    )
    const expandButton: HTMLButtonElement = (
        <button className="expand" onclick={() => overlay.classList.toggle("wide")}>
            <Icon symbol={IconSymbol.ExpandWidth}/>
        </button>
    )
    tooltip(micButton, () => ShortcutTooltip.create(call.mic.getValue()
        ? "Mute (hold to talk while muted)" : "Unmute (hold to talk)", GlobalShortcuts["call-toggle-mic"].shortcut)
        .toString())
    tooltip(cameraButton, () => ShortcutTooltip.create(call.camera.getValue() ? "Turn Camera Off" : "Turn Camera On",
        GlobalShortcuts["call-toggle-camera"].shortcut).toString())
    tooltip(screenButton, () => call.screen.getValue() ? "Stop Presenting" : "Present Screen or Tab (with audio)")
    tooltip(handButton, () => ShortcutTooltip.create(call.hand.getValue() ? "Lower Hand" : "Raise Hand",
        GlobalShortcuts["call-toggle-hand"].shortcut).toString())
    tooltip(musicRow, () => musicModel.getValue()
        ? "Stereo, high bitrate, no echo cancellation or noise suppression. Use headphones."
        : "Voice processing on. Enable for instruments and listening sessions.")
    tooltip(attendees, () => call.participants().map(participant => participant.name).join(", "))
    tooltip(leaveButton, () => "Leave Call")
    tooltip(joinButton, () => call.full ? `The call is full (${MaxCallSize} people)` : "Join with Microphone")
    tooltip(joinVideoButton, () => call.full ? `The call is full (${MaxCallSize} people)` : "Join with Microphone and Camera")
    tooltip(expandButton, () => overlay.classList.contains("wide") ? "Narrow Panel" : "Widen Panel")
    const joinedControls: HTMLElement = (
        <div className="controls joined">
            {micButton}
            {cameraButton}
            {screenButton}
            {handButton}
            {leaveButton}
        </div>
    )
    const lobbyControls: HTMLElement = (
        <div className="controls lobby-controls">
            {joinButton}
            {joinVideoButton}
            {musicRow}
        </div>
    )
    replaceChildren(element,
        <header>
            <span className="title">Call</span>
            {attendees}
            <span className="spacer"/>
            {settingsButton}
            {expandButton}
        </header>,
        <div className="bar">
            {lobbyControls}
            {joinedControls}
        </div>,
        body)
    if (!call.supportsScreenShare) {screenButton.classList.add("unsupported")}
    const press: { timer: Option<ReturnType<typeof setTimeout>>, holding: boolean } = {timer: Option.None, holding: false}
    lifecycle.own(Events.subscribe(micButton, "pointerdown", (event: PointerEvent) => {
        if (event.button !== 0) {return}
        micButton.setPointerCapture(event.pointerId)
        press.holding = false
        press.timer = Option.wrap(setTimeout(() => {
            if (call.mic.getValue()) {return}
            press.holding = true
            call.setPushToTalk(true)
            micButton.classList.add("push-to-talk")
        }, 250))
    }))
    const endPress = (toggle: boolean) => {
        press.timer.ifSome(timer => clearTimeout(timer))
        press.timer = Option.None
        if (press.holding) {
            press.holding = false
            call.setPushToTalk(false)
            micButton.classList.remove("push-to-talk")
        } else if (toggle) {
            call.toggleMic().then()
        }
    }
    lifecycle.own(Events.subscribe(micButton, "pointerup", () => endPress(true)))
    lifecycle.own(Events.subscribe(micButton, "pointercancel", () => endPress(false)))
    const onPin = (tile: CallTile) => pinned.setValue(pinned.getValue() === tile.key ? "" : tile.key)
    const autoPinned = new Set<string>()
    const render = () => {
        const participants = call.participants()
        const joined = call.joined.getValue()
        const joining = call.joining.getValue()
        element.classList.toggle("joined", joined)
        element.classList.toggle("joining", joining)
        element.classList.toggle("live", participants.length > 0)
        overlay.classList.toggle("in-call", joined)
        overlay.classList.toggle("call-live", participants.length > 0)
        micIcon.setValue(call.mic.getValue() ? IconSymbol.CallMic : IconSymbol.CallMicOff)
        cameraIcon.setValue(call.camera.getValue() ? IconSymbol.CallCamera : IconSymbol.CallCameraOff)
        micButton.classList.toggle("off", !call.mic.getValue())
        cameraButton.classList.toggle("off", !call.camera.getValue())
        screenButton.classList.toggle("active", call.screen.getValue())
        handButton.classList.toggle("active", call.hand.getValue())
        joinButton.disabled = joining
        joinVideoButton.disabled = joining
        joinButton.classList.toggle("full", call.full)
        joinVideoButton.classList.toggle("full", call.full)
        replaceChildren(attendees, ...participants.map(participant => {
            const dot: HTMLElement = <span className={participant.presence.mic ? "dot" : "dot muted"}/>
            dot.style.setProperty("--user-color", participant.color)
            return dot
        }))
        const wanted = new Map<string, CallParticipant>()
        const kinds = new Map<string, "main" | "screen">()
        if (joined) {
            participants.forEach(participant => {
                wanted.set(CallTile.keyOf(participant.peerId, "main"), participant)
                kinds.set(CallTile.keyOf(participant.peerId, "main"), "main")
                if (participant.presence.screen) {
                    const key = CallTile.keyOf(participant.peerId, "screen")
                    wanted.set(key, participant)
                    kinds.set(key, "screen")
                    if (!participant.self && !autoPinned.has(key) && pinned.getValue() === "") {
                        autoPinned.add(key)
                        pinned.setValue(key)
                    }
                }
            })
        }
        tiles.forEach((tile, key) => {
            if (!wanted.has(key)) {
                tile.terminate()
                tiles.delete(key)
                autoPinned.delete(key)
                if (pinned.getValue() === key) {pinned.setValue("")}
            }
        })
        wanted.forEach((participant, key) => {
            const existing = tiles.get(key)
            if (isDefined(existing)) {
                existing.update(participant)
            } else {
                const tile = new CallTile(call, participant, kinds.get(key) ?? "main", onPin)
                tiles.set(key, tile)
            }
        })
        const ordered = Array.from(tiles.values()).sort((first, second) => {
            const rank = (tile: CallTile) => tile.key === pinned.getValue() ? 0 : tile.kind === "screen" ? 1 : 2
            return rank(first) - rank(second)
        })
        ordered.forEach((tile, index) => {
            tile.element.classList.toggle("pinned", tile.key === pinned.getValue())
            const current = grid.children.item(index)
            if (current !== tile.element) {grid.insertBefore(tile.element, current)}
        })
        grid.dataset.count = String(Math.min(tiles.size, 9))
        grid.classList.toggle("has-video", ordered.some(tile => tile.element.classList.contains("video")))
        grid.classList.toggle("has-pinned", pinned.getValue() !== "" && tiles.size > 1)
    }
    lifecycle.own(pinned.subscribe(() => render()))
    lifecycle.own(call.subscribeChanges(() => render()))
    ;[call.joined, call.joining, call.mic, call.camera, call.screen, call.hand, call.music, call.mirror]
        .forEach(value => lifecycle.own(value.subscribe(() => render())))
    lifecycle.own(call.subscribeEvents(event => {
        const [message, icon] = describeEvent(event)
        if (element.isConnected) {Surface.get(element).toast(message, icon)}
    }))
    const micMeter = micButton.querySelector<HTMLElement>(".meter")
    lifecycle.own(AnimationFrame.add(() => {
        if (!call.joined.getValue()) {return}
        const now = performance.now()
        tiles.forEach(tile => tile.animate(now))
        const raw = call.rawMicLevel()
        micMeter?.style.setProperty("--level", raw.toFixed(3))
        micButton.classList.toggle("talking-muted", !call.mic.getValue() && !call.pushToTalkActive && raw > 0.35)
    }))
    lifecycle.own({
        terminate: () => {
            tiles.forEach(tile => tile.terminate())
            tiles.clear()
        }
    })
    render()
}

export const CallDock = ({lifecycle, service}: { lifecycle: Lifecycle, service: StudioService }) => {
    const dots: HTMLElement = <div className="dots"/>
    const micIcon = lifecycle.own(new DefaultObservableValue<IconSymbol>(IconSymbol.CallMic))
    const micButton: HTMLButtonElement = (
        <button className="dock-mic" onclick={() => service.callService.ifSome(call => call.toggleMic())}>
            <IconCartridge lifecycle={lifecycle} symbol={micIcon}/>
        </button>
    )
    const leaveButton: HTMLButtonElement = (
        <button className="dock-leave" onclick={() => service.callService.ifSome(call => call.leave())}>
            <Icon symbol={IconSymbol.CallHangup}/>
        </button>
    )
    lifecycle.own(TextTooltip.default(micButton, () => "Mute or Unmute"))
    lifecycle.own(TextTooltip.default(leaveButton, () => "Leave Call"))
    const element: HTMLElement = <div className="call-dock">{micButton}{dots}{leaveButton}</div>
    const callLifecycle = lifecycle.own(new Terminator())
    lifecycle.own(service.callService.catchupAndSubscribe((option: Option<CallService>) => {
        callLifecycle.terminate()
        Html.empty(dots)
        option.ifSome(call => {
            const dotMap = new Map<string, HTMLElement>()
            const levels = new Map<string, number>()
            const render = () => {
                micIcon.setValue(call.mic.getValue() ? IconSymbol.CallMic : IconSymbol.CallMicOff)
                micButton.classList.toggle("off", !call.mic.getValue())
                const participants = call.joined.getValue() ? call.participants() : []
                const keys = new Set(participants.map(participant => participant.peerId))
                dotMap.forEach((dot, key) => {
                    if (!keys.has(key)) {
                        dot.remove()
                        dotMap.delete(key)
                    }
                })
                const createDot = (participant: CallParticipant): HTMLElement => {
                    const dot: HTMLElement = <span className="dot"/>
                    dotMap.set(participant.peerId, dot)
                    dots.appendChild(dot)
                    callLifecycle.own(TextTooltip.default(dot, () => participant.name))
                    return dot
                }
                participants.forEach(participant => {
                    const dot = dotMap.get(participant.peerId) ?? createDot(participant)
                    dot.style.setProperty("--user-color", participant.color)
                    dot.classList.toggle("muted", !participant.presence.mic)
                })
            }
            callLifecycle.own(call.subscribeChanges(render))
            callLifecycle.own(call.mic.subscribe(render))
            callLifecycle.own(call.joined.subscribe(render))
            callLifecycle.own(AnimationFrame.add(() => {
                if (!call.joined.getValue()) {return}
                dotMap.forEach((dot, peerId) => {
                    const level = Math.max(call.level(peerId), (levels.get(peerId) ?? 0) * 0.85)
                    levels.set(peerId, level)
                    dot.style.setProperty("--level", level.toFixed(3))
                })
            }))
            render()
        })
    }))
    return element
}
