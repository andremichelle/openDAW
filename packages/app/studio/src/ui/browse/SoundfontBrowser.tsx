import css from "./SoundfontBrowser.sass?inline"
import {Arrays, DefaultObservableValue, Lifecycle, RuntimeSignal, StringComparator, Terminator} from "@opendaw/lib-std"
import {Await, createElement, Hotspot, HotspotUpdater, Inject, replaceChildren} from "@opendaw/lib-jsx"
import {Events, Html, Keyboard} from "@opendaw/lib-dom"
import {Runtime} from "@opendaw/lib-runtime"
import {IconSymbol} from "@opendaw/studio-enums"
import {OpenSoundfontAPI, ProjectSignals, SoundfontStorage} from "@opendaw/studio-core"
import {StudioService} from "@/service/StudioService.ts"
import {ThreeDots} from "@/ui/spinner/ThreeDots.tsx"
import {SearchInput} from "@/ui/components/SearchInput"
import {SoundfontView} from "@/ui/browse/SoundfontView"
import {RadioGroup} from "../components/RadioGroup"
import {Icon} from "../components/Icon"
import {AssetLocation} from "@/ui/browse/AssetLocation"
import {HTMLSelection} from "@/ui/HTMLSelection"
import {SoundfontSelection} from "@/ui/browse/SoundfontSelection"

const className = Html.adoptStyleSheet(css, "SoundfontBrowser")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    background?: boolean
    fontSize?: string // em
}

const location = new DefaultObservableValue(AssetLocation.OpenDAW)

export const SoundfontBrowser = ({lifecycle, service, background, fontSize}: Construct) => {
    const entries: HTMLElement = <div className="scrollable"/>
    const selection = lifecycle.own(new HTMLSelection(entries))
    const soundfontSelection = new SoundfontSelection(service, selection)
    const entriesLifeSpan = lifecycle.own(new Terminator())
    const reload = Inject.ref<HotspotUpdater>()
    const filter = new DefaultObservableValue("")
    const searchInput: HTMLInputElement = <SearchInput lifecycle={lifecycle} model={filter}/>
    const element: Element = (
        <div className={Html.buildClassList(className, background && "background")} tabIndex={-1} style={{fontSize}}>
            <div className="filter">
                <RadioGroup lifecycle={lifecycle} model={location} elements={[
                    {
                        value: AssetLocation.OpenDAW,
                        element: <Icon symbol={IconSymbol.CloudFolder}/>,
                        tooltip: "Online soundfonts"
                    },
                    {
                        value: AssetLocation.Local,
                        element: <Icon symbol={IconSymbol.UserFolder}/>,
                        tooltip: "Locally stored soundfonts"
                    }
                ]} appearance={{framed: true, landscape: true}}/>
                {searchInput}
            </div>
            <header>
                <span>Name</span>
                <span style={{textAlign: "right"}}>Size</span>
            </header>
            <div className="content">
                <Hotspot ref={reload} render={() => {
                    entriesLifeSpan.terminate()
                    return (
                        <Await
                            factory={async () => {
                                switch (location.getValue()) {
                                    case AssetLocation.Local:
                                        const openDAW = await OpenSoundfontAPI.get().all()
                                        const user = await SoundfontStorage.get().list()
                                        return Arrays.subtract(user, openDAW, ({uuid: a}, {uuid: b}) => a == b)
                                    case AssetLocation.OpenDAW:
                                        return OpenSoundfontAPI.get().all()
                                }
                            }}
                            loading={() => (
                                <div className="loading">
                                    <ThreeDots/>
                                </div>
                            )}
                            failure={({reason, retry}) => (
                                <div className="error" onclick={retry}>
                                    {reason instanceof DOMException ? reason.name : String(reason)}
                                </div>
                            )}
                            success={(result) => {
                                const update = () => {
                                    entriesLifeSpan.terminate()
                                    selection.clear()
                                    replaceChildren(entries, result
                                        .filter(({name}) => name.toLowerCase().includes(filter.getValue().toLowerCase()))
                                        .toSorted((a, b) => StringComparator(a.name.toLowerCase(), b.name.toLowerCase()))
                                        .map(soundfont => (
                                            <SoundfontView lifecycle={entriesLifeSpan}
                                                           service={service}
                                                           soundfontSelection={soundfontSelection}
                                                           soundfont={soundfont}
                                                           location={location.getValue()}
                                                           refresh={() => reload.get().update()}
                                            />
                                        )))
                                }
                                lifecycle.own(filter.catchupAndSubscribe(update))
                                lifecycle.own(service.subscribeSignal(() => {
                                    Runtime.debounce(() => {
                                        location.setValue(AssetLocation.Local)
                                        reload.get().update()
                                    }, 500)
                                }, "import-soundfont"))
                                searchInput.focus()
                                return entries
                            }}/>
                    )
                }}>
                </Hotspot>
            </div>
        </div>
    )
    lifecycle.ownAll(
        location.subscribe(() => reload.get().update()),
        RuntimeSignal.subscribe(signal => signal === ProjectSignals.StorageUpdated && reload.get().update()),
        Events.subscribe(element, "keydown", async event => {
            if (Events.isTextInput(event.target)) {return}
            if (Keyboard.isDelete(event) && location.getValue() === AssetLocation.Local) {
                await soundfontSelection.deleteSelected()
                reload.get().update()
            }
        })
    )
    return element
}