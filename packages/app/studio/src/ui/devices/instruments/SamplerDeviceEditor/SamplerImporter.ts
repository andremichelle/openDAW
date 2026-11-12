import {DefaultObservableValue, isDefined, Optional, RuntimeNotifier, UUID} from "@opendaw/lib-std"
import {Files} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import {AudioFileBox} from "@opendaw/studio-boxes"
import {Sample, SamplerDeviceBoxAdapter, SamplerImport, SamplerSfz, SamplerSoundfont} from "@opendaw/studio-adapters"
import {ExternalLib, ResourceStructures, SampleStorage, StructureFile} from "@opendaw/studio-core"
import {StudioService} from "@/service/StudioService"
import {Dialogs} from "@/ui/components/dialogs"

// Imports a soundfont preset or an SFZ file into a Sampler. Loaded on demand, the studio does not carry it at boot.
export namespace SamplerImporter {
    const Folder = "Multi Samples"
    const Accept: OpenFilePickerOptions = {
        multiple: true,
        types: [{description: "Soundfont, or SFZ with its samples", accept: {"application/octet-stream": [".sf2", ".sfz", ".wav"]}}]
    }
    type Source = { readonly name: string, readonly read: () => Promise<ArrayBuffer> }

    const hasExtension = (file: File, extension: string): boolean => file.name.toLowerCase().endsWith(extension)
    const stem = (name: string): string => name.replace(/\.[A-Za-z0-9]+$/, "")
    const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1).toLowerCase()

    export const browse = async (service: StudioService, adapter: SamplerDeviceBoxAdapter): Promise<void> => {
        const {status, value: files} = await Promises.tryCatch(Files.open(Accept))
        if (status === "rejected") {return}
        const soundfont = files.find(file => hasExtension(file, ".sf2"))
        const sfz = files.find(file => hasExtension(file, ".sfz"))
        if (isDefined(soundfont)) {
            await importSoundfont(service, adapter, soundfont)
        } else if (isDefined(sfz)) {
            await importSfz(service, adapter, sfz, files)
        } else {
            await RuntimeNotifier.info({
                headline: "Nothing to Import",
                message: "Choose a soundfont (.sf2), or an SFZ file together with the samples it names."
            })
        }
    }

    const importSoundfont = async (service: StudioService, adapter: SamplerDeviceBoxAdapter, file: File): Promise<void> => {
        const library = await ExternalLib.SoundFont2()
        if (library.status === "rejected") {
            await RuntimeNotifier.info({headline: "Import Failed", message: "The soundfont reader could not be loaded."})
            return
        }
        const parsed = await Promises.tryCatch(file.arrayBuffer().then(buffer => new library.value(new Uint8Array(buffer))))
        if (parsed.status === "rejected") {
            await RuntimeNotifier.info({headline: "Import Failed", message: `'${file.name}' is not a soundfont that can be read.`})
            return
        }
        const names = SamplerSoundfont.presetNames(parsed.value)
        const choice = await Dialogs.select({
            headline: "Import Soundfont",
            message: `Choose the preset of '${file.name}' to import. It replaces the sample zones of this Sampler.`,
            choices: names.map((text, value) => ({text, value})),
            okText: "Import"
        })
        if (choice.isEmpty()) {return}
        const {instrument, samples} = SamplerSoundfont.convert(parsed.value, choice.unwrap())
        await store(service, adapter, instrument, stem(file.name), samples.map(sample => ({
            name: `${sample.name}.wav`,
            read: async () => SamplerImport.encodeWav(sample)
        })))
    }

    const importSfz = async (service: StudioService, adapter: SamplerDeviceBoxAdapter, file: File,
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
        await store(service, adapter, instrument, stem(file.name), sources)
        if (missing > 0) {
            await RuntimeNotifier.info({
                headline: "Samples Missing",
                message: `${missing} of ${sources.length} samples that '${file.name}' names were not chosen. Their sample zones were left out.`
            })
        }
    }

    // Stores each sample once (a sample that is already there is found by its content), files them under
    // Multi Samples and turns the instrument into the Sampler's zones.
    const store = async (service: StudioService, adapter: SamplerDeviceBoxAdapter, instrument: SamplerImport.Instrument,
                         folder: string, sources: ReadonlyArray<Optional<Source>>): Promise<void> => {
        const {project} = service
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
            stored.push(imported.status === "resolved" ? imported.value : undefined)
        }
        dialog.terminate()
        const uuids = stored.filter(isDefined).map(sample => sample.uuid)
        uuids.forEach(uuid => project.trackUserCreatedSample(UUID.parse(uuid)))
        const structureFile = SampleStorage.get().structure
        const structure = (await structureFile.load()).unwrapOrElse(StructureFile.Empty)
        await structureFile.save(ResourceStructures.place(structure, [Folder, folder], uuids))
        if (!adapter.box.isAttached()) {return}
        const {boxGraph, editing} = project
        editing.modify(() => SamplerImport.apply(boxGraph, adapter.box, instrument, stored.map(sample => {
            if (!isDefined(sample)) {return undefined}
            const uuid = UUID.parse(sample.uuid)
            return boxGraph.findBox<AudioFileBox>(uuid).unwrapOrElse(() => AudioFileBox.create(boxGraph, uuid, box => {
                box.fileName.setValue(sample.name)
                box.endInSeconds.setValue(sample.duration)
            }))
        })))
    }
}
