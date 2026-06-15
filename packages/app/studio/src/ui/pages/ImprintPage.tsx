import css from "./ImprintPage.sass?inline"
import {createElement, PageContext, PageFactory} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {Html} from "@opendaw/lib-dom"
import {Colors} from "@opendaw/studio-enums"
import {installScrollbars} from "@/ui/components/Scrollbars"

const className = Html.adoptStyleSheet(css, "ImprintPage")

export const ImprintPage: PageFactory<StudioService> = ({lifecycle}: PageContext<StudioService>) => (
    <div className={className} onConnect={host => lifecycle.own(installScrollbars(host))}>
        <h1>Imprint</h1>
        <h3>In accordance with § 5 TMG (German Telemedia Act)</h3>
        <h4>Responsible for content:</h4>
        <p>
            <span style={{color: Colors.cream.toString()}}>André Michelle</span><br/>
            <span style={{color: Colors.dark.toString()}}>Cologne, Germany</span><br/>
            Email: <a style={{color: Colors.blue}} href="mailto:hello@opendaw.org">hello@opendaw.org</a>
        </p>
        <p>
            This website is a personal, non-commercial project.<br/>
            <span style={{color: Colors.red.toString()}}>No tracking, no data collection, no user accounts.</span>
        </p>
        <p>
            This imprint is provided to comply with German law.<br/>
        </p>
        <p>
            For inquiries regarding openDAW, please use the contact above or visit <a style={{color: Colors.blue}}
                                                                                      href="https://opendaw.org">opendaw.org</a>
        </p>
    </div>
)