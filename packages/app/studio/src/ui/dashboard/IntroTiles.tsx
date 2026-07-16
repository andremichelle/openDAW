import css from "./IntroTiles.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {createElement, RouteLocation} from "@opendaw/lib-jsx"
import {IconSymbol} from "@opendaw/studio-enums"
import {Icon} from "@/ui/components/Icon"

const className = Html.adoptStyleSheet(css, "IntroTiles")

// Each tile links to its own page; the legend shows that destination. Topics reuse an existing page where one
// exists (Privacy -> /privacy), otherwise the manual under /manuals/<slug>.
type Tile = {
    icon: IconSymbol
    title: string
    text: string
    path: string
}

const tiles: ReadonlyArray<Tile> = [
    {
        icon: IconSymbol.Timeline,
        title: "Your Studio",
        text: "Instruments, effects, a mixer, MIDI and audio recording, all in one place. Arrange, produce and "
            + "mix complete tracks.",
        path: "/manuals/introduction"
    },
    {
        icon: IconSymbol.Connected,
        title: "Live Rooms",
        text: "Open a room, share the link, and make music together in real time. Everyone edits the same "
            + "session at once.",
        path: "/manuals/live-rooms"
    },
    {
        icon: IconSymbol.Book,
        title: "Education",
        text: "Made for learning music production, from your first beat to a finished track. Classroom-friendly "
            + "and free to use.",
        path: "/manuals/education"
    },
    {
        icon: IconSymbol.Lock,
        title: "Privacy",
        text: "No account, no subscription, no tracking. Your projects stay on your device and are never "
            + "uploaded to our servers.",
        path: "/privacy"
    },
    {
        icon: IconSymbol.Code,
        title: "Open Source",
        text: "openDAW is open source. Inspect it, fork it, self-host it, or build your own devices and "
            + "extensions on top.",
        path: "/manuals/open-source"
    }
]

export const IntroTiles = () => (
    <div className={className}>
        <div className="tiles">
            {tiles.map(({icon, title, text, path}) => (
                <div className="tile" onclick={() => RouteLocation.get().navigateTo(path)}>
                    <div className="tile-head">
                        <Icon symbol={icon}/>
                        <div className="tile-title">{title}</div>
                    </div>
                    <div className="tile-text">{text}</div>
                    <div className="tile-link">{path}</div>
                </div>
            ))}
        </div>
    </div>
)
