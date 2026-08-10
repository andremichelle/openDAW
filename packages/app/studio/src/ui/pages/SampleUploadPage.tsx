import css from "./SampleUploadPage.sass?inline"
import {createElement, PageContext, PageFactory} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {Files, Html} from "@opendaw/lib-dom"
import {Dialogs} from "@/ui/components/dialogs.tsx"
import {AudioData, WavFile} from "@opendaw/lib-dsp"
import {Errors, Progress} from "@opendaw/lib-std"
import {FilePickerAcceptTypes} from "@opendaw/studio-core"
import {SampleDialogs} from "@/ui/browse/SampleDialogs.tsx"
import {OpenSampleAPI} from "@/opendaw-api"

const className = Html.adoptStyleSheet(css, "SampleUploadPage")

export const SampleUploadPage: PageFactory<StudioService> = ({service}: PageContext<StudioService>) => {
    return (
        <div className={className}>
            <h1>Upload Sample</h1>
            <div>
                <button onclick={async () => {
                    try {
                        const [file] = await Files.open(FilePickerAcceptTypes.WavFiles)
                        const arrayBuffer = await file.arrayBuffer()
                        if (arrayBuffer.byteLength === 0) {return}
                        const buffer = await service.audioContext.decodeAudioData(arrayBuffer.slice())
                        const name = file.name.substring(0, file.name.lastIndexOf(".wav"))
                        const sample_rate = buffer.sampleRate
                        const duration = buffer.duration
                        const audioData = AudioData.create(sample_rate, buffer.length, buffer.numberOfChannels)
                        audioData.frames.forEach((frames, channel) => frames.set(buffer.getChannelData(channel)))
                        // The same detector the import path uses, rather than a second opinion derived from
                        // the duration: this value ships to every user who later downloads the sample.
                        const optBpm = await service.sampleService.bpmDetector.detect(audioData, Progress.Empty)
                        const meta = await SampleDialogs.showConfirmUploadDialog({
                            name, bpm: optBpm.unwrapOrElse(0), duration, sample_rate, origin: "openDAW"
                        })
                        await OpenSampleAPI.get().upload(WavFile.encodeFloats(buffer), meta)
                    } catch (error) {
                        if (Errors.isAbort(error)) {
                            console.debug("Caught an AbortError")
                        } else {
                            Dialogs.info({message: String(error)}).finally()
                        }
                    }
                }}>
                    Browse
                </button>
            </div>
        </div>
    )
}