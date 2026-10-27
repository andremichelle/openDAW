import css from "./CreateTrackButtons.sass?inline"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {InstrumentFactories} from "@opendaw/studio-adapters"
import type {StudioService} from "@/service/StudioService"
import {Button} from "@/ui/components/Button"
import {Icon} from "@/ui/components/Icon"
import {SpotlightCreate} from "@/ui/spotlight/SpotlightCreate"
import {DeviceDialog} from "@/ui/browse/DeviceDialog"

const className = Html.adoptStyleSheet(css, "CreateTrackButtons")

export namespace CreateTrack {
    // a new track goes right below the one in edit mode
    export const instrument = (service: StudioService): void =>
        DeviceDialog.open(service, {type: "new-instrument", anchor: SpotlightCreate.anchorAfterEditing(service.project)})

    export const audioTrack = (service: StudioService): void => {
        const {project} = service
        const anchor = SpotlightCreate.anchorAfterEditing(project)
        project.editing.modify(() => {
            const {audioUnitBox} = project.api.createAnyInstrument(InstrumentFactories.Tape)
            project.api.placeAudioUnitBefore(audioUnitBox, anchor)
        })
    }
}

export const CreateTrackButtons = ({lifecycle, service}: { lifecycle: Lifecycle, service: StudioService }): HTMLElement => (
    <div className={className}>
        <Button lifecycle={lifecycle}
                onClick={() => CreateTrack.instrument(service)}
                appearance={{color: Colors.shadow, cursor: "pointer"}}>
            <span>Add instrument</span> <Icon symbol={IconSymbol.Add}/>
        </Button>
        <Button lifecycle={lifecycle}
                onClick={() => CreateTrack.audioTrack(service)}
                appearance={{color: Colors.shadow, cursor: "pointer"}}>
            <span>Add audio track</span> <Icon symbol={IconSymbol.Add}/>
        </Button>
    </div>
)
