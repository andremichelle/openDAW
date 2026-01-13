import css from "./ImprintPage.sass?inline"
import {createElement, PageContext, PageFactory} from "@moises-ai/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {Html} from "@moises-ai/lib-dom"
import {Colors} from "@moises-ai/studio-enums"

const className = Html.adoptStyleSheet(css, "ImprintPage")

export const ImprintPage: PageFactory<StudioService> = ({}: PageContext<StudioService>) => (
    <div className={className}>
        <h1>Imprint</h1>
        <h3>In accordance with § 5 TMG (German Telemedia Act)</h3>
        <h4>Responsible for content:</h4>
        <p>
            <span style={{color: Colors.cream.toString()}}>André Michelle</span><br/>
            <span style={{color: Colors.dark.toString()}}>Cologne, Germany</span><br/>
            Email: <a style={{color: Colors.blue}} href="mailto:hello@moises-ai.org">hello@moises-ai.org</a>
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