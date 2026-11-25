import css from "./WclapUpdateNotice.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {Lifecycle, VitalSigns} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService"
import {WclapUpdates} from "@/service/WclapUpdates"
import {WclapUpdateDialog} from "@/ui/WclapUpdateDialog"

const className = Html.adoptStyleSheet(css, "WclapUpdateNotice")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

// Stored WebCLAP builds the catalogue has replaced: a bubble above the WebCLAP tab that opens the update dialog
export const WclapUpdateNotice = ({lifecycle, service}: Construct) => {
    // a check that ends after the dashboard is gone is dropped
    const vitals = lifecycle.own(new VitalSigns())
    const element: HTMLElement = (
        // the tab's label takes no pointer events on its children, the bubble does
        <span className={Html.buildClassList(className, "hidden")}
              style={{pointerEvents: "all"}}
              onclick={(event: MouseEvent) => {
                  event.preventDefault() // the label would pick the tab
                  event.stopPropagation() // the dialog, not the tab
                  WclapUpdateDialog.open(service).then(refresh)
              }}>Updates available</span>
    )
    const refresh = (): Promise<void> => WclapUpdates.find().then(outdated => {
        if (vitals.isTerminated) {return}
        const names = Array.from(new Set(outdated.map(({successor}) => successor.name))).toSorted()
        element.title = `Newer builds: ${names.join(", ")}`
        element.classList.toggle("hidden", names.length === 0)
    }, error => console.warn("WclapUpdates: the check failed", error))
    refresh()
    return element
}
