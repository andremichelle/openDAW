import css from "./IntroTiles.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {IconSymbol} from "@opendaw/studio-enums"
import {Icon} from "@/ui/components/Icon"
import {SectionLabel} from "@/ui/dashboard/SectionLabel"

const className = Html.adoptStyleSheet(css, "IntroTiles")

// Purely informational tiles (see IntroTiles.sass): no links, no hover, styled as editorial feature columns.
type Tile = {
    icon: IconSymbol
    title: string
    text: string
}

const tiles: ReadonlyArray<Tile> = [
    {
        icon: IconSymbol.Timeline,
        title: "Your Studio",
        text: "Instruments, effects, a mixer, MIDI and audio recording, all in one place. Arrange, produce and "
            + "mix complete tracks."
    },
    {
        icon: IconSymbol.Connected,
        title: "Live Rooms",
        text: "Open a room, share the link, and make music together in real time. Everyone edits the same "
            + "session at once."
    },
    {
        icon: IconSymbol.Book,
        title: "Education",
        text: "Made for learning music production, from your first beat to a finished track. Classroom-friendly "
            + "and free to use."
    },
    {
        icon: IconSymbol.Lock,
        title: "Privacy",
        text: "No account, no subscription, no tracking. Your projects stay on your device and are never "
            + "uploaded to our servers."
    },
    {
        icon: IconSymbol.Code,
        title: "Open Source",
        text: "openDAW is open source. Inspect it, fork it, self-host it, or build your own devices and "
            + "extensions on top."
    }
]

export const IntroTiles = () => (
    <div className={className}>
        <SectionLabel title="Create Music Online"/>
        <div className="tiles">
            {tiles.map(({icon, title, text}) => (
                <div className="tile">
                    <div className="tile-head">
                        <Icon symbol={icon}/>
                        <div className="tile-title">{title}</div>
                    </div>
                    <div className="tile-text">{text}</div>
                </div>
            ))}
        </div>
    </div>
)
