import css from "./SampleBrowser.sass?inline"
import {DefaultObservableValue, Lifecycle, RuntimeSignal, StringComparator, Terminator} from "@opendaw/lib-std"
import {Await, createElement, Hotspot, HotspotUpdater, Inject, replaceChildren} from "@opendaw/lib-jsx"
import {Events, Html, Keyboard} from "@opendaw/lib-dom"
import {Runtime} from "@opendaw/lib-runtime"
import {IconSymbol} from "@opendaw/studio-enums"
import {OpenSampleAPI, ProjectSignals, SampleStorage} from "@opendaw/studio-core"
import {StudioService} from "@/service/StudioService.ts"
import {ThreeDots} from "@/ui/spinner/ThreeDots.tsx"
import {SearchInput} from "@/ui/components/SearchInput"
import {SampleView} from "@/ui/browse/SampleView"
import {RadioGroup} from "../components/RadioGroup"
import {Icon} from "../components/Icon"
import {AssetLocation} from "@/ui/browse/AssetLocation"
import {HTMLSelection} from "@/ui/HTMLSelection"
import {SampleSelection} from "@/ui/browse/SampleSelection"
import {NumberInput} from "@/ui/components/NumberInput"

const className = Html.adoptStyleSheet(css, "Samples")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    background?: boolean
    fontSize?: string // em
}

const location = new DefaultObservableValue(AssetLocation.OpenDAW)

export const SampleBrowser = ({lifecycle, service, background, fontSize}: Construct) => {
    const entries: HTMLElement = <div className="scrollable"/>
    const selection = lifecycle.own(new HTMLSelection(entries))
    const sampleSelection = new SampleSelection(service, selection)
    const entriesLifeSpan = lifecycle.own(new Terminator())
    const reload = Inject.ref<HotspotUpdater>()
    const filter = new DefaultObservableValue("")
    const linearVolume = service.samplePlayback.linearVolume
    const element: Element = (
        <div className={Html.buildClassList(className, background && "background")} tabIndex={-1} style={{fontSize}}>
            <div className="filter">
                <RadioGroup lifecycle={lifecycle} model={location} elements={[
                    {
                        value: AssetLocation.OpenDAW,
                        element: <Icon symbol={IconSymbol.CloudFolder}/>,
                        tooltip: "Online samples"
                    },
                    {
                        value: AssetLocation.Local,
                        element: <Icon symbol={IconSymbol.UserFolder}/>,
                        tooltip: "Locally stored samples"
                    }
                ]} appearance={{framed: true, landscape: true}}/>
                <SearchInput lifecycle={lifecycle} model={filter} style={{gridColumn: "1 / -1"}}/>
            </div>
            <header>
                <span>Name</span>
                <span className="right">Bpm</span>
                <span className="right">Sec</span>
            </header>
            <div className="content">
                <Hotspot ref={reload} render={() => {
                    service.samplePlayback.eject()
                    entriesLifeSpan.terminate()
                    return (
                        <Await
                            factory={async () => {
                                switch (location.getValue()) {
                                    case AssetLocation.OpenDAW:
                                        return OpenSampleAPI.get().all()
                                    case AssetLocation.Local:
                                        return SampleStorage.get().list()
                                }
                            }}
                            loading={() => (<div><ThreeDots/></div>)}
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
                                        .map(sample => (
                                            <SampleView lifecycle={entriesLifeSpan}
                                                        service={service}
                                                        sampleSelection={sampleSelection}
                                                        playback={service.samplePlayback}
                                                        sample={sample}
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
                                }, "import-sample"))
                                return entries
                            }}/>
                    )
                }}>
                </Hotspot>
            </div>
            <div className="footer">
                <label>Volume:</label>
                <NumberInput lifecycle={lifecycle} maxChars={3} step={1} model={linearVolume}/>
                <label>dB</label>
            </div>
        </div>
    )
    lifecycle.ownAll(
        location.subscribe(() => reload.get().update()),
        RuntimeSignal.subscribe(signal => signal === ProjectSignals.StorageUpdated && reload.get().update()),
        {terminate: () => service.samplePlayback.eject()},
        Events.subscribe(element, "keydown", async event => {
            if (Keyboard.isDelete(event) && location.getValue() === AssetLocation.Local) {
                await sampleSelection.deleteSelected()
                reload.get().update()
            }
        })
    )
    return element
}