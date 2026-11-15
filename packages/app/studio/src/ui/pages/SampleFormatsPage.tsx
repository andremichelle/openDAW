import css from "./SampleFormatsPage.sass?inline"
import {Bytes, DefaultObservableValue, EmptyExec, MutableObservableOption, RuntimeNotifier, Terminator, UUID} from "@opendaw/lib-std"
import {createElement, LocalLink, PageContext, PageFactory} from "@opendaw/lib-jsx"
import {Events, Html} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import {SampleConversion} from "@opendaw/lib-dsp"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {SampleStorage} from "@opendaw/studio-core"
import {StudioService} from "@/service/StudioService.ts"
import {BackButton} from "@/ui/pages/BackButton"
import {Button} from "@/ui/components/Button"
import {Checkbox} from "@/ui/components/Checkbox"
import {Icon} from "@/ui/components/Icon"
import {RadioGroup} from "@/ui/components/RadioGroup"
import {StorageInspector} from "@/storage/StorageInspector"
import {SampleFormats} from "@/storage/SampleFormats"

const className = Html.adoptStyleSheet(css, "SampleFormatsPage")

const TabLabels: Record<SampleConversion.Kind, string> = {
    "exact": "Without loss", "rounding": "By rounding", "scaling": "By lowering", "float": "Stay 32 bit", "sixteen": "16 bit"
}

const TabNotes: Record<SampleConversion.Kind, string> = {
    "exact": "These samples hold only values that 16 bit stores exactly. Converting changes nothing you hear or measure.",
    "rounding": "These samples stay below 0 dB but hold finer values than 16 bit has. Converting rounds every value "
        + "to the nearest step. It cannot be undone.",
    "scaling": "These samples peak up to 0.1 dB above 0 dB. Converting lowers them to 0 dB and rounds every value "
        + "to the nearest step. It cannot be undone.",
    "float": "These samples peak more than 0.1 dB above 0 dB. They stay 32 bit float.",
    "sixteen": "These samples are stored as 16 bit already."
}

export const SampleFormatsPage: PageFactory<StudioService> = ({lifecycle, service}: PageContext<StudioService>) => {
    const tab = new DefaultObservableValue<SampleConversion.Kind>("exact")
    const reportTerminator = lifecycle.own(new Terminator())
    const listTerminator = lifecycle.own(new Terminator())
    const playback = service.samplePlayback
    lifecycle.own({terminate: () => playback.eject()})
    const summary: HTMLElement = <div className="summary"/>
    const tabs: HTMLElement = <div className="tabs"/>
    const note: HTMLElement = <p className="note"/>
    const list: HTMLElement = <div className="list"/>
    const current = new MutableObservableOption<SampleFormats.Report>()
    const chosen = new Set<string>()
    const convertLabel: HTMLElement = <span/>
    const chosenOf = (report: SampleFormats.Report): ReadonlyArray<SampleFormats.Entry> =>
        report.entries.filter(entry => chosen.has(entry.id) && SampleConversion.isConvertible(entry.kind))
    const updateConvertLabel = (): void => {
        const entries = current.mapOr(report => chosenOf(report), [])
        convertLabel.textContent = entries.length === 0
            ? "Nothing selected"
            : `Convert ${entries.length} selected (frees ${Bytes.toString(SampleFormats.savingOf(entries))})...`
    }
    const preview = (entry: SampleFormats.Entry): HTMLElement => {
        const element: HTMLElement = <span className="preview" title="Play / Stop"><Icon symbol={IconSymbol.Play}/></span>
        listTerminator.ownAll(
            playback.subscribe(entry.id, event => {
                element.classList.remove("buffering", "playing", "error")
                element.classList.add(event.type)
            }),
            Events.subscribe(element, "click", () => playback.toggle(entry.id)))
        return element
    }
    const toggle = (entries: ReadonlyArray<SampleFormats.Entry>, selected: boolean): void => {
        entries.forEach(({id}) => {if (selected) {chosen.add(id)} else {chosen.delete(id)}})
    }
    const renderList = (report: SampleFormats.Report): void => {
        listTerminator.terminate()
        Html.empty(list)
        const kind = tab.getValue()
        const entries = SampleFormats.ofKind(report.entries, kind)
        const convertible = SampleConversion.isConvertible(kind)
        note.textContent = TabNotes[kind]
        list.className = convertible ? "list convertible" : "list"
        const all = listTerminator.own(new DefaultObservableValue(entries.length > 0 && entries.every(({id}) => chosen.has(id))))
        // a row follows the box above it, the box follows its rows: neither answers the other's change
        let following = false
        if (convertible) {
            listTerminator.own(all.subscribe(owner => {
                if (following) {return}
                toggle(entries, owner.getValue())
                renderList(report)
                updateConvertLabel()
            }))
            list.append(
                <div className="check" title="Select all">
                    <Checkbox lifecycle={listTerminator} model={all} appearance={{framed: true, color: Colors.black}}>
                        <Icon symbol={IconSymbol.Checkbox}/>
                    </Checkbox>
                </div>)
        }
        list.append(<h4>Name</h4>, <h4>Peak</h4>, <h4>Result</h4>, <h4>Size</h4>, <h4>Frees</h4>)
        entries.forEach(entry => {
            if (convertible) {
                const model = listTerminator.own(new DefaultObservableValue(chosen.has(entry.id)))
                listTerminator.own(model.subscribe(owner => {
                    toggle([entry], owner.getValue())
                    following = true
                    all.setValue(entries.every(({id}) => chosen.has(id)))
                    following = false
                    updateConvertLabel()
                }))
                list.append(
                    <div className="check">
                        <Checkbox lifecycle={listTerminator} model={model} appearance={{framed: true, color: Colors.black}}>
                            <Icon symbol={IconSymbol.Checkbox}/>
                        </Checkbox>
                    </div>)
            }
            list.append(
                <div className="name" title={entry.id}>{preview(entry)}<span>{entry.name}</span></div>,
                <div className="peak">{SampleFormats.peakText(entry)}</div>,
                <div className="result">{SampleFormats.describe(entry)}</div>,
                <div className="size">{Bytes.toString(entry.size)}</div>,
                <div className="size">{entry.saving > 0 ? Bytes.toString(entry.saving) : ""}</div>)
        })
        if (entries.length === 0) {list.append(<div className="empty">No samples</div>)}
    }
    const convert = async (): Promise<void> => {
        const report = current.unwrap("no report")
        const entries = chosenOf(report)
        if (entries.length === 0) {return}
        const count = (kind: SampleConversion.Kind): number => entries.filter(entry => entry.kind === kind).length
        const [rounded, lowered] = [count("rounding"), count("scaling")]
        const lines = [`${entries.length} sample${entries.length === 1 ? " becomes" : "s become"} 16 bit. `
        + `That frees ${Bytes.toString(SampleFormats.savingOf(entries))}.`]
        if (rounded > 0) {lines.push(`Rounded to 16 bit: ${rounded}.`)}
        if (lowered > 0) {lines.push(`Lowered by up to 0.1 dB, then rounded: ${lowered}.`)}
        lines.push(rounded + lowered > 0 ? "This cannot be undone." : "No value changes.")
        lines.push("Projects keep playing them.")
        if (!await RuntimeNotifier.approve({
            headline: "Convert Samples", message: lines.join("\n"), approveText: "Convert", cancelText: "Cancel"
        })) {return}
        playback.eject()
        const progress = new DefaultObservableValue(0.0)
        const dialog = RuntimeNotifier.progress({headline: "Converting Samples", message: "", progress})
        const failed: Array<string> = []
        const done = new Set<string>()
        let skipped = 0
        for (const [index, entry] of entries.entries()) {
            dialog.message = entry.name
            const result = await Promises.tryCatch(Promise.resolve().then(async () => {
                const uuid = UUID.parse(entry.id)
                const converted = await SampleStorage.get().convert(uuid, entry.kind)
                if (converted) {service.sampleManager.invalidate(uuid)}
                return converted
            }))
            if (result.status === "rejected") {
                failed.push(`${entry.name}: ${String(result.error)}`)
            } else if (result.value) {
                done.add(entry.id)
            } else {
                skipped++
            }
            progress.setValue((index + 1) / entries.length)
        }
        dialog.terminate()
        done.forEach(id => chosen.delete(id))
        const notes: Array<string> = []
        if (skipped > 0) {notes.push(`${skipped} changed since the scan and ${skipped === 1 ? "was" : "were"} left alone.`)}
        if (failed.length > 0) {notes.push(`${failed.length} could not be converted:\n${failed.join("\n")}`)}
        if (notes.length > 0) {await RuntimeNotifier.info({headline: "Not Everything Was Converted", message: notes.join("\n")})}
        const next = {...report, entries: report.entries.map(entry => done.has(entry.id) ? SampleFormats.converted(entry) : entry)}
        current.wrap(next)
        renderReport(next)
    }
    const renderReport = (report: SampleFormats.Report): void => {
        reportTerminator.terminate()
        Html.empty(summary)
        const {entries} = report
        const convertible = entries.filter(entry => SampleConversion.isConvertible(entry.kind))
        updateConvertLabel()
        summary.append(
            <span>{`${entries.length} sample${entries.length === 1 ? "" : "s"}: ${Bytes.toString(SampleFormats.sizeOf(entries))}`}</span>,
            <span className="possible">
                {convertible.length === 0 ? "Nothing to convert" : `Converting all would free ${Bytes.toString(SampleFormats.savingOf(convertible))}`}
            </span>,
            <Button lifecycle={reportTerminator} onClick={() => convert().then(EmptyExec)}
                    appearance={{color: Colors.green, framed: true}}>{convertLabel}</Button>,
            <Button lifecycle={reportTerminator} onClick={() => scan().then(EmptyExec)} appearance={{color: Colors.blue, framed: true}}>
                <span>Rescan</span>
            </Button>)
        if (report.failures.length > 0) {
            summary.append(<span className="failures" title={report.failures.join("\n")}>{`${report.failures.length} unreadable`}</span>)
        }
        Html.empty(tabs)
        tabs.append(<RadioGroup lifecycle={reportTerminator} model={tab} appearance={{framed: true}}
                                elements={SampleFormats.KindOrder.map(kind => ({
                                    value: kind,
                                    element: <span>{`${TabLabels[kind]} (${SampleFormats.ofKind(entries, kind).length})`}</span>
                                }))}/>)
        reportTerminator.own(tab.catchupAndSubscribe(() => renderList(report)))
    }
    const scan = async (settle: boolean = true): Promise<void> => {
        const progress = new DefaultObservableValue(0.0)
        const dialog = RuntimeNotifier.progress({headline: "Reading Samples", message: "Measuring every stored sample", progress})
        const result = await Promises.tryCatch(StorageInspector.scanSampleFormats(value => progress.setValue(value)))
        dialog.terminate()
        if (result.status === "rejected") {
            return RuntimeNotifier.info({headline: "Could not read the samples", message: String(result.error)})
        }
        const report = result.value
        if (settle && report.leftovers.length > 0) {
            for (const id of report.leftovers) {await Promises.tryCatch(Promise.resolve().then(() => SampleStorage.get().settle(UUID.parse(id))))}
            return scan(false)
        }
        // the lossless conversions are chosen up front, the others are a decision
        chosen.clear()
        report.entries.filter(({kind}) => kind === "exact").forEach(({id}) => chosen.add(id))
        current.wrap(report)
        renderReport(report)
    }
    scan().then(EmptyExec)
    return (
        <div className={className}>
            <BackButton lifecycle={lifecycle} service={service}/>
            <h1>Sample Optimisation</h1>
            <p className="disclaimer">
                openDAW stores a sample as 16 bit when nothing is lost by it, which takes half the space of 32 bit
                float. Samples stored before that was possible are still 32 bit. This page converts them. It only
                covers your own samples in the storage of this browser, not the cached samples of the openDAW
                cloud. See <LocalLink href="/storage">Storage</LocalLink> for everything else.
            </p>
            {summary}
            {tabs}
            {note}
            <div className="list-wrapper">{list}</div>
        </div>
    )
}
