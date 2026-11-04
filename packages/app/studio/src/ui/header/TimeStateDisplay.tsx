import css from "./TimeStateDisplay.sass?inline"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {Html} from "@opendaw/lib-dom"
import {ContextMenu, FpsOptions, MenuItem, StudioPreferences} from "@opendaw/studio-core"
import {TapButton} from "@/ui/header/TapButton"
import {MusicalUnitDisplay} from "@/ui/header/MusicalUnitDisplay"
import {AbsoluteUnitDisplay} from "@/ui/header/AbsoluteUnitDisplay"
import {TempoControl} from "@/ui/header/TempoControl"
import {MeterControl} from "@/ui/header/MeterControl"
import {ShuffleControl} from "@/ui/header/ShuffleControl"
import {Colors, IconSymbol} from "@opendaw/studio-enums"

const className = Html.adoptStyleSheet(css, "TimeStateDisplay")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const TimeStateDisplay = ({lifecycle, service}: Construct) => {
    const element: HTMLElement = (
        <div className={className} onInit={element => {
            const values = StudioPreferences.settings["time-display"]
            return ContextMenu.subscribe(element, collector => collector.addItems(
                MenuItem.header({label: "Time Units", icon: IconSymbol.Time, color: Colors.green}),
                MenuItem.default({
                    label: "Musical Time (Bars, Beats)",
                    checked: values.musical
                }).setTriggerProcedure(() => values.musical = !values.musical),
                MenuItem.default({
                    label: "Absolute Time (Hours, Minutes, Seconds)",
                    checked: values.absolute
                }).setTriggerProcedure(() => values.absolute = !values.absolute),
                MenuItem.default({
                    label: "Fine Details (Ticks, Frames)",
                    checked: values.details
                }).setTriggerProcedure(() => values.details = !values.details),
                MenuItem.default({
                    label: "FPS"
                }).setRuntimeChildrenProcedure(parent => parent.addMenuItem(...FpsOptions
                    .map(fps => MenuItem.default({
                        label: String(fps),
                        checked: values.fps === fps
                    }).setTriggerProcedure(() => values.fps = fps))))
            ))
        }}>
            <MusicalUnitDisplay lifecycle={lifecycle} service={service}/>
            <AbsoluteUnitDisplay lifecycle={lifecycle} service={service}/>
            <TempoControl lifecycle={lifecycle} service={service}/>
            <TapButton service={service}/>
            <MeterControl lifecycle={lifecycle} service={service}/>
            <ShuffleControl lifecycle={lifecycle} service={service}/>
        </div>
    )
    return element
}