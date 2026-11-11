import css from "./ChangelogPage.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {isDefined} from "@opendaw/lib-std"
import {createElement, PageContext, PageFactory} from "@opendaw/lib-jsx"
import {Markdown} from "@opendaw/studio-markdown"
import {StudioService} from "@/service/StudioService.ts"
import {installScrollbars} from "@/ui/components/Scrollbars"
import {BackButton} from "@/ui/pages/BackButton"

const className = Html.adoptStyleSheet(css, "ChangelogPage")

type Release = { version: Array<number>, load: () => Promise<string> }

const releases: ReadonlyArray<Release> = Object
    .entries(import.meta.glob<string>("../../../../../../releases/*.md", {query: "?raw", import: "default"}))
    .map(([path, load]) => ({
        version: path.slice(path.lastIndexOf("/") + 1, -3).split(".").map(Number),
        load
    }))
    .sort((left, right) => {
        const length = Math.max(left.version.length, right.version.length)
        for (let index = 0; index < length; index++) {
            const delta = (right.version[index] ?? 0) - (left.version[index] ?? 0)
            if (delta !== 0) {return delta}
        }
        return 0
    })

export const ChangelogPage: PageFactory<StudioService> = ({lifecycle, service}: PageContext<StudioService>) => {
    const entries: HTMLElement = <div className="entries"/>
    const sentinel: HTMLElement = <div className="sentinel">Loading…</div>
    let alive = true
    let nextIndex = 0
    let loading = false
    const loadNext = (): void => {
        if (loading) {return}
        const release = releases[nextIndex]
        if (!isDefined(release)) {
            sentinel.classList.add("hidden")
            return
        }
        loading = true
        nextIndex++
        release.load().then(text => {
            if (!alive) {return}
            entries.appendChild(<article><Markdown text={text}/></article>)
            loading = false
            requestAnimationFrame(() => {if (isVisible()) {loadNext()}})
        }, reason => {
            loading = false
            sentinel.textContent = `Could not load the changelog (${reason})`
        })
    }
    const host: HTMLElement = (
        <div className={className}>
            <BackButton lifecycle={lifecycle} service={service}/>
            <div className="content">
                {entries}
                {sentinel}
            </div>
        </div>
    )
    const isVisible = (): boolean =>
        sentinel.getBoundingClientRect().top < host.getBoundingClientRect().bottom + host.clientHeight
    const observer = new IntersectionObserver(observed => {
        if (observed.some(entry => entry.isIntersecting)) {loadNext()}
    }, {root: host, rootMargin: "0px 0px 100% 0px"})
    observer.observe(sentinel)
    lifecycle.own({
        terminate: () => {
            alive = false
            observer.disconnect()
        }
    })
    lifecycle.own(installScrollbars(host))
    return host
}
