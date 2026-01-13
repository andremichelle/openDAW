import css from "./BrowserPanel.sass?inline"
import {DefaultObservableValue, Lifecycle, Terminator} from "@moises-ai/lib-std"
import {StudioService} from "@/service/StudioService.ts"
import {createElement, DomElement, Group, replaceChildren} from "@moises-ai/lib-jsx"
import {RadioGroup} from "@/ui/components/RadioGroup.tsx"
import {SampleBrowser} from "@/ui/browse/SampleBrowser.tsx"
import {DevicesBrowser} from "@/ui/browse/DevicesBrowser.tsx"
import {BrowseScope} from "@/ui/browse/BrowseScope"
import {Html} from "@moises-ai/lib-dom"
import {SoundfontBrowser} from "@/ui/browse/SoundfontBrowser"

const className = Html.adoptStyleSheet(css, "BrowserPanel")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const BrowserPanel = ({lifecycle, service}: Construct) => {
    const scope = new DefaultObservableValue(BrowseScope.Devices)
    const placeholder: DomElement = <Group/>
    const contentLifecycle = lifecycle.own(new Terminator())
    lifecycle.own(scope.catchupAndSubscribe(owner => {
        contentLifecycle.terminate()
        replaceChildren(placeholder, (() => {
            switch (owner.getValue()) {
                case BrowseScope.Devices:
                    return <DevicesBrowser lifecycle={contentLifecycle}
                                           service={service}/>
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
    return (
        <div className={className}>
            <RadioGroup lifecycle={lifecycle} elements={[
                {value: BrowseScope.Devices, element: <span>Devices</span>},
                {value: BrowseScope.Samples, element: <span>Samples</span>},
                {value: BrowseScope.Soundfonts, element: <span>Soundfonts</span>}
            ]} model={scope} style={{fontSize: "11px", columnGap: "8px", padding: "0.5em 0.75em"}}/>
            {placeholder}
        </div>
    )
}