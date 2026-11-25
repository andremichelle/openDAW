import {InstrumentFactory} from "@opendaw/studio-adapters"
import type {StudioService} from "@/service/StudioService"
import {NewInstrumentRegion} from "@/ui/timeline/NewInstrumentRegion"

export namespace DefaultInstrumentFactory {
    export const create = (service: StudioService, factory: InstrumentFactory) => {
        const {project} = service
        const {audioUnitBox} = project.api.createInstrumentAfterSelection(factory)
        NewInstrumentRegion.create(project, service.timeline.snapping, audioUnitBox)
    }
}