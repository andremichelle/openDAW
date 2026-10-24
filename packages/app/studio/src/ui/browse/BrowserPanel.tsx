import css from "./BrowserPanel.sass?inline"
import {Lifecycle, Terminator} from "@opendaw/lib-std"
import {StudioService} from "@/service/StudioService.ts"
import {createElement, DomElement, Group, replaceChildren} from "@opendaw/lib-jsx"
import {RadioGroup} from "@/ui/components/RadioGroup.tsx"
import {SampleBrowser} from "@/ui/browse/SampleBrowser.tsx"
import {DeviceBrowser, DeviceFilter} from "@/ui/browse/DeviceBrowser"
import {PresetCategoryKey} from "@/ui/browse/PresetService"
import {BrowseScope} from "@/ui/browse/BrowseScope"
import {Html} from "@opendaw/lib-dom"
import {SoundfontBrowser} from "@/ui/browse/SoundfontBrowser"
import {TourAnchors} from "@/ui/tour/TourAnchors"
import {Colors} from "@opendaw/studio-enums"

const className = Html.adoptStyleSheet(css, "BrowserPanel")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const BrowserPanel = ({lifecycle, service}: Construct) => {
    const scope = service.layout.browseScope
    const filter = DeviceFilter.create()
    const placeholder: DomElement = <Group/>
    const contentLifecycle = lifecycle.own(new Terminator())
    lifecycle.own(scope.catchupAndSubscribe(owner => {
        contentLifecycle.terminate()
        const devices = (category: PresetCategoryKey) => (
            <DeviceBrowser lifecycle={contentLifecycle} service={service} category={category} filter={filter}/>
        )
        replaceChildren(placeholder, (() => {
            switch (owner.getValue()) {
                case BrowseScope.Instruments:
                    return devices("instrument")
                case BrowseScope.AudioEffects:
                    return devices("audio-effect")
                case BrowseScope.MidiEffects:
                    return devices("midi-effect")
                case BrowseScope.Samples:
                    return <SampleBrowser lifecycle={contentLifecycle}
                                          service={service}
                                          background
                                          fontSize="0.75em"/>
                case BrowseScope.Soundfonts:
                    return <SoundfontBrowser lifecycle={contentLifecycle}
                                             service={service}
                                             background
                                             fontSize="0.75em"/>
                default:
                    return <span>Unknown</span>
            }
        })())
    }))
    const tabs: HTMLElement = (
        <RadioGroup lifecycle={lifecycle} elements={[
            {value: BrowseScope.Instruments, element: <span>Instruments</span>},
            {value: BrowseScope.AudioEffects, element: <span>AudioFx</span>},
            {value: BrowseScope.MidiEffects, element: <span>MidiFx</span>},
            {value: BrowseScope.Samples, element: <span>Samples</span>},
            {value: BrowseScope.Soundfonts, element: <span>Soundfonts</span>}
        ]} model={scope} appearance={{color: Colors.shadow, activeColor: Colors.orange}}
                    style={{fontSize: "11px", columnGap: "8px", padding: "0.5em 0.75em"}}/>
    )
    TourAnchors.register(lifecycle, tabs, "presets", "samples", "soundfonts")
    return (
        <div className={className}>
            {tabs}
            {placeholder}
        </div>
    )
}