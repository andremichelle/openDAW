import css from "./ManifestoPage.sass?inline"
import {Await, createElement, PageContext, PageFactory} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {Html} from "@opendaw/lib-dom"
import {Markdown} from "@opendaw/studio-markdown"
import {installScrollbars} from "@/ui/components/Scrollbars"

const className = Html.adoptStyleSheet(css, "ManifestoPage")

const loadManifesto = (): Promise<string> =>
    fetch(`${import.meta.env.BASE_URL}manifesto.md`, {cache: "no-store"}).then(response => {
        if (!response.ok) {return Promise.reject(response.statusText)}
        return response.text()
    })

export const ManifestoPage: PageFactory<StudioService> = ({lifecycle}: PageContext<StudioService>) => (
    <div className={className} onConnect={host => lifecycle.own(installScrollbars(host))}>
        <div className="content">
            <Await factory={loadManifesto}
                   failure={({reason}) => `Could not load the manifesto (${reason})`}
                   loading={() => <p>Loading…</p>}
                   success={text => <Markdown text={text}/>}/>
        </div>
    </div>
)
