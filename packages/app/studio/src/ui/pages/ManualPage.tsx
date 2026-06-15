import css from "./ManualPage.sass?inline"
import {Await, createElement, Frag, LocalLink, PageContext, PageFactory, RouteLocation} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {ThreeDots} from "@/ui/spinner/ThreeDots"
import {BackButton} from "@/ui/pages/BackButton"
import {Markdown} from "@/ui/Markdown"
import {Manual, Manuals} from "@/ui/pages/Manuals"
import {Html} from "@opendaw/lib-dom"
import {CloudBackup, MenuItem} from "@opendaw/studio-core"
import {EmptyExec, panic} from "@opendaw/lib-std"
import {network} from "@opendaw/lib-runtime"
import {installScrollbars} from "@/ui/components/Scrollbars"

const className = Html.adoptStyleSheet(css, "ManualPage")

const addManuals = (manuals: ReadonlyArray<Manual>): ReadonlyArray<MenuItem> => manuals.map(manual => {
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

export const ManualPage: PageFactory<StudioService> = ({lifecycle, service, path}: PageContext<StudioService>) => {
    return (
        <div className={className}>
            <aside onConnect={host => lifecycle.own(installScrollbars(host))}>
                <BackButton/>
                <nav>
                    <LocalLink href="/manuals/">⇱</LocalLink>
                    <hr/>
                    {addManuals(Manuals)}
                </nav>
            </aside>
            <div className="manual" onConnect={host => lifecycle.own(installScrollbars(host))}>
                {path === "/manuals/" ? (<p>Select a topic in the side bar...</p>) : (<Await
                    factory={() => network.defaultFetch(`${path ?? "index"}.md?uuid=${service.buildInfo.uuid}`)
                        .then(x => x.text())}
                    failure={(error) => `Unknown request (${error.reason})`}
                    loading={() => <ThreeDots/>}
                    success={text => <Markdown text={text} actions={{
                        "open-preferences": () => RouteLocation.get().navigateTo("/preferences"),
                        "backup-google-drive": () => CloudBackup.backup(service.cloudAuthManager, "GoogleDrive").catch(EmptyExec),
                        "backup-dropbox": () => CloudBackup.backup(service.cloudAuthManager, "Dropbox").catch(EmptyExec)
                    }}/>}
                />)}
            </div>
        </div>
    )
}