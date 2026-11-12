import {DefaultObservableValue, Errors, isDefined, Optional, panic, RuntimeNotifier} from "@opendaw/lib-std"
import {AudioData} from "@opendaw/lib-dsp"
import {Files} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import {SampleLoader, SamplerDeviceBoxAdapter, SamplerImport, SamplerSoundfontExport} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService"
import {Dialogs} from "@/ui/components/dialogs"

// Saves a Sampler as a soundfont (.sf2). Loaded on demand, the studio does not carry it at boot.
export namespace SamplerExporter {
    const Types: Array<FilePickerAcceptType> = [{description: "Soundfont", accept: {"application/octet-stream": [".sf2"]}}]

    const stem = (name: string): string => name.replace(/\.[A-Za-z0-9]+$/, "")

    const loaded = (loader: SampleLoader): Promise<Optional<AudioData>> => new Promise(resolve => {
        if (loader.data.nonEmpty() || loader.state.type === "error") {return resolve(loader.data.unwrapOrUndefined())}
        const subscription = loader.subscribe(state => {
            if (state.type !== "loaded" && state.type !== "error") {return}
            subscription.terminate()
            resolve(loader.data.unwrapOrUndefined())
        })
    })

    export const save = async (service: StudioService, adapter: SamplerDeviceBoxAdapter): Promise<void> => {
        const {instrument, files, skipped} = SamplerSoundfontExport.describe(adapter.box)
        if (instrument.zones.length === 0) {
            await RuntimeNotifier.info({headline: "Nothing to Export", message: "This Sampler has no sample zones."})
            return
        }
        const progress = new DefaultObservableValue(0.0)
        const dialog = Dialogs.progress({headline: "Exporting Soundfont", message: "", progress})
        const samples: Array<Optional<SamplerImport.Sample>> = []
        let clipped = 0
        for (const [index, file] of files.entries()) {
            progress.setValue(index / files.length)
            dialog.message = file.fileName.getValue()
            const audio = await loaded(service.project.sampleManager.getOrCreate(file.address.uuid))
            if (!isDefined(audio)) {
                samples.push(undefined)
                continue
            }
            const channels = audio.frames.slice(0, 2).map(frames => {
                const quantized = SamplerSoundfontExport.quantize(frames)
                clipped += quantized.clipped
                return quantized.frames
            })
            samples.push({name: stem(file.fileName.getValue()), sampleRate: audio.sampleRate, channels})
        }
        dialog.terminate()
        const missing = samples.filter(sample => !isDefined(sample)).length
        const notes: Array<string> = []
        if (clipped > 0) {notes.push(`${clipped} frames are louder than full scale and will be clipped, a soundfont stores 16 bit.`)}
        if (missing > 0) {notes.push(`${missing} of ${samples.length} samples could not be loaded, their sample zones are left out.`)}
        if (skipped > 0) {notes.push(`${skipped} sample zones are left out, a soundfont has no round robins and no release triggers.`)}
        const buffer = SamplerSoundfontExport.encode(instrument, samples)
        const approved = await RuntimeNotifier.approve({
            headline: "Export Soundfont",
            message: [`'${instrument.name}' with ${samples.length - missing} samples.`, ...notes].join("\n\n"),
            approveText: "Save"
        })
        if (!approved) {return}
        const {status, error} = await Promises.tryCatch(Files.save(buffer, {suggestedName: `${instrument.name}.sf2`, types: Types}))
        if (status === "rejected" && !Errors.isAbort(error)) {return panic(String(error))}
    }
}
