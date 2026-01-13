import {Lifecycle, panic} from "@moises-ai/lib-std"
import {PanelContentFactory} from "@/ui/workspace/PanelContents.tsx"
import {createElement, JsxValue} from "@moises-ai/lib-jsx"
import {ContentEditor} from "@/ui/timeline/editors/ContentEditor.tsx"
import {StudioService} from "@/service/StudioService.ts"
import {Timeline} from "@/ui/timeline/Timeline.tsx"
import {Mixer} from "@/ui/mixer/Mixer.tsx"
import {Modular} from "@/ui/modular/Modular.tsx"
import {DevicePanel} from "@/ui/devices/panel/DevicePanel.tsx"
import {PanelType} from "@/ui/workspace/PanelType.ts"
import {Dashboard} from "@/ui/dashboard/Dashboard.tsx"
import {ProjectProfileInfo} from "@/ui/info-panel/ProjectProfileInfo.tsx"
import {BrowserPanel} from "@/ui/browse/BrowserPanel.tsx"
import {NotePadPanel} from "@/ui/NotePadPanel"
import {FlexSpace} from "./FlexSpace"
import {VUMeterPanel} from "@/ui/meter/VUMeterPanel"
import {PianoModePanel} from "@/ui/piano-panel/PianoModePanel.tsx"
import {ShadertoyPreview} from "@/ui/shadertoy/ShadertoyPreview"
import {ShadertoyEditor} from "@/ui/shadertoy/ShadertoyEditor"

export const createPanelFactory = (service: StudioService): PanelContentFactory => ({
    create: (lifecycle: Lifecycle, type: PanelType): JsxValue => {
        switch (type) {
            case PanelType.Dashboard:
                return (<Dashboard lifecycle={lifecycle} service={service}/>)
            case PanelType.Timeline:
                return (<Timeline lifecycle={lifecycle} service={service}/>)
            case PanelType.ContentEditor:
                return (<ContentEditor lifecycle={lifecycle} service={service}/>)
            case PanelType.BrowserPanel:
                return (<BrowserPanel lifecycle={lifecycle} service={service}/>)
            case PanelType.Notepad:
                return (<NotePadPanel lifecycle={lifecycle} service={service}/>)
            case PanelType.DevicePanel:
                return (<DevicePanel lifecycle={lifecycle} service={service}/>)
            case PanelType.Mixer:
                return (<Mixer lifecycle={lifecycle} service={service}/>)
            case PanelType.ModularSystem:
                return (<Modular lifecycle={lifecycle} service={service}/>)
            case PanelType.VUMeter:
                return (<VUMeterPanel lifecycle={lifecycle} service={service}/>)
            case PanelType.ProjectInfo:
                return (<ProjectProfileInfo lifecycle={lifecycle} service={service}/>)
            case PanelType.MidiFall:
                return (<PianoModePanel lifecycle={lifecycle} service={service}/>)
            case PanelType.ShadertoyPreview:
                return (<ShadertoyPreview lifecycle={lifecycle} service={service}/>)
            case PanelType.ShadertoyEditor:
                return (<ShadertoyEditor lifecycle={lifecycle} service={service}/>)
            case PanelType.EmptyFlexSpace:
                return (<FlexSpace/>)
            default:
                return panic(`Unknown type (${type})`)
        }
    }
})