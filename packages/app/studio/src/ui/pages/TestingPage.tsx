import css from "./TestingPage.sass?inline"
import {createElement, PageContext, PageFactory} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {StudioService} from "@/service/StudioService"
import {installScrollbars} from "@/ui/components/Scrollbars"
import {BackButton} from "@/ui/pages/BackButton"

const className = Html.adoptStyleSheet(css, "TestingPage")

// previews of unreleased devices, built from the studio's own components with just enough function to try them
export const TestingPage: PageFactory<StudioService> = ({lifecycle, service}: PageContext<StudioService>) => (
    <div className={className} onConnect={host => lifecycle.own(installScrollbars(host))}>
        <BackButton lifecycle={lifecycle} service={service}/>
        <h1>Testing</h1>
        <p>No previews at the moment. The Sampler is built, add it from the instrument list.</p>
    </div>
)
