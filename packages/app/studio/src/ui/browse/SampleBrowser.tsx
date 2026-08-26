import css from "./SampleBrowser.sass?inline"
import {Arrays, DefaultObservableValue, Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {SampleStorage} from "@opendaw/studio-core"
import {OpenSampleAPI} from "@/opendaw-api"
import {StudioService} from "@/service/StudioService.ts"
import {SampleView} from "@/ui/browse/SampleView"
import {AssetLocation} from "@/ui/browse/AssetLocation"
import {HTMLSelection} from "@/ui/HTMLSelection"
import {SampleSelection} from "@/ui/browse/SampleSelection"
import {NumberInput} from "@/ui/components/NumberInput"
import {ResourceBrowser} from "@/ui/browse/ResourceBrowser"
import {Sample} from "@opendaw/studio-adapters"
import {SampleIndex, SampleIndexFolder} from "@/opendaw-api/SampleIndex"
import {ResourceBrowserConfig} from "@/ui/browse/ResourceBrowserConfig"
import {ResourceFolder} from "@/ui/browse/ResourceFolder"
import {LocalTree} from "@/ui/browse/LocalTree"

const className = Html.adoptStyleSheet(css, "Samples")

const toResourceFolder = (folder: SampleIndexFolder): ResourceFolder<Sample> => ({
    name: folder.name,
    folders: folder.folders?.map(toResourceFolder) ?? [],
    items: folder.samples?.map(SampleIndex.asSample) ?? []
})

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    background?: boolean
    fontSize?: string // em
}

const location = new DefaultObservableValue(AssetLocation.OpenDAW)
const expandedKeys = new Set<string>()

export const SampleBrowser = ({lifecycle, service, background, fontSize}: Construct) => {
    const linearVolume = service.samplePlayback.linearVolume
    const config: ResourceBrowserConfig<Sample> = {
        name: "samples",
        headers: [
            {label: "Name"},
            {label: "Bpm", align: "right"},
            {label: "Sec", align: "right"}
        ],
        // Structure comes from the published index and nowhere else.
        fetchOnline: async () => ({
            name: "",
            folders: (await OpenSampleAPI.get().tree()).folders.map(toResourceFolder),
            items: []
        }),
        fetchLocal: async () => {
            const openDAW = await OpenSampleAPI.get().all()
            const local = await SampleStorage.get().list()
            return Arrays.subtract(local, openDAW, ({uuid: a}, {uuid: b}) => a === b)
        },
        fetchLocalTree: () => LocalTree.load(SampleStorage.get().structure, (sample: Sample) => sample.uuid),
        expandedKeys,
        dragType: "sample",
        renderEntry: ({
                          lifecycle: entryLifecycle, service: entryService, selection, item, location: loc, tree,
                          refresh
                      }) => (
            <SampleView
                lifecycle={entryLifecycle}
                service={entryService}
                sampleSelection={selection as SampleSelection}
                playback={entryService.samplePlayback}
                sample={item}
                location={loc}
                tree={tree}
                refresh={refresh}
            />
        ),
        resolveEntryName: (sample: Sample) => sample.name,
        resolveEntryUuid: (sample: Sample) => sample.uuid,
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