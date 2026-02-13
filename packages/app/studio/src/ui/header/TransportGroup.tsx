import css from "./TransportGroup.sass?inline"
import {Icon} from "@/ui/components/Icon.tsx"
import {createElement} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService"
import {Button} from "@/ui/components/Button.tsx"
import {DefaultObservableValue, Lifecycle, Option, Terminator} from "@opendaw/lib-std"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {Checkbox} from "@/ui/components/Checkbox"
import {Surface} from "@/ui/surface/Surface"
import {CountIn} from "@/ui/header/CountIn"
import {Html} from "@opendaw/lib-dom"
import {ContextMenu, MenuItem, ProjectProfile} from "@opendaw/studio-core"
import {GlobalShortcuts} from "@/ui/shortcuts/GlobalShortcuts"
import {ShortcutTooltip} from "@/ui/shortcuts/ShortcutTooltip"

const className = Html.adoptStyleSheet(css, "TransportGroup")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const TransportGroup = ({lifecycle, service}: Construct) => {
    const {engine, projectProfileService} = service
    const {preferences: {settings: {playback}}} = engine
    const loop = new DefaultObservableValue(false)
    const recordButton: HTMLElement = (
        <Button lifecycle={lifecycle}
                appearance={{
                    color: Colors.red.fade(0.2), activeColor: Colors.red,
                    tooltip: ShortcutTooltip.create("Start Recording", GlobalShortcuts["start-recording"].shortcut)
                }}
                onClick={event => {
                    service.runIfProject(project => {
                        if (project.isRecording()) {
                            project.stopRecording()
                        } else {
                            project.startRecording(!event.shiftKey)
                            document.querySelector<HTMLElement>("[data-scope=\"regions\"]")?.focus()
                        }
                    })
                }}><Icon symbol={IconSymbol.Record}/></Button>)
    const playButton: HTMLElement = (
        <Button lifecycle={lifecycle}
                appearance={{
                    color: Colors.green.saturate(0.0),
                    activeColor: Colors.green,
                    tooltip: ShortcutTooltip.create("Play", GlobalShortcuts["toggle-playback"].shortcut)
                }}
                onClick={() => {
                    if (engine.isPlaying.getValue()) {
                        engine.stop()
                    } else {
                        engine.play()
                    }
                }}><Icon symbol={IconSymbol.Play}/></Button>
    )
    const loopLifecycle = lifecycle.own(new Terminator())
    const countInLifecycle = lifecycle.own(new Terminator())
    const recordingObserver = () => recordButton.classList.toggle("active",
        engine.isCountingIn.getValue() || engine.isRecording.getValue())
    lifecycle.ownAll(
        engine.isPlaying.subscribe(owner => playButton.classList.toggle("active", owner.getValue())),
        engine.isCountingIn.subscribe(recordingObserver),
        engine.isRecording.subscribe(recordingObserver),
        engine.isCountingIn.subscribe(owner => {
            if (owner.getValue()) {
                Surface.get(recordButton).body.appendChild(CountIn({lifecycle: countInLifecycle, engine}))
            } else {
                countInLifecycle.terminate()
            }
        }),
        ContextMenu.subscribe(playButton, collector => collector
            .addItems(
                MenuItem.default({
                    label: "Resume from last playback starting position",
                    checked: playback.timestampEnabled
                }).setTriggerProcedure(() => playback.timestampEnabled = !playback.timestampEnabled),
                MenuItem.default({
                    label: "Pause playback on loop end if loop is disabled",
                    checked: playback.pauseOnLoopDisabled
                }).setTriggerProcedure(() => playback.pauseOnLoopDisabled = !playback.pauseOnLoopDisabled)
            )),
        projectProfileService.catchupAndSubscribe((optProfile: Option<ProjectProfile>) => {
            loopLifecycle.terminate()
            optProfile.match({
                none: () => loop.setValue(false),
                some: ({project: {editing, timelineBox: {loopArea: {enabled}}}}) => {
                    loop.setValue(enabled.getValue())
                    loopLifecycle.ownAll(
                        loop.subscribe(owner => {
                            if (editing.mustModify()) {
                                editing.modify(() => enabled.setValue(owner.getValue()))
                            }
                        }),
                        enabled.subscribe(owner => loop.setValue(owner.getValue()))
                    )
                }
            })
        })
    )
    return (
        <div className={className}>
            {recordButton}
            {playButton}
            <Button lifecycle={lifecycle}
                    onClick={() => {engine.stop(true)}}
                    appearance={{
                        activeColor: Colors.bright,
                        tooltip: ShortcutTooltip.create("Stop", GlobalShortcuts["stop-playback"].shortcut)
                    }}>
                <Icon symbol={IconSymbol.Stop}/>
            </Button>
            <Checkbox lifecycle={lifecycle}
                      model={loop}
                      appearance={{
                          activeColor: Colors.gray,
                          tooltip: ShortcutTooltip.create("Loop", GlobalShortcuts["toggle-loop"].shortcut)
                      }}>
                <Icon symbol={IconSymbol.Loop}/>
            </Checkbox>
        </div>
    )
}