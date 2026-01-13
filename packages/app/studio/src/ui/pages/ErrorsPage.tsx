import css from "./ErrorsPage.sass?inline"
import {Await, createElement, Group, PageContext, PageFactory} from "@moises-ai/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {Events, Html} from "@moises-ai/lib-dom"
import {Entry, ErrorEntry} from "@/ui/pages/errors/ErrorEntry"
import {Promises, Wait} from "@moises-ai/lib-runtime"
import {Colors} from "@moises-ai/studio-enums"

const className = Html.adoptStyleSheet(css, "ErrorsPage")
const loadLimit = 100

export const ErrorsPage: PageFactory<StudioService> = ({lifecycle}: PageContext<StudioService>) => {
    let offset = 0
    const loadMore = () => fetch(`https://logs.opendaw.studio/list.php?offset=${offset}&limit=${loadLimit}`)
        .then(response => {
            offset += loadLimit
            return response.json()
        })
        .then(entries => entries as ReadonlyArray<Entry>, () => [])
    return (
        <div className={className}>
            <h1>Errors</h1>
            <p>This page shows all errors reported from users running openDAW in production, helping us identify and fix
                issues.</p>
            <h5>Report any issues <a href="https://github.com/andremichelle/opendaw/issues/"
                                    target="github"
                                    style={{color: Colors.blue}}
            >here</a>.</h5>
            <code onInit={async element => {
                element.textContent = "loading status..."
                element.textContent = await fetch("https://logs.opendaw.studio/status.php").then(x => x.json())
                    .then(x => Object.entries(x).map(([key, value]) => `${key}: ${value}`).join(", "))
            }} style={{fontSize: "10px", marginBottom: "1em", color: Colors.blue.toString()}}/>
            <Await
                factory={() => loadMore()}
                failure={(error) => `Unknown request (${error.reason})`}
                loading={() => <p>loading...</p>}
                success={(entries: ReadonlyArray<Entry>) => {
                    const list: HTMLElement = (
                        <div className="list">
                            <Group>
                                <h4>#</h4>
                                <h4>Time</h4>
                                <h4>Build</h4>
                                <h4>Type</h4>
                                <h4>Message</h4>
                                <h4>JS</h4>
                                <h4>Browser</h4>
                                <h4>Stack</h4>
                                <h4>Logs</h4>
                                <h4>Fixed</h4>
                            </Group>
                        </div>
                    )
                    const wrapper: HTMLElement = (<div className="list-wrapper">{list}</div>)
                    const createRows = (entries: ReadonlyArray<Entry>) =>
                        list.append(...entries.map((entry: Entry) => (<ErrorEntry entry={entry}/>)))
                    createRows(entries)
                    ;(async () => {
                        await Wait.frame()
                        while (list.scrollHeight < wrapper.clientHeight) {
                            const entries: ReadonlyArray<Entry> = await loadMore()
                            if (entries.length === 0) return
                            createRows(entries)
                            await Wait.frame()
                        }
                        const subscription = Events.subscribe(wrapper, "scroll", Promises.sequentialize(async () => {
                            const threshold = 64
                            if (wrapper.scrollTop + wrapper.clientHeight >= list.scrollHeight - threshold) {
                                const entries: ReadonlyArray<Entry> = await loadMore()
                                if (entries.length > 0) {
                                    createRows(entries)
                                } else {
                                    subscription.terminate()
                                }
                            }
                        }))
                        lifecycle.own(subscription)
                    })()
                    return wrapper
                }}/>
        </div>
    )
}