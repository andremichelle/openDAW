import css from "./ManualPage.sass?inline"
import {Await, createElement, Frag, LocalLink, PageContext, PageFactory} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {ThreeDots} from "@/ui/spinner/ThreeDots"
import {BackButton} from "@/ui/pages/BackButton"
import {Markdown} from "@opendaw/studio-markdown"
import {Manual, Manuals, manualsMarkdownHref} from "@opendaw/manuals"
import {Html} from "@opendaw/lib-dom"
import {panic} from "@opendaw/lib-std"
import {IconSymbol} from "@opendaw/studio-enums"
import {installScrollbars} from "@/ui/components/Scrollbars"
import {Surface} from "@/ui/surface/Surface"

const className = Html.adoptStyleSheet(css, "ManualPage")

const addManuals = (manuals: ReadonlyArray<Manual>) => manuals.map(manual => {
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

export const ManualPage: PageFactory<StudioService> = ({lifecycle, service, path}: PageContext<StudioService>) => {
    return (
        <div className={className}>
            <aside onConnect={host => lifecycle.own(installScrollbars(host))}>
                <BackButton service={service}/>
                <nav>
                    <LocalLink href="/manuals/">⇱</LocalLink>
                    <hr/>
                    {addManuals(Manuals)}
                </nav>
            </aside>
            <div className="manual" onConnect={host => lifecycle.own(installScrollbars(host))}>
                <Await
                    factory={() => loadMarkdown(path)}
                    failure={(error) => `Unknown request (${error.reason})`}
                    loading={() => <ThreeDots/>}
                    success={text => <Markdown text={text} onCopied={element =>
                        Surface.get(element).toast("Copied to clipboard", IconSymbol.Copy)}/>}
                />
            </div>
        </div>
    )
}
