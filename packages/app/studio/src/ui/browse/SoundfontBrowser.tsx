import css from "./SoundfontBrowser.sass?inline"
import {Arrays, DefaultObservableValue, Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {OpenSoundfontAPI, SoundfontStorage} from "@opendaw/studio-core"
import {StudioService} from "@/service/StudioService.ts"
import {SoundfontView} from "@/ui/browse/SoundfontView"
import {AssetLocation} from "@/ui/browse/AssetLocation"
import {HTMLSelection} from "@/ui/HTMLSelection"
import {SoundfontSelection} from "@/ui/browse/SoundfontSelection"
import {ResourceBrowser} from "@/ui/browse/ResourceBrowser"
import {Soundfont} from "@opendaw/studio-adapters"
import {ResourceBrowserConfig} from "@/ui/browse/ResourceBrowserConfig"

const className = Html.adoptStyleSheet(css, "SoundfontBrowser")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    background?: boolean
    fontSize?: string // em
}

const location = new DefaultObservableValue(AssetLocation.OpenDAW)

export const SoundfontBrowser = ({lifecycle, service, background, fontSize}: Construct) => {
    const config: ResourceBrowserConfig<Soundfont> = {
        name: "soundfonts",
        headers: [
            {label: "Name"},
            {label: "Size", align: "right"}
        ],
        fetchOnline: () => OpenSoundfontAPI.get().all(),
        fetchLocal: async () => {
            const openDAW = await OpenSoundfontAPI.get().all()
            const user = await SoundfontStorage.get().list()
            return Arrays.subtract(user, openDAW, ({uuid: a}, {uuid: b}) => a === b)
        },
        renderEntry: ({lifecycle: entryLifecycle, service: entryService, selection, item, location: loc, refresh}) => (
            <SoundfontView
                lifecycle={entryLifecycle}
                service={entryService}
                soundfontSelection={selection as SoundfontSelection}
                soundfont={item}
                location={loc}
                refresh={refresh}
            />
        ),
        resolveEntryName: (soundfont: Soundfont) => soundfont.name,
        createSelection: (svc: StudioService, htmlSelection: HTMLSelection) => new SoundfontSelection(svc, htmlSelection),
        importSignal: "import-soundfont"
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