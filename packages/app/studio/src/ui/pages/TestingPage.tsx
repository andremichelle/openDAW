import css from "./TestingPage.sass?inline"
import {createElement, PageContext, PageFactory} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {StudioService} from "@/service/StudioService"
import {installScrollbars} from "@/ui/components/Scrollbars"
import {BackButton} from "@/ui/pages/BackButton"
import {SamplerPreview} from "@/ui/pages/testing/SamplerPreview"

const className = Html.adoptStyleSheet(css, "TestingPage")

// previews of unreleased devices, built from the studio's own components with just enough function to try them
export const TestingPage: PageFactory<StudioService> = ({lifecycle, service}: PageContext<StudioService>) => (
    <div className={className} onConnect={host => lifecycle.own(installScrollbars(host))}>
        <BackButton lifecycle={lifecycle} service={service}/>
        <h1>Testing</h1>
        <section>
            <h2>Sampler</h2>
            <SamplerPreview lifecycle={lifecycle}/>
        </section>
    </div>
)
