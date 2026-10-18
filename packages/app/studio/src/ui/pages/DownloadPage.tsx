import css from "./DownloadPage.sass?inline"
import {createElement, PageContext, PageFactory} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {isDefined, Optional} from "@opendaw/lib-std"
import {StudioService} from "@/service/StudioService"
import {installScrollbars} from "@/ui/components/Scrollbars"
import {PlatformIcons} from "@/ui/pages/PlatformIcons"
import {BackButton} from "@/ui/pages/BackButton"

const className = Html.adoptStyleSheet(css, "DownloadPage")

// the installers next to the studio on its own server (dev.opendaw.studio/install for the test builds)
const ReleaseUrl = "/install"

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

const Platform = ({platform, name, icon, note, size, downloads, alternative}: {
    platform: PlatformKey, name: string, icon: string, note: string, size: string, downloads: ReadonlyArray<Download>
    alternative?: Download
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
        {isDefined(alternative) && (<a className="alternative" href={`${ReleaseUrl}/${alternative.file}`}>{alternative.label}</a>)}
    </div>
)

export const DownloadPage: PageFactory<StudioService> = ({lifecycle, service}: PageContext<StudioService>) => (
    <div className={className} onConnect={host => lifecycle.own(installScrollbars(host))}>
        <BackButton service={service}/>
        <header>
            <h1>openDAW Desktop</h1>
            <p>The full studio as an app on your computer. It runs offline and keeps itself up to date.</p>
        </header>
        <div className="platforms">
            <Platform platform="macos" name="macOS" icon={PlatformIcons.Apple} note="Apple Silicon (M1 and later)" size="about 5 MB"
                      downloads={[{label: "Download", file: "openDAW-macos-arm64.dmg"}]}
                      alternative={{label: "Download for Intel Mac", file: "openDAW-macos-intel.dmg"}}/>
            <Platform platform="windows" name="Windows" icon={PlatformIcons.Windows} note="Windows 10 and 11, 64-bit"
                      size="about 3 MB"
                      downloads={[{label: "Download", file: "openDAW-windows-setup.exe"}]}/>
            <Platform platform="linux" name="Linux" icon={PlatformIcons.Linux} note="64-bit, x86 and ARM"
                      size="AppImage about 80 MB, .deb about 5 MB"
                      downloads={[{label: "AppImage", file: "openDAW-linux.AppImage"}, {label: ".deb", file: "openDAW-linux.deb"}]}
                      alternative={{label: "Download for ARM", file: "openDAW-linux-arm64.AppImage"}}/>
        </div>
        <div className="details">
            <section>
                <h3>What is in the download?</h3>
                <p>
                    A small app that hosts the studio and talks to your audio and MIDI devices directly, for low and
                    steady latency. The studio, its audio engine, instruments and effects update themselves inside the
                    app, so you only download the app once.
                </p>
            </section>
            <section>
                <h3>What happens on the first launch?</h3>
                <ol>
                    <li>The app downloads the studio and its audio engine (about 30 MB). You can choose more parts for
                        offline use.</li>
                    <li>Everything stays on your computer, so it works without internet from then on.</li>
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
