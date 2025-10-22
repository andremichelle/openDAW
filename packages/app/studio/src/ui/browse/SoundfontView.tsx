import css from "./SoundfontView.sass?inline"
import {createElement} from "@opendaw/lib-jsx"
import {Exec, isDefined, Lifecycle} from "@opendaw/lib-std"
import {Icon} from "../components/Icon"
import {IconSymbol, Soundfont} from "@opendaw/studio-adapters"
import {AssetLocation} from "@/ui/browse/AssetLocation"
import {Button} from "../components/Button"
import {ContextMenu} from "@/ui/ContextMenu"
import {MenuItem} from "@/ui/model/menu-item"
import {Html} from "@opendaw/lib-dom"
import {DragAndDrop} from "@/ui/DragAndDrop"
import {SoundfontSelection} from "@/ui/browse/SoundfontSelection"
import {StudioService} from "@/service/StudioService"

const className = Html.adoptStyleSheet(css, "Soundfont")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    soundfontSelection: SoundfontSelection
    soundfont: Soundfont
    location: AssetLocation
    refresh: Exec
}

const formatBytes = (bytes: number, decimals = 1): string => {
    if (bytes === 0) {return "0 B"}
    const k = 1024
    const sizes = ["B", "KB", "MB", "GB", "TB"]
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    const value = bytes / Math.pow(k, i)
    return `${value.toFixed(decimals)} ${sizes[i]}`
}

export const SoundfontView = ({
                                  lifecycle, service, soundfontSelection, soundfont, location, refresh
                              }: Construct) => {
    const {name, size} = soundfont
    const deleteButton: Element = (
        <Button lifecycle={lifecycle} appearance={{activeColor: "white"}}
                onClick={async (event) => {
                    event.stopPropagation()
                    await soundfontSelection.deleteSoundfonts(soundfont)
                    refresh()
                }}>
            <Icon symbol={IconSymbol.Close}/>
        </Button>
    )
    const element: HTMLElement = (
        <div className={className}
             data-selection={JSON.stringify(soundfont)}
             draggable>
            <div className="meta">
                <span>{name}</span>
                <span style={{textAlign: "right"}}>{isDefined(size) ? formatBytes(size) : "N/A"}</span>
            </div>
            {location === AssetLocation.Local && (
                <div className="edit">
                    {deleteButton}
                </div>
            )}
        </div>
    )
    lifecycle.ownAll(
        DragAndDrop.installSource(element, () => ({type: "soundfont", soundfont})),
        ContextMenu.subscribe(element, collector => collector.addItems(
            MenuItem.default({label: "Create Soundfont Device", selectable: service.hasProfile})
                .setTriggerProcedure(() => soundfontSelection.requestDevice()),
            MenuItem.default({label: "Delete Soundfont(s)", selectable: location === AssetLocation.Local})
                .setTriggerProcedure(async () => {
                    await soundfontSelection.deleteSelected()
                    refresh()
                }))
        )
    )
    return element
}