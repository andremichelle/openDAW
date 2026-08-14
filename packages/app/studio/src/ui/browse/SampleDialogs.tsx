import css from "./SampleDialogs.sass?inline"
import {Dialog} from "@/ui/components/Dialog"
import {BpmDetector, Sample, SampleMetaData} from "@opendaw/studio-adapters"
import {IconSymbol} from "@opendaw/studio-enums"
import {Surface} from "@/ui/surface/Surface"
import {createElement, Frag} from "@opendaw/lib-jsx"
import {
    DefaultObservableValue,
    Errors,
    isDefined,
    isInstanceOf,
    Option,
    Progress,
    Provider,
    RuntimeNotifier,
    StringMapping,
    Terminator,
    UUID
} from "@opendaw/lib-std"
import {bpm} from "@opendaw/lib-dsp"
import {Promises} from "@opendaw/lib-runtime"
import {SampleStorage} from "@opendaw/studio-core"
import {Button} from "@/ui/components/Button"
import {TextInput} from "@/ui/components/TextInput"
import {NumberInput} from "@/ui/components/NumberInput"
import {Html} from "@opendaw/lib-dom"
import {FlexSpacer} from "@/ui/components/FlexSpacer"

const className = Html.adoptStyleSheet(css, "SampleDialog")

export namespace SampleDialogs {
    type NameAndBpm = { name: string, bpm: number }

    const snap = (value: bpm): bpm => {
        const rounded = Math.round(value)
        return Math.abs(value - rounded) / value < 0.005 ? rounded : Math.round(value * 10) / 10
    }

    const showNameAndBpmDialog = async (headline: string,
                                        approveText: string,
                                        initial: NameAndBpm,
                                        note?: string,
                                        analyse?: Provider<Promise<Option<bpm>>>): Promise<NameAndBpm> => {
        const lifecycle = new Terminator()
        const {resolve, reject, promise} = Promise.withResolvers<NameAndBpm>()
        promise.finally(() => lifecycle.terminate())
        const name = new DefaultObservableValue(initial.name)
        const tempoValue = new DefaultObservableValue(initial.bpm)
        const inputName = <TextInput lifecycle={lifecycle} model={name} maxChars={64}/>
        const inputBpm = <NumberInput lifecycle={lifecycle}
                                      model={tempoValue}
                                      maxChars={6}
                                      step={1}
                                      mapper={StringMapping.numeric({fractionDigits: 1})}
                                      guard={{guard: value => Math.max(0, value)}}/>
        const scale = (factor: number) => {
            const current = tempoValue.getValue()
            if (current <= 0) {return}
            tempoValue.setValue(Math.round(current * factor * 10) / 10)
        }
        const runAnalysis = async (provider: Provider<Promise<Option<bpm>>>) => {
            const {status, value, error} = await Promises.tryCatch(provider())
            if (status === "rejected") {
                RuntimeNotifier.notify({message: String(error), icon: "Warning"})
                return
            }
            tempoValue.setValue(value.mapOr(snap, 0))
        }
        const tempo: HTMLElement = (
            <div className="tempo">
                {inputBpm}
                {isDefined(analyse) && (
                    <Frag>
                        <FlexSpacer/>
                        <Button lifecycle={lifecycle}
                                onClick={() => runAnalysis(analyse)}
                                appearance={{framed: true, cursor: "pointer", tooltip: "Measure the tempo"}}>
                            Analyse
                        </Button>
                        <Button lifecycle={lifecycle}
                                onClick={() => scale(0.5)}
                                appearance={{framed: true, cursor: "pointer", tooltip: "Half time"}}>
                            ÷2
                        </Button>
                        <Button lifecycle={lifecycle}
                                onClick={() => scale(2)}
                                appearance={{framed: true, cursor: "pointer", tooltip: "Double time"}}>
                            ×2
                        </Button>
                    </Frag>
                )}
            </div>
        )
        const approve = () => {
            // NumberInput writes its model on focusout, and clicking a button label does not blur it.
            if (isInstanceOf(document.activeElement, HTMLElement)) {document.activeElement.blur()}
            const trimmed = name.getValue().trim()
            if (trimmed.length < 3) {
                RuntimeNotifier.notify({message: "Name must be at least 3 letters long.", icon: "Info"})
                return false
            }
            resolve({name: trimmed, bpm: tempoValue.getValue()})
            return true
        }
        const dialog: HTMLDialogElement = (
            <Dialog headline={headline}
                    icon={IconSymbol.Waveform}
                    cancelable={true}
                    onCancel={() => reject(Errors.AbortError)}
                    buttons={[{
                        text: "Cancel",
                        onClick: handler => handler.close()
                    }, {
                        text: approveText,
                        primary: true,
                        onClick: handler => {
                            if (approve()) {
                                handler.close()
                            }
                        }
                    }]}>
                <div className={className}>
                    <div>Name:</div>
                    {inputName}
                    <div>Bpm:</div>
                    {tempo}
                    {isDefined(note) && <div className="note">{note}</div>}
                </div>
            </Dialog>
        )
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