import {DefaultObservableValue, Errors, isDefined, Option, Optional, panic, RuntimeNotifier} from "@opendaw/lib-std"
import {AudioData} from "@opendaw/lib-dsp"
import {Files} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import {SampleLoader, SamplerDeviceBoxAdapter, SamplerImport, SamplerSoundfontExport} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService"
import {SamplerText} from "./SamplerText"
import {Dialogs} from "@/ui/components/dialogs"

// Saves a Sampler as a soundfont (.sf2). Loaded on demand, the studio does not carry it at boot.
export namespace SamplerExporter {
    const Types: Array<FilePickerAcceptType> = [{description: "Soundfont", accept: {"application/octet-stream": [".sf2"]}}]

    const stem = (name: string): string => name.replace(/\.[A-Za-z0-9]+$/, "")

    const loaded = (loader: SampleLoader): Promise<Option<AudioData>> =>
        SampleLoader.frames(loader).then(audio => Option.wrap(audio), () => Option.None)

    export const save = async (service: StudioService, adapter: SamplerDeviceBoxAdapter): Promise<void> => {
        const {sampleManager} = service.project
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
            const optAudio = await loaded(sampleManager.getOrCreate(file.address.uuid))
            if (optAudio.isEmpty()) {
                samples.push(undefined)
                continue
            }
            const audio = optAudio.unwrap()
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
        const {count} = SamplerText
        if (clipped > 0) {notes.push(`${count(clipped, "frame is", "frames are")} louder than full scale and will be clipped, a soundfont stores 16 bit.`)}
        if (missing > 0) {notes.push(`${missing} of ${count(samples.length, "sample", "samples")} could not be loaded, ${missing === 1 ? "its" : "their"} sample zones are left out.`)}
        if (skipped > 0) {notes.push(`${count(skipped, "sample zone is", "sample zones are")} left out, a soundfont has no round robins and no release triggers.`)}
        const buffer = SamplerSoundfontExport.encode(instrument, samples)
        const approved = await RuntimeNotifier.approve({
            headline: "Export Soundfont",
            message: [`'${instrument.name}' with ${count(samples.length - missing, "sample", "samples")}.`, ...notes].join("\n\n"),
            approveText: "Save"
        })
        if (!approved) {return}
        const {status, error} = await Promises.tryCatch(Files.save(buffer, {suggestedName: `${instrument.name}.sf2`, types: Types}))
        if (status === "rejected" && !Errors.isAbort(error)) {return panic(String(error))}
    }
}
