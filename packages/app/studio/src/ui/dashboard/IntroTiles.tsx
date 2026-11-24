import css from "./IntroTiles.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {createElement, RouteLocation} from "@opendaw/lib-jsx"
import {IconSymbol} from "@opendaw/studio-enums"
import {Icon} from "@/ui/components/Icon"
import {openManual} from "@/ui/manuals"
import {isManualsPath} from "@opendaw/studio-markdown"
const className = Html.adoptStyleSheet(css, "IntroTiles")

type Target = { type: "route", path: string } | { type: "external", href: string }

type Tile = {
    icon: IconSymbol
    title: string
    text: string
    target: Target
}

const communityTiles: ReadonlyArray<Tile> = [
    {
        icon: IconSymbol.Code,
        title: "Open Source",
        text: "openDAW is open source. Inspect it, fork it, self-host it, or build your own devices and "
            + "extensions on top.",
        target: {type: "route", path: "/manuals/open-source"}
    },
    {
        icon: IconSymbol.Broadcast,
        title: "openDAW Stage",
        text: "Your own music website. Publish tracks straight from the studio, visitors listen, like, comment "
            + "and follow.",
        target: {type: "external", href: "https://github.com/andremichelle/opendaw-stage"}
    },
    {
        icon: IconSymbol.Share,
        title: "openDAW Commons",
        text: "Scripts, plugins and presets shared by the community. Add your own with a pull request, everyone "
            + "gets it in the studio.",
        target: {type: "external", href: "https://github.com/andremichelle/opendaw-commons"}
    },
    {
        icon: IconSymbol.WebClap,
        title: "WebCLAP",
        text: "Build your own instruments and effects as WebCLAP plugins. They run in the browser and load into "
            + "openDAW like any other device.",
        target: {type: "external", href: "https://github.com/andremichelle/open-webclap"}
    },
    {
        icon: IconSymbol.Robot,
        title: "Create Plugins with AI",
        text: "Describe an effect or instrument to an AI coding agent and play it in openDAW. No coding "
            + "skills needed.",
        target: {type: "route", path: "/manuals/create-webclap-with-ai"}
    }
]

const tiles: ReadonlyArray<Tile> = [
    {
        icon: IconSymbol.Timeline,
        title: "Your Studio",
        text: "Instruments, effects, a mixer, MIDI and audio recording, all in one place. Arrange, produce and "
            + "mix complete tracks.",
        target: {type: "route", path: "/manuals/"}
    },
    {
        icon: IconSymbol.Connected,
        title: "Live Rooms",
        text: "Open a room, share the link, and make music together in real time. Everyone edits the same "
            + "session at once.",
        target: {type: "route", path: "/manuals/live-rooms"}
    },
    {
        icon: IconSymbol.Book,
        title: "Education",
        text: "Made for learning music production, from your first beat to a finished track. Classroom-friendly "
            + "and free to use.",
        target: {type: "route", path: "/manuals/education"}
    },
    {
        icon: IconSymbol.Lock,
        title: "Privacy",
        text: "No account, no subscription, no tracking. Your projects stay on your device and are never "
            + "uploaded to our servers.",
        target: {type: "route", path: "/privacy"}
    },
    {
        icon: IconSymbol.FileList,
        title: "Manuals",
        text: "Step by step guides for every device, editor and workflow, from your first project to scripting "
            + "and plugins.",
        target: {type: "route", path: "/manuals/"}
    }
]

const open = (target: Target): void => {
    switch (target.type) {
        case "route":
            if (isManualsPath(target.path)) {
                openManual(target.path)
            } else {
                RouteLocation.get().navigateTo(target.path)
            }
            return
        case "external":
            window.open(target.href, "_blank", "noopener,noreferrer")
            return
    }
}

const renderTile = ({icon, title, text, target}: Tile) => (
    <div className="tile" onclick={() => open(target)}>
        <div className="tile-head">
            <Icon symbol={icon}/>
            <div className="tile-title">{title}</div>
        </div>
        <div className="tile-text">{text}</div>
    </div>
)

export const IntroTiles = () => (
    <div className={className}>
        <div className="tiles">{communityTiles.map(renderTile)}</div>
        <div className="tiles">{tiles.map(renderTile)}</div>
    </div>
)