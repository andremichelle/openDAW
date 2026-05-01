import {InstrumentFactory} from "@opendaw/studio-adapters"
import {ProjectApi} from "@opendaw/studio-core"

export namespace DefaultInstrumentFactory {
    export const create = (api: ProjectApi, factory: InstrumentFactory) => {
        api.createAnyInstrument(factory)
    }
}