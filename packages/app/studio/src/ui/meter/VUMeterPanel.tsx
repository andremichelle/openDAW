import css from "./VUMeterPanel.sass?inline"
import {DefaultObservableValue, Lifecycle, Option, Terminator} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {VUMeterDesign} from "@/ui/meter/VUMeterDesign.tsx"
import {StudioService} from "@/service/StudioService.ts"
import {Html} from "@opendaw/lib-dom"
import {EngineAddresses} from "@opendaw/studio-adapters"
import {ProjectProfile} from "@opendaw/studio-core"

const className = Html.adoptStyleSheet(css, "VUMeterPanel")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const VUMeterPanel = ({lifecycle, service}: Construct) => {
    const peakL = lifecycle.own(new DefaultObservableValue(0.0))
    const peakR = lifecycle.own(new DefaultObservableValue(0.0))
    const runtime = lifecycle.own(new Terminator())
    lifecycle.own(service.projectProfileService.catchupAndSubscribe((optProfile: Option<ProjectProfile>) => {
        runtime.terminate()
        optProfile.match({
            none: () => {
                peakL.setValue(0.0)
                peakR.setValue(0.0)
            },
            some: ({project: {liveStreamReceiver}}) => {
                runtime.own(liveStreamReceiver.subscribeFloats(EngineAddresses.PEAKS, peaks => {
                    const [pl, pr] = peaks
                    peakL.setValue(pl >= peakL.getValue() ? pl : peakL.getValue() * 0.98)
                    peakR.setValue(pr >= peakR.getValue() ? pr : peakR.getValue() * 0.98)
                }))
            }
        })
    }))
    return (
        <div className={className}>
            <div className="meters">
                <div><VUMeterDesign.Default model={peakL}/></div>
                <div><VUMeterDesign.Default model={peakR}/></div>
            </div>
        </div>
    )
}