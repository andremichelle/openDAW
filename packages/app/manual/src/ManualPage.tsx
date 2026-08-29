import css from "./ManualPage.sass?inline"
import {Await, createElement, Frag, JsxValue, LocalLink, PageContext, PageFactory} from "@opendaw/lib-jsx"
import {Markdown} from "@opendaw/studio-markdown"
import {Manual, Manuals, manualsMarkdownHref} from "@opendaw/manuals"
import {Html} from "@opendaw/lib-dom"
import {panic} from "@opendaw/lib-std"

const className = Html.adoptStyleSheet(css, "ManualPage")

const addManuals = (manuals: ReadonlyArray<Manual>): ReadonlyArray<JsxValue> =>
    manuals.map(manual => {
        if (manual.type === "page") {
            return (
                <Frag>
                    {manual.separatorBefore && <hr/>}
                    <LocalLink href={manual.path}>{manual.label}</LocalLink>
                </Frag>
            )
        } else if (manual.type === "folder") {
            return (
                <Frag>
                    {manual.separatorBefore && <hr/>}
                    <details open>
                        <summary>{manual.label}</summary>
                        <nav>{...addManuals(manual.files)}</nav>
                    </details>
                </Frag>
            )
        } else {
            return panic()
        }
    })

const loadMarkdown = (path: string): Promise<string> =>
    fetch(manualsMarkdownHref(path), {cache: "no-store"}).then(response => {
        if (!response.ok) {return Promise.reject(response.statusText)}
        return response.text()
    })

export const ManualPage: PageFactory<null> = ({path}: PageContext<null>) => (
    <div className={className}>
        <aside>
            <a className="studio" href="/">openDAW Studio</a>
            <nav>
                <LocalLink href="/manuals/">⇱</LocalLink>
                <hr/>
                {addManuals(Manuals)}
            </nav>
        </aside>
        <div className="manual">
            <Await
                factory={() => loadMarkdown(path)}
                failure={(error) => `Unknown request (${error.reason})`}
                loading={() => <p>Loading…</p>}
                success={text => <Markdown text={text}/>}
            />
        </div>
    </div>
)
