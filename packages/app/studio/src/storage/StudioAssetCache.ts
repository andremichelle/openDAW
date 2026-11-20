import {EmptyProcedure, Provider} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {
    AssetCache, FactoryCatalog, GlobalSampleLoaderManager, GlobalSoundfontLoaderManager, StorageScan
} from "@opendaw/studio-core"
import {StorageInspector} from "./StorageInspector"

export namespace StudioAssetCache {
    const libraryKeys = async (): Promise<ReadonlySet<string>> => {
        const catalog = FactoryCatalog.get()
        const [samples, soundfonts] = await Promise.all([
            Promises.tryCatch(catalog.samples()), Promises.tryCatch(catalog.soundfonts())])
        const keys = new Set<string>()
        if (samples.status === "resolved") {samples.value.forEach(({uuid}) => keys.add(`sample:${uuid}`))}
        if (soundfonts.status === "resolved") {soundfonts.value.forEach(({uuid}) => keys.add(`soundfont:${uuid}`))}
        return keys
    }

    export const create = (sampleManager: GlobalSampleLoaderManager,
                           soundfontManager: GlobalSoundfontLoaderManager,
                           report: Provider<Promise<StorageScan.Report>> = () =>
                               StorageInspector.scan(EmptyProcedure, EmptyProcedure)): AssetCache => {
        let library: Promise<ReadonlySet<string>> = Promise.resolve(new Set())
        return new AssetCache({
            sampleManager, soundfontManager,
            isCached: async ref => (await library).has(AssetCache.keyOf(ref)),
            report: () => {
                library = libraryKeys()
                return report()
            }
        })
    }
}
