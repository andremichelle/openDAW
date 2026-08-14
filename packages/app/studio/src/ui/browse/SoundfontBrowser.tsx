import css from "./SoundfontBrowser.sass?inline"
import {Arrays, DefaultObservableValue, Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {SoundfontStorage} from "@opendaw/studio-core"
import {OpenSoundfontAPI} from "@/opendaw-api"
import {StudioService} from "@/service/StudioService.ts"
import {SoundfontView} from "@/ui/browse/SoundfontView"
import {AssetLocation} from "@/ui/browse/AssetLocation"
import {HTMLSelection} from "@/ui/HTMLSelection"
import {SoundfontSelection} from "@/ui/browse/SoundfontSelection"
import {ResourceBrowser} from "@/ui/browse/ResourceBrowser"
import {Soundfont} from "@opendaw/studio-adapters"
import {SoundfontIndex, SoundfontIndexFolder} from "@/opendaw-api/SoundfontIndex"
import {ResourceBrowserConfig} from "@/ui/browse/ResourceBrowserConfig"
import {ResourceFolder} from "@/ui/browse/ResourceFolder"
import {LocalTree} from "@/ui/browse/LocalTree"

const className = Html.adoptStyleSheet(css, "SoundfontBrowser")

const toResourceFolder = (folder: SoundfontIndexFolder): ResourceFolder<Soundfont> => ({
    name: folder.name,
    folders: folder.folders?.map(toResourceFolder) ?? [],
    items: folder.soundfonts?.map(SoundfontIndex.asSoundfont) ?? []
})

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    background?: boolean
    fontSize?: string // em
}

const location = new DefaultObservableValue(AssetLocation.OpenDAW)
const expandedKeys = new Set<string>()

export const SoundfontBrowser = ({lifecycle, service, background, fontSize}: Construct) => {
    const config: ResourceBrowserConfig<Soundfont> = {
        name: "soundfonts",
        headers: [
            {label: "Name"},
            {label: "Size", align: "right"}
        ],
        fetchOnline: async () => ({
            name: "",
            folders: (await OpenSoundfontAPI.get().tree()).folders.map(toResourceFolder),
            items: []
        }),
        expandedKeys,
        fetchLocal: async () => {
            const openDAW = await OpenSoundfontAPI.get().all()
            const user = await SoundfontStorage.get().list()
            return Arrays.subtract(user, openDAW, ({uuid: a}, {uuid: b}) => a === b)
        },
        fetchLocalTree: () =>
            LocalTree.load(SoundfontStorage.get().structure, (soundfont: Soundfont) => soundfont.uuid),
        dragType: "soundfont",
        renderEntry: ({lifecycle: entryLifecycle, selection, item, tree, refresh}) => (
            <SoundfontView
                lifecycle={entryLifecycle}
                soundfontSelection={selection as SoundfontSelection}
                soundfont={item}
                tree={tree}
                refresh={refresh}
            />
        ),
        resolveEntryName: (soundfont: Soundfont) => soundfont.name,
        resolveEntryUuid: (soundfont: Soundfont) => soundfont.uuid,
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