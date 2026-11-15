import {InstrumentFactory} from "@opendaw/studio-adapters"
import type {StudioService} from "@/service/StudioService"

export namespace DefaultInstrumentFactory {
    export const create = (service: StudioService, factory: InstrumentFactory) => {
        service.project.api.createInstrumentAfterSelection(factory)
    }
}