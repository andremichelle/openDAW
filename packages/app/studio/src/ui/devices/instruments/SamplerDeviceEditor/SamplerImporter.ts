import {asInstanceOf, DefaultObservableValue, int, isDefined, Option, Optional, RuntimeNotifier, UUID} from "@opendaw/lib-std"
import {Files} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import {AudioFileBox, SamplerDeviceBox} from "@opendaw/studio-boxes"
import {
    InstrumentFactories, Sample, SamplerDeviceBoxAdapter, SamplerImport, SamplerSfz, SamplerSoundfont, Soundfont, SoundfontBank
} from "@opendaw/studio-adapters"
import {ExternalLib, Project, ResourceStructures, SampleStorage, StructureFile} from "@opendaw/studio-core"
import {StudioService} from "@/service/StudioService"
import {Dialogs} from "@/ui/components/dialogs"
import {SamplerText} from "./SamplerText"

// Imports a soundfont preset or an SFZ file into a Sampler. Loaded on demand, the studio does not carry it at boot.
export namespace SamplerImporter {
    const Folder = "Multi Samples"
    const Accept: OpenFilePickerOptions = {
        multiple: true,
        types: [{description: "Soundfont, or SFZ with its samples", accept: {"application/octet-stream": [".sf2", ".sf3", ".dls", ".sfz", ".wav"]}}]
    }
    type Source = { readonly name: string, readonly read: () => Promise<ArrayBuffer> }

    const hasExtension = (file: File, extension: string): boolean => file.name.toLowerCase().endsWith(extension)
    const stem = (name: string): string => name.replace(/\.[A-Za-z0-9]+$/, "")
    const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1).toLowerCase()

    export const browse = async (service: StudioService, adapter: SamplerDeviceBoxAdapter): Promise<void> => {
        // the project the Sampler lives in: it may be closed or replaced while the import runs
        const {project} = service
        const {status, value: files} = await Promises.tryCatch(Files.open(Accept))
        if (status === "rejected") {return}
        const soundfont = files.find(file => [".sf2", ".sf3", ".dls"].some(extension => hasExtension(file, extension)))
        const sfz = files.find(file => hasExtension(file, ".sfz"))
        if (isDefined(soundfont)) {
            await importSoundfont(service, project, adapter, soundfont)
        } else if (isDefined(sfz)) {
            await importSfz(service, project, adapter, sfz, files)
        } else {
            await RuntimeNotifier.info({
                headline: "Nothing to Import",
                message: "Choose a soundfont (.sf2, .sf3, .dls), or an SFZ file together with the samples it names."
            })
        }
    }

    const importSoundfont = async (service: StudioService, project: Project, adapter: SamplerDeviceBoxAdapter,
                                   file: File): Promise<void> => {
        const library = await ExternalLib.Soundfont()
        if (library.status === "rejected") {
            await RuntimeNotifier.info({headline: "Import Failed", message: "The soundfont reader could not be loaded."})
            return
        }
        const parsed = await Promises.tryCatch(file.arrayBuffer().then(buffer => library.value(buffer)))
        if (parsed.status === "rejected") {
            await RuntimeNotifier.info({headline: "Import Failed", message: `'${file.name}' is not a soundfont that can be read.`})
            return
        }
        await importBank(service, project, Option.wrap(adapter), parsed.value, stem(file.name))
    }

    // Creates the Sampler a soundfont goes into when there is no target, inside a modification.
    export type Placement = (project: Project) => SamplerDeviceBox
    const appendSampler: Placement = project =>
        asInstanceOf(project.api.createInstrument(InstrumentFactories.Sampler).instrumentBox, SamplerDeviceBox)

    // A soundfont of the library into the Sampler `target`, or into a new Sampler when there is none.
    export const fromLibrary = async (service: StudioService, soundfont: Soundfont,
                                      target: Option<SamplerDeviceBoxAdapter>, place: Placement = appendSampler): Promise<void> => {
        if (!service.hasProfile) {
            await service.newProject()
            if (!service.hasProfile) {return}
        }
        const {project} = service
        const bank = await loadFromLibrary(project, soundfont)
        if (bank.status === "rejected") {
            await RuntimeNotifier.info({headline: "Soundfont Not Loaded", message: `'${soundfont.name}' could not be loaded.`})
            return
        }
        await importBank(service, project, target, bank.value, soundfont.name, place)
    }

    const loadFromLibrary = (project: Project, soundfont: Soundfont) => Promises.tryCatch(new Promise<SoundfontBank.Bank>((resolve, reject) => {
        const loader = project.soundfontManager.getOrCreate(UUID.parse(soundfont.uuid))
        const progress = new DefaultObservableValue(0.0)
        const dialog = Dialogs.progress({headline: "Loading Soundfont", message: soundfont.name, progress})
        const subscription = loader.subscribe(state => {
            if (state.type === "progress") {
                progress.setValue(state.progress)
            } else if (state.type === "loaded") {
                done()
                resolve(loader.soundfont.unwrap("soundfont"))
            } else if (state.type === "error") {
                done()
                reject(new Error(state.reason))
            }
        })
        const done = () => {
            subscription.terminate()
            dialog.terminate()
        }
        if (loader.state.type === "loaded") {
            done()
            resolve(loader.soundfont.unwrap("soundfont"))
        }
    }))

    const choosePreset = async (bank: SoundfontBank.Bank, name: string, replaces: boolean): Promise<Option<int>> => {
        if (bank.presets.length === 1) {return Option.wrap(0)}
        return Dialogs.select({
            headline: "Import Soundfont",
            message: `Choose the preset of '${name}' to import.${replaces ? " It replaces the sample zones of this Sampler." : ""}`,
            choices: SamplerSoundfont.presetNames(bank).map((text, value) => ({text, value})),
            okText: "Import"
        })
    }

    const importBank = async (service: StudioService, project: Project, target: Option<SamplerDeviceBoxAdapter>,
                              bank: SoundfontBank.Bank, name: string, place: Placement = appendSampler): Promise<void> => {
        if (bank.presets.length === 0) {
            await RuntimeNotifier.info({headline: "Import Failed", message: `'${name}' has no presets.`})
            return
        }
        const prepared = await prepareBank(service, project, bank, name, target.nonEmpty())
        if (prepared.isEmpty()) {return}
        const adapter = target.unwrapOrElse(() => project.boxAdapters.adapterFor(
            project.editing.modify(() => place(project)).unwrap("sampler"), SamplerDeviceBoxAdapter))
        if (!adapter.box.isAttached()) {return}
        project.editing.modify(() => applyPrepared(project, adapter.box, prepared.unwrap()))
    }

    const prepareBank = async (service: StudioService, project: Project, bank: SoundfontBank.Bank, name: string,
                               replaces: boolean): Promise<Option<Prepared>> => {
        const choice = await choosePreset(bank, name, replaces)
        if (choice.isEmpty()) {return Option.None}
        const {instrument, samples} = SamplerSoundfont.convert(bank, choice.unwrap())
        return Option.wrap(await storeSamples(service, project, instrument, name, samples.map(sample => ({
            name: `${sample.name}.wav`,
            read: async () => SamplerImport.encodeWav(sample)
        }))))
    }

    // A soundfont of the library loaded, its preset chosen and its samples stored, for a Sampler made elsewhere.
    export const prepareFromLibrary = async (service: StudioService, soundfont: Soundfont): Promise<Option<Prepared>> => {
        const {project} = service
        const bank = await loadFromLibrary(project, soundfont)
        if (bank.status === "rejected") {
            await RuntimeNotifier.info({headline: "Soundfont Not Loaded", message: `'${soundfont.name}' could not be loaded.`})
            return Option.None
        }
        if (bank.value.presets.length === 0) {
            await RuntimeNotifier.info({headline: "Import Failed", message: `'${soundfont.name}' has no presets.`})
            return Option.None
        }
        return prepareBank(service, project, bank.value, soundfont.name, false)
    }

    const importSfz = async (service: StudioService, project: Project, adapter: SamplerDeviceBoxAdapter, file: File,
                             files: ReadonlyArray<File>): Promise<void> => {
        const {instrument, samplePaths} = SamplerSfz.parse(await file.text(), stem(file.name))
        const sources: ReadonlyArray<Optional<Source>> = samplePaths.map(path => {
            const sample = files.find(candidate => candidate.name.toLowerCase() === baseName(path))
            return isDefined(sample) ? {name: sample.name, read: () => sample.arrayBuffer()} : undefined
        })
        const missing = sources.filter(source => !isDefined(source)).length
        if (missing === sources.length) {
            await RuntimeNotifier.info({
                headline: "Samples Missing",
                message: `'${file.name}' names ${sources.length} samples, none of them was chosen. Select the SFZ file together with its samples.`
            })
            return
        }
        await store(service, project, adapter, instrument, stem(file.name), sources)
        if (missing > 0) {
            await RuntimeNotifier.info({
                headline: "Samples Missing",
                message: `${missing} of ${SamplerText.count(sources.length, "sample", "samples")} that '${file.name}' names ${missing === 1 ? "was" : "were"} not chosen. ${missing === 1 ? "Its" : "Their"} sample zones were left out.`
            })
        }
    }

    // The samples of an instrument, stored in the library under Multi Samples, ready to become zones.
    export type Prepared = {
        readonly instrument: SamplerImport.Instrument
        readonly stored: ReadonlyArray<Optional<Sample>>
    }

    // Stores each sample once (a sample that is already there is found by its content), files them under
    // Multi Samples and turns the instrument into the Sampler's zones.
    const store = async (service: StudioService, project: Project, adapter: SamplerDeviceBoxAdapter,
                         instrument: SamplerImport.Instrument, folder: string,
                         sources: ReadonlyArray<Optional<Source>>): Promise<void> => {
        const prepared = await storeSamples(service, project, instrument, folder, sources)
        if (!adapter.box.isAttached()) {return}
        project.editing.modify(() => applyPrepared(project, adapter.box, prepared))
    }

    const storeSamples = async (service: StudioService, project: Project, instrument: SamplerImport.Instrument,
                                folder: string, sources: ReadonlyArray<Optional<Source>>): Promise<Prepared> => {
        let failed = 0
        const progress = new DefaultObservableValue(0.0)
        const dialog = Dialogs.progress({headline: "Importing Samples", message: "", progress})
        const stored: Array<Optional<Sample>> = []
        for (const [index, source] of sources.entries()) {
            progress.setValue(index / sources.length)
            if (!isDefined(source)) {
                stored.push(undefined)
                continue
            }
            dialog.message = source.name
            const imported = await Promises.tryCatch(source.read()
                // a tempo of 0 is "none": no detection, these are notes and hits, not loops
                .then(arrayBuffer => service.sampleService.importFile({name: source.name, arrayBuffer, bpm: 0})))
            if (imported.status === "rejected") {failed++}
            stored.push(imported.status === "resolved" ? imported.value : undefined)
        }
        dialog.terminate()
        const uuids = stored.filter(isDefined).map(sample => sample.uuid)
        uuids.forEach(uuid => project.trackUserCreatedSample(UUID.parse(uuid)))
        const structureFile = SampleStorage.get().structure
        const structure = (await structureFile.load()).unwrapOrElse(StructureFile.Empty)
        await structureFile.save(ResourceStructures.place(structure, [Folder, folder], uuids))
        if (failed > 0) {
            await RuntimeNotifier.info({
                headline: "Samples Not Imported",
                message: `${failed} of ${SamplerText.count(sources.length, "sample", "samples")} could not be stored. ${failed === 1 ? "Its" : "Their"} sample zones were left out.`
            })
        }
        return {instrument, stored}
    }

    // Inside a modification: the stored instrument becomes the zones of `device`.
    export const applyPrepared = (project: Project, device: SamplerDeviceBox, {instrument, stored}: Prepared): void => {
        const {boxGraph} = project
        SamplerImport.apply(boxGraph, device, instrument, stored.map(sample => {
            if (!isDefined(sample)) {return undefined}
            const uuid = UUID.parse(sample.uuid)
            return boxGraph.findBox<AudioFileBox>(uuid).unwrapOrElse(() => AudioFileBox.create(boxGraph, uuid, box => {
                box.fileName.setValue(sample.name)
                box.endInSeconds.setValue(sample.duration)
            }))
        }))
    }
}
