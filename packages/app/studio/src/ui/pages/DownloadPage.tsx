import css from "./DownloadPage.sass?inline"
import {createElement, PageContext, PageFactory} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {Optional} from "@opendaw/lib-std"
import {StudioService} from "@/service/StudioService"
import {installScrollbars} from "@/ui/components/Scrollbars"
import {PlatformIcons} from "@/ui/pages/PlatformIcons"

const className = Html.adoptStyleSheet(css, "DownloadPage")

const ReleaseUrl = "https://github.com/andremichelle/openDAW/releases/latest/download"

type Download = { label: string, file: string }
type PlatformKey = "macos" | "windows" | "linux"

const detectPlatform = (): Optional<PlatformKey> => {
    const agent = navigator.userAgent.toLowerCase()
    if (/android|iphone|ipad|mobile/.test(agent)) {return undefined}
    if (agent.includes("mac")) {return "macos"}
    if (agent.includes("win")) {return "windows"}
    if (agent.includes("linux") || agent.includes("x11")) {return "linux"}
    return undefined
}

const Platform = ({platform, name, icon, note, size, downloads}: {
    platform: PlatformKey, name: string, icon: string, note: string, size: string, downloads: ReadonlyArray<Download>
}) => (
    <div className={Html.buildClassList("platform", detectPlatform() === platform && "detected")}>
        <svg viewBox="0 0 24 24" className="icon">
            <path d={icon}/>
        </svg>
        <h2>{name}</h2>
        <div className="buttons">
            {downloads.map(({label, file}) => (<a className="download" href={`${ReleaseUrl}/${file}`}>{label}</a>))}
        </div>
        <span className="note">{note}</span>
        <span className="size">({size})</span>
    </div>
)

export const DownloadPage: PageFactory<StudioService> = ({lifecycle}: PageContext<StudioService>) => (
    <div className={className} onConnect={host => lifecycle.own(installScrollbars(host))}>
        <header>
            <h1>openDAW Desktop</h1>
            <p>The full studio as an app on your computer. It runs offline and keeps itself up to date.</p>
        </header>
        <div className="platforms">
            <Platform platform="macos" name="macOS" icon={PlatformIcons.Apple} note="Apple Silicon and Intel" size="about 40 MB"
                      downloads={[{label: "Download", file: "openDAW-macos.dmg"}]}/>
            <Platform platform="windows" name="Windows" icon={PlatformIcons.Windows} note="Windows 10 and 11, 64-bit"
                      size="about 20 MB"
                      downloads={[{label: "Download", file: "openDAW-windows-setup.exe"}]}/>
            <Platform platform="linux" name="Linux" icon={PlatformIcons.Linux} note="64-bit"
                      size="AppImage about 90 MB, .deb about 20 MB"
                      downloads={[{label: "AppImage", file: "openDAW-linux.AppImage"}, {label: ".deb", file: "openDAW-linux.deb"}]}/>
        </div>
        <div className="details">
            <section>
                <h3>What is in the download?</h3>
                <p>
                    A small app that hosts the studio and talks to your sound card directly for low and steady
                    latency. It uses the web view your system already has instead of bringing its own browser. The
                    studio, its audio engine, instruments and effects are downloaded on the first launch and update
                    on their own, without a new app download.
                </p>
            </section>
            <section>
                <h3>What happens on the first launch?</h3>
                <ol>
                    <li>The app downloads the complete studio once (about 33 MB), including the parts this website only
                        loads when you use them, like the script editor and Neural Demux. It keeps them on your computer,
                        so it works without internet from then on.</li>
                    <li>It asks whether you also want the models for Neural Demux, the AI stem separation and tempo
                        detection (about 580 MB). You can skip them and add them later.</li>
                    <li>Later updates only download the files that changed.</li>
                </ol>
            </section>
            <section>
                <h3>If your system warns you</h3>
                <p>
                    The app is not signed yet. On macOS, open System Settings, go to Privacy &amp; Security and click
                    "Open Anyway" next to openDAW. On Windows, click "More info" and then "Run anyway".
                </p>
            </section>
        </div>
    </div>
)
