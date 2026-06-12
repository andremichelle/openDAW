import {Dialog} from "@/ui/components/Dialog"
import {Sample} from "@opendaw/studio-adapters"
import {IconSymbol} from "@opendaw/studio-enums"
import {Surface} from "@/ui/surface/Surface"
import {createElement} from "@opendaw/lib-jsx"
import {Errors, RuntimeNotifier} from "@opendaw/lib-std"

export namespace SampleDialogs {
    export const showEditSampleDialog = async (sample: Sample): Promise<Sample> => {
        if (sample.origin === "openDAW") {
            return Promise.reject("Cannot change sample from the cloud")
        }
        const {resolve, reject, promise} = Promise.withResolvers<Sample>()
        const inputName: HTMLInputElement = <input className="default"
                                                   type="text"
                                                   value={sample.name}
                                                   placeholder="Enter a name"/>
        inputName.select()
        inputName.focus()
        const inputBpm: HTMLInputElement = <input className="default" type="number" value={String(sample.bpm)}/>
        const approve = () => {
            const name = inputName.value
            if (name.trim().length < 3) {
                RuntimeNotifier.notify({message: "Name must be at least 3 letters long.", icon: "Info"})
                return false
            }
            const bpm = parseFloat(inputBpm.value)
            if (isNaN(bpm)) {
                RuntimeNotifier.notify({message: "BPM must be a number.", icon: "Info"})
                return false
            }
            sample.name = name
            sample.bpm = bpm
            resolve(sample)
            return true
        }
        const dialog: HTMLDialogElement = (
            <Dialog headline="Edit Sample"
                    icon={IconSymbol.Waveform}
                    cancelable={true}
                    buttons={[{
                        text: "Save",
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
}