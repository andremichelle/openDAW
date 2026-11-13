import css from "./TestingPage.sass?inline"
import {createElement, PageContext, PageFactory} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {StudioService} from "@/service/StudioService"
import {installScrollbars} from "@/ui/components/Scrollbars"
import {BackButton} from "@/ui/pages/BackButton"
import {SurgeonPreview} from "@/ui/pages/testing/SurgeonPreview"

const className = Html.adoptStyleSheet(css, "TestingPage")

// previews of unreleased devices, built from the studio's own components with just enough function to try them
export const TestingPage: PageFactory<StudioService> = ({lifecycle, service}: PageContext<StudioService>) => (
    <div className={className} onConnect={host => lifecycle.own(installScrollbars(host))}>
        <BackButton lifecycle={lifecycle} service={service}/>
        <h1>Testing</h1>
        <section>
            <h2>Surgeon</h2>
            <p>A draft of the editor, played by the real engine. Drag a value up or down or double click to type. Click a
                pattern or Off while it plays and it takes over at the next bar. Right click a pattern to copy or
                paste.</p>
            <SurgeonPreview lifecycle={lifecycle} audioContext={service.audioContext}/>
        </section>
    </div>
)
