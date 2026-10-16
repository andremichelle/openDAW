import css from "./DownloadPage.sass?inline"
import {createElement, PageContext, PageFactory} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {StudioService} from "@/service/StudioService"
import {installScrollbars} from "@/ui/components/Scrollbars"

const className = Html.adoptStyleSheet(css, "DownloadPage")

const ReleaseUrl = "https://github.com/andremichelle/openDAW/releases/latest/download"

export const DownloadPage: PageFactory<StudioService> = ({lifecycle}: PageContext<StudioService>) => (
    <div className={className} onConnect={host => lifecycle.own(installScrollbars(host))}>
        <h1>openDAW Desktop</h1>
        <p className="lead">The full studio as an app on your computer. It runs offline and keeps itself up to date.</p>
        <div className="platforms">
            <div className="platform">
                <h2>macOS</h2>
                <a className="download" href={`${ReleaseUrl}/openDAW-macos.dmg`}>Download</a>
                <span className="size">about 9 MB, Apple Silicon and Intel</span>
            </div>
            <div className="platform unavailable">
                <h2>Windows</h2>
                <span className="download">Coming soon</span>
            </div>
            <div className="platform unavailable">
                <h2>Linux</h2>
                <span className="download">Coming soon</span>
            </div>
        </div>
        <h3>Why is it so small?</h3>
        <p>
            The download is only the app around the studio. It uses the web view your system already has instead of
            bringing its own browser, which keeps it at a few megabytes.
        </p>
        <h3>What happens on the first launch?</h3>
        <ol>
            <li>The app downloads the studio itself (about 51 MB, the same files as this website) and keeps it on
                your computer, so it works without internet from then on.</li>
            <li>It asks whether you also want the models for Neural Demux, the AI stem separation and tempo detection
                (about 580 MB). You can skip them and add them later. Without them, Neural Demux needs an internet
                connection.</li>
            <li>Later updates only download the files that changed.</li>
        </ol>
        <h3>If macOS blocks the app</h3>
        <p>
            The app is not notarized by Apple yet. If macOS says it cannot be opened, open System Settings, go to
            Privacy &amp; Security and click "Open Anyway" next to openDAW.
        </p>
    </div>
)
