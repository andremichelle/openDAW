import {Dialog} from "@/ui/components/Dialog"
import {BpmDetector, Sample, SampleMetaData} from "@opendaw/studio-adapters"
import {IconSymbol} from "@opendaw/studio-enums"
import {Surface} from "@/ui/surface/Surface"
import {createElement} from "@opendaw/lib-jsx"
import {Errors, isDefined, Option, Progress, Provider, RuntimeNotifier, UUID} from "@opendaw/lib-std"
import {bpm} from "@opendaw/lib-dsp"
import {Promises} from "@opendaw/lib-runtime"
import {SampleStorage} from "@opendaw/studio-core"
import {TextButton} from "@/ui/components/TextButton"

export namespace SampleDialogs {
    type NameAndBpm = { name: string, bpm: number }

    // Sample libraries state whole tempos. A measurement of 139.9995 is a person's 140, and showing them the
    // float only invites them to retype it.
    const snap = (value: bpm): bpm => {
        const rounded = Math.round(value)
        return Math.abs(value - rounded) / value < 0.005 ? rounded : Math.round(value * 10) / 10
    }

    const showNameAndBpmDialog = async (headline: string,
                                        approveText: string,
                                        initial: NameAndBpm,
                                        note?: string,
                                        analyse?: Provider<Promise<Option<bpm>>>): Promise<NameAndBpm> => {
        const {resolve, reject, promise} = Promise.withResolvers<NameAndBpm>()
        const inputName: HTMLInputElement = <input className="default"
                                                   type="text"
                                                   value={initial.name}
                                                   placeholder="Enter a name"/>
        inputName.select()
        inputName.focus()
        const inputBpm: HTMLInputElement = <input className="default" type="number" value={String(initial.bpm)}/>
        const detected: HTMLElement = <div style={{opacity: "0.6", padding: "0.25em 0"}}/>
        // Half and double time are the one thing tempo detection cannot settle on its own, and only a
        // listener can. So the correction is one click rather than a retype.
        const scale = (factor: number) => {
            const current = parseFloat(inputBpm.value)
            if (!isFinite(current) || current <= 0) {return}
            inputBpm.value = String(Math.round(current * factor * 10) / 10)
            detected.textContent = `${inputBpm.value} bpm · ${factor > 1 ? "double" : "half"} of the detected tempo`
        }
        const runAnalysis = async (provider: Provider<Promise<Option<bpm>>>) => {
            detected.textContent = "analysing…"
            const {status, value, error} = await Promises.tryCatch(provider())
            if (status === "rejected") {
                detected.textContent = String(error)
                return
            }
            // The measurement goes into the field, so saving without touching anything accepts it, and the
            // number stays editable for the cases where it is wrong.
            value.match<void>({
                none: () => {detected.textContent = "no tempo found"},
                some: measured => {
                    const snapped = snap(measured)
                    inputBpm.value = String(snapped)
                    detected.textContent = `detected ${snapped} bpm`
                }
            })
        }
        const tempo: HTMLElement = (
            <div style={{display: "flex", alignItems: "center", columnGap: "0.25em"}}>
                {inputBpm}
                {isDefined(analyse) && <TextButton onClick={() => runAnalysis(analyse)}>Analyse</TextButton>}
                {isDefined(analyse) && <TextButton onClick={() => scale(0.5)}>÷2</TextButton>}
                {isDefined(analyse) && <TextButton onClick={() => scale(2)}>×2</TextButton>}
            </div>
        )
        const approve = () => {
            const name = inputName.value
            if (name.trim().length < 3) {
                RuntimeNotifier.notify({message: "Name must be at least 3 letters long.", icon: "Info"})
                return false
            }
            const bpm = parseFloat(inputBpm.value)
            if (isNaN(bpm) || bpm < 0) {
                RuntimeNotifier.notify({message: "BPM must be zero (unknown) or a positive number.", icon: "Info"})
                return false
            }
            resolve({name, bpm})
            return true
        }
        const dialog: HTMLDialogElement = (
            <Dialog headline={headline}
                    icon={IconSymbol.Waveform}
                    cancelable={true}
                    buttons={[{
                        text: approveText,
                        primary: true,
                        onClick: handler => {
                            if (approve()) {
                                handler.close()
                            }
                        }
                    }]}>
                <div style={{padding: "1em 0", display: "grid", gridTemplateColumns: "auto 1fr", columnGap: "1em"}}>
                    <div>Name:</div>
                    {inputName}
                    <div>Bpm:</div>
                    {tempo}
                    <div/>
                    {detected}
                </div>
                {isDefined(note) && <div style={{opacity: "0.6", paddingBottom: "1em"}}>{note}</div>}
            </Dialog>
        )
        dialog.oncancel = () => reject(Errors.AbortError)
        dialog.onkeydown = event => {
            if (event.code === "Enter") {
                if (approve()) {
                    dialog.close()
                }
            }
        }
        Surface.get().flyout.appendChild(dialog)
        dialog.showModal()
        return promise
    }

    export const showEditSampleDialog = async (sample: Sample, detector: BpmDetector): Promise<Sample> => {
        if (sample.origin === "openDAW") {
            return Promise.reject("Cannot change sample from the cloud")
        }
        // The same measurement the import runs, on the audio as it is stored. Zero means unknown and is
        // reported as such rather than dressed up as a tempo.
        const analyse = async (): Promise<Option<bpm>> => {
            const [audio] = await SampleStorage.get().load(UUID.parse(sample.uuid))
            return detector.detect(audio, Progress.Empty)
        }
        const {name, bpm} = await showNameAndBpmDialog("Edit Sample", "Save", sample, undefined, analyse)
        sample.name = name
        sample.bpm = bpm
        return sample
    }

    // The cloud copy is the one nobody can correct later: `showEditSampleDialog` refuses openDAW-origin
    // samples and the browser only offers editing for local ones. So the measured tempo is confirmed by a
    // person before it is published, and leaving it at zero is a legitimate answer rather than a failure.
    export const showConfirmUploadDialog = async (meta: SampleMetaData): Promise<SampleMetaData> => {
        const {name, bpm} = await showNameAndBpmDialog("Upload Sample", "Upload", meta,
            "Bpm was measured from the audio. Zero means unknown, which keeps the sample unwarped. "
            + "This cannot be changed once uploaded.")
        return {...meta, name, bpm}
    }
}