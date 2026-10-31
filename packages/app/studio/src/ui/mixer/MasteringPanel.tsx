import css from "./MasteringPanel.sass?inline"
import {
    asInstanceOf, DefaultObservableValue, isDefined, Lifecycle, MutableObservableOption, Option, Optional, panic,
    RuntimeNotifier, Terminator, UUID
} from "@opendaw/lib-std"
import {createElement, Frag} from "@opendaw/lib-jsx"
import {Events, Files, Html} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import {AudioData} from "@opendaw/lib-dsp"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {MasteringDeviceBox} from "@opendaw/studio-boxes"
import {AudioUnitBoxAdapter, AutomatableParameterFieldAdapter, MasteringDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {MixdownSection, OfflineEngineRenderer} from "@opendaw/studio-core"
import {Matchering} from "@opendaw/studio-matchering"
import {StudioService} from "@/service/StudioService"
import {Button} from "@/ui/components/Button"
import {Checkbox} from "@/ui/components/Checkbox"
import {Icon} from "@/ui/components/Icon"
import {AutomationControl} from "@/ui/components/AutomationControl"
import {DropDown} from "@/ui/composite/DropDown"
import {Column} from "@/ui/devices/Column"
import {LKR} from "@/ui/devices/constants"
import {ParameterLabelKnob} from "@/ui/devices/ParameterLabelKnob"
import {RelativeUnitValueDragging} from "@/ui/wrapper/RelativeUnitValueDragging"
import {EditWrapper} from "@/ui/wrapper/EditWrapper"
import {FlexSpacer} from "@/ui/components/FlexSpacer"

const className = Html.adoptStyleSheet(css, "MasteringPanel")

const FrequencyTicks = [
    {hz: 50, label: "50"}, {hz: 100, label: "100"}, {hz: 300, label: "300"}, {hz: 1000, label: "1k"},
    {hz: 3000, label: "3k"}, {hz: 10000, label: "10k"}
]
const GainTicks = [12, 6, 0, -6, -12]

const CURVE_BIN_HZ = 44100 / 4096
const COMPARE_KEY = 15
const CURVE_POINTS = 240
const AMOUNT_TRACK_LENGTH = 384 // pixels for the full range, three times the knob default
const AudioFiles: FilePickerOptions = {
    types: [{description: "audio", accept: {"audio/*": [".wav", ".aiff", ".aif", ".flac", ".mp3", ".ogg", ".m4a"]}}]
}

const frequencyToX = (hz: number): number => Math.log(hz / 20) / Math.log(1000)
const gainToY = (db: number): number => 50 - db * 40 / 12

const strokePath = (points: ReadonlyArray<[number, number]>): string =>
    points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ")

// the curve as the device applies it: amount blends linearly with the dry signal
const curvePoints = (curve: Float32Array, amount: number): ReadonlyArray<[number, number]> =>
    Array.from({length: CURVE_POINTS}, (_, index) => {
        const x = index / (CURVE_POINTS - 1)
        const position = Math.min(20 * 1000 ** x / CURVE_BIN_HZ, curve.length - 1)
        const lower = Math.floor(position)
        const upper = Math.min(lower + 1, curve.length - 1)
        const value = curve[lower] + (curve[upper] - curve[lower]) * (position - lower)
        const db = 20 * Math.log10(Math.max(1e-6, 1.0 + amount * (value - 1.0)))
        return [x * 400, gainToY(db)]
    })

const meterRatio = (db: number, floor: number = -60): number => Math.min(1.0, Math.max(0.0, (db - floor) / -floor))

type Reference = { name: string, profile: Option<Matchering.ReferenceProfile> }

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    outputUnit: AudioUnitBoxAdapter
}

export const MasteringPanel = ({lifecycle, service, outputUnit}: Construct) => {
    const {project} = service
    const {editing, midiLearning, boxAdapters, boxGraph, liveStreamReceiver, engine} = project
    const root: HTMLElement = <div className={className}/>
    const sections = MixdownSection.collect(project)
    const section = new DefaultObservableValue(sections[0])
    const fileReferences: Array<Reference> = []
    const reference = new DefaultObservableValue<string>(Matchering.BuiltinProfiles[0])
    const compare = new DefaultObservableValue(false)
    const busy = new DefaultObservableValue(false)
    const device = new MutableObservableOption<MasteringDeviceBoxAdapter>()
    // the last rendered mixdown, so another reference matches without rendering again (kept while the panel is open)
    const renderedTarget = new MutableObservableOption<{ sectionKey: string, audio: AudioData }>()
    const findDevice = (): Option<MasteringDeviceBoxAdapter> => Option.wrap(outputUnit.box.mastering.pointerHub.incoming().at(0))
        .map(pointer => boxAdapters.adapterFor(asInstanceOf(pointer.box, MasteringDeviceBox), MasteringDeviceBoxAdapter))
    const referenceNames = (): ReadonlyArray<string> => {
        const stored = device.map(adapter => adapter.box.referenceName.getValue()).unwrapOrElse("")
        const names = [...Matchering.BuiltinProfiles, ...fileReferences.map(({name}) => name)]
        return stored.length > 0 && !names.includes(stored) ? [...names, stored] : names
    }
    const resolveProfile = async (name: string): Promise<Matchering.ReferenceProfile> => {
        const builtin = Matchering.BuiltinProfiles.indexOf(name)
        if (builtin >= 0) {return Matchering.builtinProfile(builtin)}
        const file = fileReferences.find(entry => entry.name === name)
        if (isDefined(file) && file.profile.nonEmpty()) {return file.profile.unwrap()}
        const stored = device.map(adapter => adapter.box.referenceProfile.getValue()).unwrap(`No profile for '${name}'`)
        return stored.length > 0 ? Matchering.profileFromBytes(stored) : panic(`No profile for '${name}'`)
    }
    const browseReferenceFile = async (): Promise<void> => {
        const files = await Promises.tryCatch(Files.open(AudioFiles))
        if (files.status === "rejected" || files.value.length === 0) {return}
        return loadReferenceFile(files.value[0])
    }
    const loadReferenceFile = async (file: File): Promise<void> => {
        busy.setValue(true)
        const handler = RuntimeNotifier.progress({headline: "Reference", message: `Analysing '${file.name}'...`})
        const result = await Promises.tryCatch((async () => {
            const buffer = await service.audioContext.decodeAudioData(await file.arrayBuffer())
            const audio = AudioData.create(buffer.sampleRate, buffer.length, buffer.numberOfChannels)
            audio.frames.forEach((frames, channel) => frames.set(buffer.getChannelData(channel)))
            return Matchering.analyseReference(audio)
        })())
        handler.terminate()
        busy.setValue(false)
        if (result.status === "rejected") {
            return RuntimeNotifier.info({headline: "Reference", message: `Could not analyse '${file.name}'.`})
        }
        const name = file.name.replace(/\.[^.]+$/, "")
        fileReferences.push({name, profile: Option.wrap(result.value)})
        reference.setValue(name)
    }
    const renderTarget = async (sectionKey: string, progress: DefaultObservableValue<number>,
                                abortSignal: AbortSignal): Promise<AudioData> => {
        const source = project.copy()
        device.ifSome(adapter => source.boxGraph.findBox(adapter.uuid).ifSome(vertex =>
            source.editing.modify(() => asInstanceOf(vertex.box, MasteringDeviceBox).enabled.setValue(false))))
        const audio = await OfflineEngineRenderer.renderSection(
            source, Option.None, section.getValue(), progress, abortSignal, Matchering.SampleRate)
        renderedTarget.wrap({sectionKey, audio})
        return audio
    }
    // `render` false reuses the last mixdown of the same section (a reference change), Analyse always renders
    const analyse = async (render: boolean): Promise<void> => {
        busy.setValue(true)
        const abortController = new AbortController()
        const progress = new DefaultObservableValue(0.0)
        const sectionKey = section.getValue().key
        const cached = renderedTarget.match({
            none: () => Option.None,
            some: target => render || target.sectionKey !== sectionKey ? Option.None : Option.wrap(target.audio)
        })
        const handler = RuntimeNotifier.progress({
            headline: "Mastering", message: cached.isEmpty() ? "Rendering mixdown..." : "Matching...",
            progress, cancel: () => abortController.abort()
        })
        const result = await Promises.tryCatch((async () => {
            const profile = await resolveProfile(reference.getValue())
            const audio = await cached.match({
                none: () => renderTarget(sectionKey, progress, abortController.signal),
                some: audio => Promise.resolve(audio)
            })
            return {profile, match: await Matchering.matchTarget(audio, profile, value => handler.message = StageLabels[value])}
        })())
        handler.terminate()
        busy.setValue(false)
        if (result.status === "rejected") {
            return RuntimeNotifier.info({headline: "Mastering", message: "The analysis was cancelled or failed."})
        }
        const {profile, match} = result.value
        editing.modify(() => {
            const box = device.match({
                some: adapter => adapter.box,
                none: () => MasteringDeviceBox.create(boxGraph, UUID.generate(), box => box.host.refer(outputUnit.box.mastering))
            })
            box.matchGain.setValue(match.gain)
            box.finalAmplitude.setValue(match.finalAmplitude)
            box.midCurve.setValue(Matchering.curveToBytes(match.midCurve))
            box.sideCurve.setValue(Matchering.curveToBytes(match.sideCurve))
            box.referenceName.setValue(reference.getValue())
            box.referenceProfile.setValue(Matchering.profileToBytes(profile))
            box.section.setValue(section.getValue().key)
        })
    }
    const contentLifecycle = lifecycle.own(new Terminator())
    const render = (): void => {
        contentLifecycle.terminate()
        Html.empty(root)
        root.appendChild(renderContent(contentLifecycle, device.unwrapOrUndefined()))
    }
    const renderKnob = (lifecycle: Lifecycle, parameter: AutomatableParameterFieldAdapter<number>) => (
        <AutomationControl lifecycle={lifecycle} editing={editing} midiLearning={midiLearning}
                           tracks={outputUnit.tracks} parameter={parameter}>
            <Column ems={LKR} color={Colors.cream}>
                <h5>{parameter.name}</h5>
                <ParameterLabelKnob lifecycle={lifecycle} editing={editing} parameter={parameter}
                                    anchor={parameter.anchor}/>
            </Column>
        </AutomationControl>
    )
    const renderPlaceholderKnob = (label: string) => (
        <Column ems={LKR} color={Colors.shadow}>
            <h5>{label}</h5>
            <span className="value">–</span>
        </Column>
    )
    const renderMeter = (label: string, scale: [string, string]) => {
        const bar: HTMLElement = <div className="bar"/>
        return {
            bar, element: (
                <div className="meter">
                    <span className="label">{label}</span>
                    <div className="track">{bar}</div>
                    <span className="scale">{scale[0]}</span>
                    <span className="scale end">{scale[1]}</span>
                </div>
            )
        }
    }
    const renderContent = (lifecycle: Lifecycle, adapter: Optional<MasteringDeviceBoxAdapter>) => {
        const curve: SVGPathElement = <path className="curve"/>
        const fill: SVGPathElement = <path className="fill"/>
        const sideCurve: SVGPathElement = <path className="side"/>
        const thumb: HTMLElement = <div className="thumb"/>
        const amountValue: HTMLElement = <span className="value">–</span>
        const meters = [
            renderMeter("Peak", ["-60", "0"]), renderMeter("LUFS Short-Term", ["-60", "0"]),
            renderMeter("LUFS Integrated", ["-60", "0"]), renderMeter("Correlation", ["-1", "+1"])
        ]
        const drawCurves = (): void => {
            const amount = isDefined(adapter) ? adapter.namedParameter.amount.getControlledValue() : 1.0
            const read = (bytes: Int8Array): Float32Array => bytes.length > 0
                ? Matchering.curveFromBytes(bytes) : new Float32Array(2049).fill(1.0)
            const mid = curvePoints(read(adapter?.box.midCurve.getValue() ?? new Int8Array(0)), amount)
            const side = curvePoints(read(adapter?.box.sideCurve.getValue() ?? new Int8Array(0)), amount)
            curve.setAttribute("d", strokePath(mid))
            fill.setAttribute("d", `${strokePath(mid)} L400 50 L0 50 Z`)
            sideCurve.setAttribute("d", strokePath(side))
        }
        drawCurves()
        if (isDefined(adapter)) {
            const {amount} = adapter.namedParameter
            lifecycle.ownAll(
                amount.catchupAndSubscribe(() => {
                    thumb.style.top = `${(1.0 - amount.getUnitValue()) * 100}%`
                    const {value, unit} = amount.getPrintValue()
                    amountValue.textContent = `${value}${unit}`
                    drawCurves()
                }),
                adapter.box.midCurve.subscribe(drawCurves),
                adapter.box.sideCurve.subscribe(drawCurves),
                liveStreamReceiver.subscribeFloats(adapter.address.append(0), values => {
                    meters[0].bar.style.width = `${meterRatio(20 * Math.log10(Math.max(values[0], values[1], 1e-6))) * 100}%`
                    meters[1].bar.style.width = `${meterRatio(values[2]) * 100}%`
                    meters[2].bar.style.width = `${meterRatio(values[3]) * 100}%`
                    meters[3].bar.style.width = `${(values[4] + 1.0) * 50}%`
                }),
                compare.catchupAndSubscribe(owner => engine.overrideDeviceField(adapter.uuid, COMPARE_KEY, owner.getValue())),
                {terminate: () => engine.overrideDeviceField(adapter.uuid, COMPARE_KEY, false)}
            )
        }
        const slider: HTMLElement = (
            <div className="slider">
                <div className="track"/>
                {thumb}
            </div>
        )
        return (
            <div className="content">
                <header>
                    {isDefined(adapter)
                        ? <Checkbox lifecycle={lifecycle} model={EditWrapper.forValue(editing, adapter.box.enabled)}
                                    appearance={{color: Colors.shadow, activeColor: Colors.blue, cursor: "pointer",
                                        tooltip: "Mastering on (stored in the project)"}}>
                            <Icon symbol={IconSymbol.Shutdown}/>
                        </Checkbox>
                        : <Icon symbol={IconSymbol.Shutdown} style={{color: Colors.shadow.toString()}}/>}
                    <h1>Mastering</h1>
                </header>
                <div className={Html.buildClassList("body", !isDefined(adapter) && "unanalysed")}>
                    <div className="eq">
                        <div className="amount">
                            {isDefined(adapter)
                                ? <RelativeUnitValueDragging lifecycle={lifecycle} editing={editing}
                                                             parameter={adapter.namedParameter.amount}
                                                             options={{trackLength: AMOUNT_TRACK_LENGTH}}>
                                    {slider}
                                </RelativeUnitValueDragging>
                                : slider}
                            <h5>Amount</h5>
                            {amountValue}
                        </div>
                        <div className="display">
                            <svg viewBox="0 0 400 100" preserveAspectRatio="none">
                                {FrequencyTicks.map(({hz}) => (
                                    <line className="grid" x1={frequencyToX(hz) * 400} y1="0"
                                          x2={frequencyToX(hz) * 400} y2="100"/>
                                ))}
                                {GainTicks.map(db => (
                                    <line className={db === 0 ? "zero" : "grid"} x1="0" y1={gainToY(db)}
                                          x2="400" y2={gainToY(db)}/>
                                ))}
                                {fill}
                                {sideCurve}
                                {curve}
                            </svg>
                            <div className="gain-axis">
                                {GainTicks.map(db => (
                                    <span style={{top: `${gainToY(db)}%`}}>{db > 0 ? `+${db}` : db}</span>
                                ))}
                            </div>
                            <div className="frequency-axis">
                                {FrequencyTicks.map(({hz, label}) => (
                                    <span style={{left: `${frequencyToX(hz) * 100}%`}}>{label}</span>
                                ))}
                            </div>
                        </div>
                    </div>
                    <div className="sections">
                        <section className="reference" onInit={(element: HTMLElement) => lifecycle.ownAll(
                            Events.subscribe(element, "dragover", (event: DragEvent) => {
                                if (event.dataTransfer?.types.includes("Files") === true) {event.preventDefault()}
                            }),
                            Events.subscribe(element, "drop", (event: DragEvent) => {
                                const file = event.dataTransfer?.files.item(0)
                                if (!isDefined(file)) {return}
                                event.preventDefault()
                                loadReferenceFile(file).finally()
                            }))}>
                            <h3>Reference</h3>
                            <div className="drop-down">
                                <DropDown lifecycle={lifecycle}
                                          owner={reference}
                                          provider={referenceNames}
                                          mapping={name => name}
                                          width="8em"/>
                            </div>
                            <Button lifecycle={lifecycle} onClick={() => browseReferenceFile().finally()}
                                    appearance={{
                                        color: Colors.shadow, framed: true,
                                        tooltip: "Analyse an audio file as reference (or drop one here)"
                                    }}>
                                <Icon symbol={IconSymbol.FolderOpen}/>
                            </Button>
                        </section>
                        <section>
                            <h3>Dynamics</h3>
                            <div className="row">
                                {isDefined(adapter)
                                    ? renderKnob(lifecycle, adapter.namedParameter.gain) : renderPlaceholderKnob("Gain")}
                                {isDefined(adapter)
                                    ? renderKnob(lifecycle, adapter.namedParameter.ceiling) : renderPlaceholderKnob("Ceiling")}
                                <Column ems={LKR} color={Colors.cream}>
                                    <h5>Limiter</h5>
                                    {isDefined(adapter)
                                        ? <Checkbox lifecycle={lifecycle} model={EditWrapper.forValue(editing, adapter.box.limiter)}
                                                    appearance={{color: Colors.shadow, activeColor: Colors.blue, framed: true}}>
                                            <span>On</span>
                                        </Checkbox>
                                        : <span className="value">–</span>}
                                </Column>
                            </div>
                        </section>
                        <section>
                            <h3>Spread</h3>
                            <div className="row">
                                {isDefined(adapter)
                                    ? renderKnob(lifecycle, adapter.namedParameter.width) : renderPlaceholderKnob("Width")}
                            </div>
                        </section>
                        <section className="meters">
                            <h3>Meters</h3>
                            {meters.map(({element}) => element)}
                        </section>
                    </div>
                </div>
                <footer>
                    <Button lifecycle={lifecycle} onClick={() => analyse(true).finally()}
                            disabled={busy}
                            appearance={{color: Colors.blue, framed: true,
                                tooltip: "Render the section and match it to the reference"}}>
                        <span>Analyse</span>
                    </Button>
                    <FlexSpacer pixels={4}/>
                    <div className="drop-down">
                        <DropDown lifecycle={lifecycle}
                                  owner={section}
                                  provider={() => sections}
                                  mapping={entry => entry.label}
                                  appearance={{color: Colors.shadow, framed: true}}
                                  width="8em"/>
                    </div>
                    <div className="spacer"/>
                    {isDefined(adapter)
                        ? <Checkbox lifecycle={lifecycle} model={compare}
                                    appearance={{
                                        color: Colors.shadow, activeColor: Colors.orange, framed: true,
                                        tooltip: "Compare original and mastered at the same loudness (not stored)"
                                    }}>
                            <span>Compare</span>
                        </Checkbox>
                        : <Frag/>}
                </footer>
            </div>
        )
    }
    // a reference picked other than the stored one is matched right away, with the last mixdown if there is one
    const storedReference = (): string => device.map(adapter => adapter.box.referenceName.getValue()).unwrapOrElse("")
    lifecycle.ownAll(
        reference.subscribe(owner => {
            if (device.nonEmpty() && !busy.getValue() && owner.getValue() !== storedReference()) {analyse(false).finally()}
        }),
        outputUnit.box.mastering.pointerHub.catchupAndSubscribe({
            onAdded: () => {
                device.wrap(findDevice().unwrap("mastering device"))
                device.ifSome(adapter => {
                    const stored = adapter.box.referenceName.getValue()
                    if (stored.length > 0) {reference.setValue(stored)}
                    const key = adapter.box.section.getValue()
                    if (key.length > 0) {section.setValue(MixdownSection.find(sections, key))}
                })
                render()
            },
            onRemoved: () => {
                device.clear()
                render()
            }
        }),
        {terminate: () => compare.setValue(false)}
    )
    if (device.isEmpty()) {render()}
    return root
}

const StageLabels: Record<Matchering.Stage, string> = {
    levels: "Matching levels...", frequencies: "Matching frequencies...", correction: "Correcting levels..."
}
