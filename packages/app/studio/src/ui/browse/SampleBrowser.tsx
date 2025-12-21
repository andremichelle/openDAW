import css from "./SampleBrowser.sass?inline"
import {clamp, DefaultObservableValue, Lifecycle, RuntimeSignal, StringComparator, Terminator} from "@opendaw/lib-std"
import {Await, createElement, Frag, Hotspot, HotspotUpdater, Inject, replaceChildren} from "@opendaw/lib-jsx"
import {Events, Html, Keyboard} from "@opendaw/lib-dom"
import {Runtime} from "@opendaw/lib-runtime"
import {IconSymbol} from "@opendaw/studio-enums"
import {OpenSampleAPI, ProjectSignals, SampleStorage} from "@opendaw/studio-core"
import {StudioService} from "@/service/StudioService.ts"
import {ThreeDots} from "@/ui/spinner/ThreeDots.tsx"
import {Button} from "@/ui/components/Button.tsx"
import {SearchInput} from "@/ui/components/SearchInput"
import {SampleView} from "@/ui/browse/SampleView"
import {RadioGroup} from "../components/RadioGroup"
import {Icon} from "../components/Icon"
import {AssetLocation} from "@/ui/browse/AssetLocation"
import {HTMLSelection} from "@/ui/HTMLSelection"
import {SampleSelection} from "@/ui/browse/SampleSelection"

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
    const slider: HTMLInputElement = <input type="range" min="0.0" max="1.0" step="0.001"/>
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
            <div className="content">
                <Hotspot ref={reload} render={() => {
                    service.samplePlayback.eject()
                    entriesLifeSpan.terminate()
                    return (
                        <Await factory={async () => {
                            switch (location.getValue()) {
                                case AssetLocation.Local:
                                    return SampleStorage.get().list()
                                case AssetLocation.OpenDAW:
                                    return OpenSampleAPI.get().all()
                            }
                        }} loading={() => (
                            <div className="loading">
                                <ThreeDots/>
                            </div>
                        )} failure={({reason, retry}) => (
                            <div className="error">
                                <span>{reason.message}</span>
                                <Button lifecycle={lifecycle} onClick={retry} appearance={{framed: true}}>RETRY</Button>
                            </div>
                        )} success={(result) => {
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
                            return (
                                <Frag>
                                    <header>
                                        <span>Name</span>
                                        <span className="right">Bpm</span>
                                        <span className="right">Sec</span>
                                    </header>
                                    {entries}
                                </Frag>
                            )
                        }}/>
                    )
                }}>
                </Hotspot>
            </div>
            <div className="footer">
                <label>Volume</label> {slider}
            </div>
        </div>
    )
    lifecycle.ownAll(
        location.subscribe(() => reload.get().update()),
        RuntimeSignal.subscribe(signal => signal === ProjectSignals.StorageUpdated && reload.get().update()),
        {terminate: () => service.samplePlayback.eject()},
        Events.subscribe(slider, "input",
            () => linearVolume.setValue(clamp(slider.valueAsNumber, 0.0, 1.0))),
        linearVolume.catchupAndSubscribe(owner => slider.valueAsNumber = owner.getValue()),
        Events.subscribe(element, "keydown", async event => {
            if (Keyboard.isDelete(event) && location.getValue() === AssetLocation.Local) {
                await sampleSelection.deleteSelected()
                reload.get().update()
            }
        })
    )
    return element
}