import css from "./AnalysisPanel.sass?inline"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {Lifecycle} from "@opendaw/lib-std"
import {StudioService} from "@/service/StudioService"
import {VuMetersCard} from "./VuMetersCard.tsx"
import {SpectrumCard} from "./SpectrumCard.tsx"
import {SpectrogramCard} from "./SpectrogramCard.tsx"
import {LevelCard} from "./LevelCard.tsx"
import {GonioCard} from "./GonioCard.tsx"
import {ScopeCard} from "./ScopeCard.tsx"

const className = Html.adoptStyleSheet(css, "AnalysisPanel")

type Construct = { lifecycle: Lifecycle, service: StudioService }

export const AnalysisPanel = ({lifecycle, service}: Construct): HTMLElement => (
    <div className={className}>
        <div className="cards">
            <VuMetersCard lifecycle={lifecycle} service={service}/>
            <div className="grid">
                <SpectrumCard lifecycle={lifecycle} service={service}/>
                <SpectrogramCard lifecycle={lifecycle} service={service}/>
                <LevelCard lifecycle={lifecycle} service={service}/>
                <GonioCard lifecycle={lifecycle} service={service}/>
                <ScopeCard lifecycle={lifecycle} service={service}/>
            </div>
        </div>
    </div>
)
