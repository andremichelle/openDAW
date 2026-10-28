import css from "./SampleEditorDialogs.sass?inline"
import {clamp, DefaultObservableValue, Errors, Option, StringMapping, Terminator} from "@opendaw/lib-std"
import {Html} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {Promises} from "@opendaw/lib-runtime"
import {SampleEffect} from "@opendaw/lib-dsp"
import {Sample} from "@opendaw/studio-adapters"
import {Dialogs} from "@/ui/components/dialogs"
import {Dialog} from "@/ui/components/Dialog"
import {Surface} from "@/ui/surface/Surface"
import {IconSymbol} from "@opendaw/studio-enums"
import {NumberInput} from "@/ui/components/NumberInput"
import {SearchInput} from "@/ui/components/SearchInput"
import {TextInput} from "@/ui/components/TextInput"
import {AudioFormatSelector} from "@/ui/components/AudioFormatSelector"
import {AudioFormats} from "@/audio/AudioFormats"

const className = Html.adoptStyleSheet(css, "SampleEditorDialogs")

const OpenRequest = Symbol("open")

const ExportExtensions: ReadonlySet<string> = new Set(["wav", "flac"])

export namespace SampleEditorDialogs {
    const exportFormat = new DefaultObservableValue<AudioFormats.Format>(AudioFormats.All[0])

    const rejectAborted = (error: unknown): Promise<never> => Promise.reject(Errors.isAbort(error) ? Errors.AbortError : error)

    export const pickSample = async (samples: ReadonlyArray<Sample>): Promise<Sample> => {
        const lifecycle = new Terminator()
        const filter = new DefaultObservableValue("")
        const selected = new DefaultObservableValue<Option<Sample>>(Option.None)
        const list: HTMLElement = <div className="samples"/>
        const opening = new AbortController()
        const rows = samples.toSorted((a, b) => a.name.localeCompare(b.name)).map(sample => {
            const row: HTMLElement = (
                <div className="sample"
                     onclick={() => selected.setValue(Option.wrap(sample))}
                     ondblclick={() => {
                         selected.setValue(Option.wrap(sample))
                         opening.abort(OpenRequest)
                     }}>
                    <span>{sample.name}</span>
                    <span className="duration">{`${sample.duration.toFixed(1)}s`}</span>
                </div>
            )
            return {sample, row}
        })
        const render = () => {
            const query = filter.getValue().trim().toLowerCase()
            Html.empty(list)
            rows.filter(({sample: {name}}) => name.toLowerCase().includes(query)).forEach(({row}) => list.append(row))
        }
        lifecycle.ownAll(
            filter.catchupAndSubscribe(render),
            selected.subscribe(owner => rows.forEach(({sample, row}) =>
                row.classList.toggle("selected", owner.getValue().contains(sample)))))
        const {status, error} = await Promises.tryCatch(Dialogs.show({
            headline: "Open Sample",
            content: (
                <div className={Html.buildClassList(className, "picker")}>
                    <SearchInput lifecycle={lifecycle} model={filter} placeholder="Filter"/>
                    {list}
                </div>
            ),
            okText: "Open",
            buttons: [{text: "Cancel", primary: false, onClick: handler => handler.close()}],
            abortSignal: opening.signal
        }))
        lifecycle.terminate()
        if (status === "rejected" && error !== OpenRequest) {return rejectAborted(error)}
        const sample = selected.getValue()
        return sample.isEmpty() ? Promise.reject(Errors.AbortError) : sample.unwrap()
    }

    export const editParameters = async (effect: SampleEffect,
                                         initial: ReadonlyArray<number>): Promise<ReadonlyArray<number>> => {
        const lifecycle = new Terminator()
        const models = effect.parameters.map((_parameter, index) => new DefaultObservableValue(initial[index]))
        const {status, error} = await Promises.tryCatch(Dialogs.show({
            headline: effect.name,
            content: (
                <div className={Html.buildClassList(className, "parameters")}>
                    {effect.parameters.map(({name, min, max, unit}, index) => [
                        <span>{name}</span>,
                        <NumberInput lifecycle={lifecycle}
                                     model={models[index]}
                                     maxChars={5}
                                     mapper={StringMapping.numeric({fractionDigits: 0})}
                                     guard={{guard: (value: number) => clamp(Math.round(value), min, max)}}/>,
                        <span className="unit">{unit}</span>
                    ])}
                </div>
            ),
            okText: "Apply",
            buttons: [{text: "Cancel", primary: false, onClick: handler => handler.close()}]
        }))
        lifecycle.terminate()
        if (status === "rejected") {return rejectAborted(error)}
        return models.map(model => model.getValue())
    }

    export const askName = async (initial: string): Promise<string> => {
        const lifecycle = new Terminator()
        const {resolve, reject, promise} = Promise.withResolvers<string>()
        promise.finally(() => lifecycle.terminate())
        const name = new DefaultObservableValue(initial)
        const input = <TextInput lifecycle={lifecycle} model={name} maxChars={64}/>
        const approve = (): void => {
            const trimmed = name.getValue().trim()
            resolve(trimmed.length === 0 ? initial : trimmed)
        }
        const dialog: HTMLDialogElement = (
            <Dialog headline="Save As New Sample"
                    icon={IconSymbol.Waveform}
                    cancelable={true}
                    onCancel={() => reject(Errors.AbortError)}
                    buttons={[{
                        text: "Cancel",
                        onClick: handler => handler.close()
                    }, {
                        text: "Save",
                        primary: true,
                        onClick: handler => {
                            approve()
                            handler.close()
                        }
                    }]}>
                <div className={Html.buildClassList(className, "name")}>
                    <div>Name:</div>
                    {input}
                </div>
            </Dialog>
        )
        dialog.onkeydown = event => {
            if (event.code !== "Enter") {return}
            event.preventDefault()
            approve()
            dialog.close()
        }
        Surface.get().flyout.appendChild(dialog)
        dialog.showModal()
        input.focus()
        return promise
    }

    export const chooseFormat = async (): Promise<AudioFormats.Format> => {
        const formats = (await AudioFormats.available()).filter(({extension}) => ExportExtensions.has(extension))
        if (!formats.includes(exportFormat.getValue())) {exportFormat.setValue(formats[0])}
        const lifecycle = new Terminator()
        const {status, error} = await Promises.tryCatch(Dialogs.show({
            headline: "Export Sample",
            content: AudioFormatSelector({lifecycle, formats, model: exportFormat}),
            okText: "Export",
            buttons: [{text: "Cancel", primary: false, onClick: handler => handler.close()}]
        }))
        lifecycle.terminate()
        if (status === "rejected") {return rejectAborted(error)}
        return exportFormat.getValue()
    }
}
