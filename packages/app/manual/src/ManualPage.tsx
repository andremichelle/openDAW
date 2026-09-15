import css from "./ManualPage.sass?inline"
import {Await, createElement, Frag, JsxValue, PageContext, PageFactory, RouteLocation} from "@opendaw/lib-jsx"
import {Markdown} from "@opendaw/studio-markdown"
import {Manual, ManualFolderEntry, ManualPageEntry, Manuals, manualsMarkdownHref} from "./Manuals"
import {Html} from "@opendaw/lib-dom"
import {isDefined, Lifecycle, panic} from "@opendaw/lib-std"
import {Icon} from "@opendaw/studio-icons"

const className = Html.adoptStyleSheet(css, "ManualPage")

const trimSlash = (path: string): string => path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path

const PageLink = ({lifecycle, manual}: { lifecycle: Lifecycle, manual: ManualPageEntry }) => {
    const link: HTMLAnchorElement = (
        <a className="page" href={manual.path} onclick={(event: Event) => {
            event.preventDefault()
            RouteLocation.get().navigateTo(manual.path)
        }}>
            {isDefined(manual.icon) && <Icon symbol={manual.icon}/>}
            <span className="name">{manual.label}</span>
        </a>
    )
    lifecycle.own(RouteLocation.get().catchupAndSubscribe(location =>
        link.classList.toggle("active", trimSlash(location.path) === trimSlash(manual.path))))
    return link
}

const Folder = ({lifecycle, manual}: { lifecycle: Lifecycle, manual: ManualFolderEntry }) => {
    const list: HTMLElement = <div className="list">{...addManuals(lifecycle, manual.files)}</div>
    const item: HTMLElement = (
        <div className="folder expanded">
            <div className="header" onclick={() => {
                const hidden = list.classList.toggle("hidden")
                item.classList.toggle("expanded", !hidden)
            }}>
                <span className="triangle"/>
                {isDefined(manual.icon) && <Icon symbol={manual.icon}/>}
                <span className="name">{manual.label}</span>
            </div>
            {list}
        </div>
    )
    return item
}

const addManuals = (lifecycle: Lifecycle, manuals: ReadonlyArray<Manual>): ReadonlyArray<JsxValue> =>
    manuals.map(manual => {
        if (manual.type === "page") {
            return (
                <Frag>
                    {manual.separatorBefore && <hr/>}
                    <PageLink lifecycle={lifecycle} manual={manual}/>
                </Frag>
            )
        } else if (manual.type === "folder") {
            return (
                <Frag>
                    {manual.separatorBefore && <hr/>}
                    <Folder lifecycle={lifecycle} manual={manual}/>
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

export const ManualPage: PageFactory<null> = ({lifecycle, path}: PageContext<null>) => (
    <div className={className}>
        <aside>
            <nav>{...addManuals(lifecycle, Manuals)}</nav>
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
