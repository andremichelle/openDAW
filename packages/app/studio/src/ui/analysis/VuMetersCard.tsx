import {createElement} from "@opendaw/lib-jsx"
import {Lifecycle} from "@opendaw/lib-std"
import {dbToGain, gainToDb} from "@opendaw/lib-dsp"
import {EngineAddresses} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService"
import {VUMeterDesign} from "@/ui/meter/VUMeterDesign"
import {card, dropdown, owned} from "./AnalysisControls.tsx"
import {observeProject} from "./AnalysisSource.ts"

const VU_TAU = 0.065 // single-pole time constant: 99% of a step in ~300 ms (IEC 60268-17 VU ballistics)
const VU_FLOOR = -60.0

type Construct = { lifecycle: Lifecycle, service: StudioService }

export const VuMetersCard = ({lifecycle, service}: Construct): HTMLElement => {
    const vuL = owned(lifecycle, 0.0)
    const vuR = owned(lifecycle, 0.0)
    const vuRef = owned(lifecycle, "0 dBFS")
    const refDb = {value: 0.0}
    const ballistic = {left: VU_FLOOR, right: VU_FLOOR, last: performance.now()}
    lifecycle.own(vuRef.catchupAndSubscribe(owner => refDb.value = parseFloat(owner.getValue())))
    observeProject(lifecycle, service, (project, runtime) => {
        runtime.own(project.liveStreamReceiver.subscribeFloats(EngineAddresses.PEAKS, values => {
            const now = performance.now()
            const dt = Math.min(0.1, (now - ballistic.last) / 1000.0)
            ballistic.last = now
            const coeff = 1.0 - Math.exp(-dt / VU_TAU)
            const targetL = gainToDb(Math.max(values[2], 1e-6)) - refDb.value
            const targetR = gainToDb(Math.max(values[3], 1e-6)) - refDb.value
            ballistic.left += (targetL - ballistic.left) * coeff
            ballistic.right += (targetR - ballistic.right) * coeff
            vuL.setValue(dbToGain(ballistic.left))
            vuR.setValue(dbToGain(ballistic.right))
        }))
    })
    return (
        <div className="meters">
            {card("VU · L", dropdown(lifecycle, vuRef, "72px", "0 dBFS", "-7 dBFS", "-14 dBFS", "-18 dBFS", "-20 dBFS"),
                (<div className="vu"><VUMeterDesign.Default model={vuL}/></div>), false, "meter")}
            {card("VU · R", [],
                (<div className="vu"><VUMeterDesign.Default model={vuR}/></div>), false, "meter")}
        </div>
    )
}
