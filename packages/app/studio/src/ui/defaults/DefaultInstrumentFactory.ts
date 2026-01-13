import {InstrumentFactories, InstrumentFactory} from "@moises-ai/studio-adapters"
import {DefaultPlayfieldAttachment} from "@/ui/defaults/DefaultPlayfieldAttachment"
import {ProjectApi} from "@moises-ai/studio-core"

export namespace DefaultInstrumentFactory {
    export const create = (api: ProjectApi, factory: InstrumentFactory) => {
        if (factory === InstrumentFactories.Playfield) {
            api.createInstrument(InstrumentFactories.Playfield, {attachment: DefaultPlayfieldAttachment})
        } else {
            api.createAnyInstrument(factory)
        }
    }
}