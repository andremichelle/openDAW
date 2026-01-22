import css from "./SampleBrowser.sass?inline"
import {DefaultObservableValue, Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {OpenSampleAPI, SampleStorage} from "@opendaw/studio-core"
import {StudioService} from "@/service/StudioService.ts"
import {SampleView} from "@/ui/browse/SampleView"
import {AssetLocation} from "@/ui/browse/AssetLocation"
import {HTMLSelection} from "@/ui/HTMLSelection"
import {SampleSelection} from "@/ui/browse/SampleSelection"
import {NumberInput} from "@/ui/components/NumberInput"
import {ResourceBrowser} from "@/ui/browse/ResourceBrowser"
import {Sample} from "@opendaw/studio-adapters"
import {ResourceBrowserConfig} from "@/ui/browse/ResourceBrowserConfig"

const className = Html.adoptStyleSheet(css, "Samples")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    background?: boolean
    fontSize?: string // em
}

const location = new DefaultObservableValue(AssetLocation.OpenDAW)

export const SampleBrowser = ({lifecycle, service, background, fontSize}: Construct) => {
    const linearVolume = service.samplePlayback.linearVolume
    const config: ResourceBrowserConfig<Sample> = {
        name: "samples",
        headers: [
            {label: "Name"},
            {label: "Bpm", align: "right"},
            {label: "Sec", align: "right"}
        ],
        fetchOnline: () => OpenSampleAPI.get().all(),
        fetchLocal: () => SampleStorage.get().list(),
        renderEntry: ({lifecycle: entryLifecycle, service: entryService, selection, item, location: loc, refresh}) => (
            <SampleView
                lifecycle={entryLifecycle}
                service={entryService}
                sampleSelection={selection as SampleSelection}
                playback={entryService.samplePlayback}
                sample={item}
                location={loc}
                refresh={refresh}
            />
        ),
        resolveEntryName: (sample: Sample) => sample.name,
        createSelection: (svc: StudioService, htmlSelection: HTMLSelection) => new SampleSelection(svc, htmlSelection),
        importSignal: "import-sample",
        footer: ({lifecycle: footerLifecycle}) => (
            <div className="footer">
                <label>Volume:</label>
                <NumberInput lifecycle={footerLifecycle} maxChars={3} step={1} model={linearVolume}/>
                <label>dB</label>
            </div>
        ),
        onReload: () => service.samplePlayback.eject(),
        onTerminate: () => service.samplePlayback.eject()
    }
    return (
        <ResourceBrowser
            lifecycle={lifecycle}
            service={service}
            config={config}
            className={className}
            background={background}
            fontSize={fontSize}
            location={location}
        />
    )
}