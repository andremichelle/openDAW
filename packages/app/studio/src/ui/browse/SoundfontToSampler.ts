import {Option} from "@opendaw/lib-std"
import {SamplerDeviceBoxAdapter, Soundfont} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService"
import type {SamplerImporter} from "@/ui/devices/instruments/SamplerDeviceEditor/SamplerImporter"

export namespace SoundfontToSampler {
    // the importer and the soundfont reader load on demand
    export const run = async (service: StudioService, soundfont: Soundfont,
                              target: Option<SamplerDeviceBoxAdapter> = Option.None,
                              place?: SamplerImporter.Placement): Promise<void> => {
        const {SamplerImporter} = await import("@/ui/devices/instruments/SamplerDeviceEditor/SamplerImporter")
        return SamplerImporter.fromLibrary(service, soundfont, target, place)
    }
}
