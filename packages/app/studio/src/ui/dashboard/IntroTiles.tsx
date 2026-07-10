import css from "./IntroTiles.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {isDefined} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {IconSymbol} from "@opendaw/studio-enums"
import {Icon} from "@/ui/components/Icon"

const className = Html.adoptStyleSheet(css, "IntroTiles")

type Tile = {
    icon: IconSymbol
    title: string
    text: string
    href?: string
}

const tiles: ReadonlyArray<Tile> = [
    {
        icon: IconSymbol.Timeline,
        title: "Your Studio",
        text: "A full DAW that runs in your browser: instruments, effects, a mixer, MIDI and audio recording. "
            + "Arrange, produce and mix complete tracks, nothing to install."
    },
    {
        icon: IconSymbol.Connected,
        title: "Live Room",
        text: "Open a room, share the link, and make music together in real time. Everyone edits the same "
            + "session at once, like a jam that runs in the browser."
    },
    {
        icon: IconSymbol.Book,
        title: "Education",
        text: "Made for learning music production, from your first beat to a finished track. Classroom-friendly "
            + "and free to use.",
        href: "https://opendaw.org/education"
    },
    {
        icon: IconSymbol.Lock,
        title: "Privacy",
        text: "No account, no subscription, no tracking. Your projects stay on your device and are never "
            + "uploaded to our servers."
    },
    {
        icon: IconSymbol.Code,
        title: "Open source",
        text: "openDAW is open source. Inspect it, fork it, self-host it, or build your own devices and "
            + "extensions on top."
    }
]

export const IntroTiles = () => (
    <div className={className}>
        {tiles.map(({icon, title, text, href}) => {
            const body = [
                <div className="tile-head">
                    <Icon symbol={icon}/>
                    <div className="tile-title">{title}</div>
                </div>,
                <div className="tile-text">{text}</div>
            ]
            return isDefined(href)
                ? <a className="tile" href={href} target="_blank" rel="noopener noreferrer">{body}</a>
                : <div className="tile">{body}</div>
        })}
    </div>
)
