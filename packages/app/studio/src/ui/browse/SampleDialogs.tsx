import {Dialog} from "@/ui/components/Dialog"
import {Sample, SampleMetaData} from "@opendaw/studio-adapters"
import {IconSymbol} from "@opendaw/studio-enums"
import {Surface} from "@/ui/surface/Surface"
import {createElement} from "@opendaw/lib-jsx"
import {Errors, isDefined, RuntimeNotifier} from "@opendaw/lib-std"

export namespace SampleDialogs {
    type NameAndBpm = { name: string, bpm: number }

    const showNameAndBpmDialog = async (headline: string,
                                        approveText: string,
                                        initial: NameAndBpm,
                                        note?: string): Promise<NameAndBpm> => {
        const {resolve, reject, promise} = Promise.withResolvers<NameAndBpm>()
        const inputName: HTMLInputElement = <input className="default"
                                                   type="text"
                                                   value={initial.name}
                                                   placeholder="Enter a name"/>
        inputName.select()
        inputName.focus()
        const inputBpm: HTMLInputElement = <input className="default" type="number" value={String(initial.bpm)}/>
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
                    {inputBpm}
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

    export const showEditSampleDialog = async (sample: Sample): Promise<Sample> => {
        if (sample.origin === "openDAW") {
            return Promise.reject("Cannot change sample from the cloud")
        }
        const {name, bpm} = await showNameAndBpmDialog("Edit Sample", "Save", sample)
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