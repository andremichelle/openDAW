import css from "./ChordPads.sass?inline"
import {Events, Html} from "@opendaw/lib-dom"
import {Arrays, Lifecycle, Terminator} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Harmony} from "@opendaw/lib-dsp"
import {StudioService} from "@/service/StudioService"
import {ChordPadPlayer} from "@/ui/software-midi/ChordPadPlayer"
import {ChordShortcuts} from "@/ui/shortcuts/SoftwareMIDIShortcuts"

const className = Html.adoptStyleSheet(css, "ChordPads")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    player: ChordPadPlayer
}

export const ChordPads = ({lifecycle, service, player}: Construct) => {
    const names: ReadonlyArray<HTMLElement> = Arrays.create(() => <span className="name"/>, ChordPadPlayer.NumPads)
    const pads: ReadonlyArray<HTMLElement> = names.map((name, index) => {
        const {shortcut} = ChordShortcuts[index]
        return (
            <div className="pad">
                <div className="info">
                    <span>{String(index + 1)}</span>
                    <span onInit={element => lifecycle.own(shortcut.subscribe(() =>
                        element.textContent = shortcut.format().join("")))}>{shortcut.format()}</span>
                </div>
                {name}
            </div>
        )
    })
    const updateNames = () => names.forEach((name, index) => {
        const text = player.chordAt(index + 1).mapOr(chord => Harmony.chordName(chord), "-")
        if (name.textContent !== text) {name.textContent = text}
    })
    const updateActive = () => pads.forEach((pad, index) => pad.classList.toggle("active", player.isActive(index + 1)))
    const projectLifetime = lifecycle.own(new Terminator())
    lifecycle.ownAll(
        service.projectProfileService.catchupAndSubscribe(optProfile => {
            projectLifetime.terminate()
            updateNames()
            optProfile.ifSome(({project: {engine, timelineBoxAdapter: {keyTrack}}}) => projectLifetime.ownAll(
                keyTrack.subscribe(updateNames),
                engine.position.subscribe(updateNames)))
        }),
        player.subscribe(updateActive),
        ...pads.map((pad, index) => Events.subscribe(pad, "pointerdown", (event: PointerEvent) => {
            if (event.button !== 0) {return}
            event.stopPropagation()
            player.press(index + 1)
            const subscription = Events.subscribe(window, "pointerup", () => {
                subscription.terminate()
                player.release(index + 1)
            }, {capture: true})
        }))
    )
    return <div className={className}>{pads}</div>
}
