import css from "./ChopDialog.sass?inline"
import {createElement} from "@opendaw/lib-jsx"
import {Dragging, Events, Html} from "@opendaw/lib-dom"
import {
    clamp, DefaultObservableValue, int, isDefined, MutableObservableOption, Nullable, Option, Provider,
    StringMapping, Terminator, unitValue
} from "@opendaw/lib-std"
import {AudioData, MidiKeys} from "@opendaw/lib-dsp"
import {Peaks, PeaksPainter} from "@opendaw/lib-fusion"
import {AudioFileBox} from "@opendaw/studio-boxes"
import {PlayfieldChopSlice, PlayfieldDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {CanvasPainter, ElementCapturing, TimelineRange, Workers} from "@opendaw/studio-core"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {Button} from "@/ui/components/Button"
import {Dialog} from "@/ui/components/Dialog"
import {NumberInput} from "@/ui/components/NumberInput"
import {RadioGroup} from "@/ui/components/RadioGroup"
import {Surface} from "@/ui/surface/Surface"
import {TimelineRangeSlider} from "@/ui/timeline/TimelineRangeSlider"
import {attachWheelScroll} from "@/ui/timeline/editors/WheelScroll"
import {installCursor} from "@/ui/hooks/cursor"
import {Cursor} from "@/ui/Cursors"
import {StudioService} from "@/service/StudioService"
import {ChopMath, ChopMode, ChopModel, GridDivision, GridDivisions, MAX_KEY} from "./ChopModel"

const className = Html.adoptStyleSheet(css, "ChopDialog")

const GRAB_THRESHOLD_PX = 6

type Construct = {
    service: StudioService
    deviceAdapter: PlayfieldDeviceBoxAdapter
    peaks: Peaks
    audioData: AudioData
    resolveFile: Provider<AudioFileBox>
    startKey: int
    bpmHint?: number
}

const openChopDialog = (
    {service, deviceAdapter, peaks, audioData, resolveFile, startKey, bpmHint}: Construct): void => {
    const lifecycle = new Terminator()
    const durationInSeconds = audioData.numberOfFrames / audioData.sampleRate
    const model = new ChopModel()
    const mode = new DefaultObservableValue<ChopMode>("transients")
    const bpm = new DefaultObservableValue<number>(
        isDefined(bpmHint) && bpmHint > 0 ? bpmHint : ChopMath.fitBpmPow2(durationInSeconds))
    const division = new DefaultObservableValue<GridDivision>(1 / 16)
    const startKeyValue = new DefaultObservableValue<int>(clamp(startKey, 0, MAX_KEY - 1))
    const maxKeys = new DefaultObservableValue<int>(16)
    const phase = new DefaultObservableValue<"preslice" | "edit">("preslice")
    const transientSeconds: Array<number> = []

    const canvas: HTMLCanvasElement = (<canvas/>)
    const range = lifecycle.own(new TimelineRange())
    range.maxUnits = Math.max(1, audioData.numberOfFrames)
    range.showAll()

    const readout: HTMLElement = (<span className="readout"/>)
    const noteLabel: HTMLElement = (<span className="note"/>)
    const controlsGroup: HTMLElement = (
        <div className="pre-slice">
            <div className="row">
                <label>Mode</label>
                <RadioGroup lifecycle={lifecycle} model={mode} className="radio-group"
                            elements={[
                                {value: "transients", element: (<span>Transients</span>)},
                                {value: "grid", element: (<span>Grid</span>)}
                            ]}/>
            </div>
            <div className="row">
                <label>BPM</label>
                <NumberInput lifecycle={lifecycle} model={bpm} maxChars={6}
                             mapper={StringMapping.numeric({fractionDigits: 2})}
                             guard={{guard: value => clamp(value, 20, 999)}}/>
            </div>
            <div className="row">
                <label>Division</label>
                <RadioGroup lifecycle={lifecycle} model={division} className="radio-group"
                            elements={GridDivisions.map(value => ({
                                value, element: (<span>1/{Math.round(1 / value)}</span>)
                            }))}/>
            </div>
            <div className="row">
                <label>Max-Keys</label>
                <NumberInput lifecycle={lifecycle} model={maxKeys}
                             guard={{guard: value => clamp(Math.round(value), 0, MAX_KEY - 1)}}/>
            </div>
        </div>
    )

    const normalizedFromClientX = (clientX: number): unitValue => {
        const {left, width} = canvas.getBoundingClientRect()
        range.width = width
        return clamp(range.xToUnit(clientX - left) / range.maxUnits, 0.0, 1.0)
    }
    const boundaryIndexAtLocalX = (localX: number, width: number): int => {
        range.width = width
        const slices = model.slices(startKeyValue.getValue())
        let bestIndex = -1
        let bestDistance = GRAB_THRESHOLD_PX
        for (let index = 1; index < slices.length; index++) {
            const distance = Math.abs(range.unitToX(slices[index].start * range.maxUnits) - localX)
            if (distance < bestDistance) {
                bestDistance = distance
                bestIndex = index
            }
        }
        return bestIndex
    }
    const findGrabbableBoundary = (clientX: number): int => {
        const {left, width} = canvas.getBoundingClientRect()
        return boundaryIndexAtLocalX(clientX - left, width)
    }
    const capturing = new ElementCapturing<"line" | "slice">(canvas, {
        capture: (localX: number): Nullable<"line" | "slice"> => {
            const width = canvas.clientWidth
            if (boundaryIndexAtLocalX(localX, width) >= 0) {return "line"}
            range.width = width
            const position = clamp(range.xToUnit(localX) / range.maxUnits, 0.0, 1.0)
            return isDefined(model.slices(startKeyValue.getValue())
                .find(({start, end}) => position >= start && position < end)) ? "slice" : null
        }
    })

    const updateReadout = () => {
        const slices = model.slices(startKeyValue.getValue())
        const from = startKeyValue.getValue()
        const to = from + slices.length - 1
        readout.textContent = slices.length === 0
            ? "no slices"
            : `${slices.length} slices → ${MidiKeys.toFullString(from)} … ${MidiKeys.toFullString(to)}`
    }

    const painter = lifecycle.own(new CanvasPainter(canvas, ({context, actualWidth, actualHeight, width}) => {
        range.width = width
        context.clearRect(0, 0, actualWidth, actualHeight)
        const {numChannels} = peaks
        const rowHeight = actualHeight / numChannels
        context.fillStyle = "rgba(255,255,255,0.55)"
        for (let channelIndex = 0; channelIndex < numChannels; channelIndex++) {
            PeaksPainter.renderPixelStrips(context, peaks, channelIndex, {
                u0: range.unitMin, u1: range.unitMax, x0: 0, x1: actualWidth, v0: 1.1, v1: -1.1,
                y0: rowHeight * channelIndex, y1: rowHeight * (channelIndex + 1)
            })
        }
        const slices = model.slices(startKeyValue.getValue())
        const dpr = devicePixelRatio
        context.font = `${Math.round(9 * dpr)}px sans-serif`
        context.textBaseline = "top"
        for (let index = 0; index < slices.length; index++) {
            const {start, end} = slices[index]
            const xStart = range.unitToX(start * range.maxUnits) * dpr
            const xEnd = range.unitToX(end * range.maxUnits) * dpr
            context.fillStyle = "rgba(120,190,255,0.9)"
            context.fillRect(Math.round(xStart), 0, dpr, actualHeight)
            if (index === slices.length - 1) {
                context.fillRect(Math.round(xEnd) - dpr, 0, dpr, actualHeight)
            }
            if (xEnd - xStart > 18 * dpr) {
                context.fillStyle = "rgba(120,190,255,0.9)"
                context.fillText(MidiKeys.toFullString(startKeyValue.getValue() + index), xStart + 3 * dpr, 2 * dpr)
            }
        }
    }))

    const audioContext = service.audioContext
    const audioBuffer = audioContext.createBuffer(
        audioData.numberOfChannels, audioData.numberOfFrames, audioData.sampleRate)
    for (let channel = 0; channel < audioData.numberOfChannels; channel++) {
        audioBuffer.getChannelData(channel).set(audioData.frames[channel])
    }
    const activeSource = new MutableObservableOption<AudioBufferSourceNode>()
    const playSlice = (slice: PlayfieldChopSlice) => {
        activeSource.clear(source => source.stop())
        if (audioContext.state === "suspended") {audioContext.resume()}
        const source = audioContext.createBufferSource()
        source.buffer = audioBuffer
        source.connect(audioContext.destination)
        source.onended = () => {if (activeSource.unwrapOrNull() === source) {activeSource.clear()}}
        const startSeconds = slice.start * durationInSeconds
        const lengthSeconds = Math.max(0.0, (slice.end - slice.start) * durationInSeconds)
        source.start(0, startSeconds, lengthSeconds)
        activeSource.wrap(source)
    }

    const effectiveMaxSlices = (): int => {
        const midiCap = MAX_KEY - startKeyValue.getValue()
        const requested = maxKeys.getValue()
        return requested === 0 ? midiCap : Math.min(requested, midiCap)
    }
    const regenerate = () => {
        if (mode.getValue() === "transients") {
            model.fromTransients(transientSeconds, durationInSeconds, effectiveMaxSlices())
        } else {
            model.fromGrid(bpm.getValue(), division.getValue(), durationInSeconds, effectiveMaxSlices())
        }
        painter.requestUpdate()
        updateReadout()
    }
    const enterEdit = () => {if (phase.getValue() !== "edit") {phase.setValue("edit")}}
    const reset = () => {phase.setValue("preslice"); regenerate()}

    lifecycle.ownAll(
        mode.subscribe(() => {if (phase.getValue() === "preslice") {regenerate()}}),
        bpm.subscribe(() => {if (phase.getValue() === "preslice") {regenerate()}}),
        division.subscribe(() => {if (phase.getValue() === "preslice") {regenerate()}}),
        startKeyValue.subscribe(() => {
            noteLabel.textContent = MidiKeys.toFullString(startKeyValue.getValue())
            if (phase.getValue() === "preslice") {regenerate()} else {painter.requestUpdate(); updateReadout()}
        }),
        maxKeys.subscribe(() => {if (phase.getValue() === "preslice") {regenerate()}}),
        phase.subscribe(() => controlsGroup.classList.toggle("disabled", phase.getValue() === "edit")),
        range.subscribe(painter.requestUpdate),
        attachWheelScroll(canvas, range),
        Events.subscribe(canvas, "wheel", (event: WheelEvent) => {
            if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
                event.preventDefault()
                const {left, width} = canvas.getBoundingClientRect()
                range.width = width
                range.scaleBy(event.deltaY * 0.002, range.xToValue(event.clientX - left))
            }
        }, {passive: false}),
        Dragging.attach(canvas, (event: PointerEvent) => {
            if (event.altKey) {return Option.None}
            const grabbed = findGrabbableBoundary(event.clientX)
            if (grabbed < 0) {return Option.None}
            return Option.wrap({
                update: (dragEvent: Dragging.Event) => {
                    model.dragBoundary(grabbed, normalizedFromClientX(dragEvent.clientX))
                    enterEdit()
                    painter.requestUpdate()
                    updateReadout()
                }
            } satisfies Dragging.Process)
        }),
        installCursor(canvas, capturing, {
            get: (target, event) => {
                if (target === "line") {return event.altKey ? Cursor.Erase : "ew-resize"}
                if (target === "slice") {return event.altKey ? Cursor.Scissors : Cursor.Speaker}
                return null
            }
        }),
        Events.subscribe(canvas, "click", (event: MouseEvent) => {
            const grabbed = findGrabbableBoundary(event.clientX)
            const position = normalizedFromClientX(event.clientX)
            if (event.altKey) {
                if (grabbed >= 0) {model.removeBoundary(grabbed)} else {model.splitAt(position)}
                enterEdit()
                painter.requestUpdate()
                updateReadout()
                return
            }
            if (grabbed >= 0) {return}
            const slice = model.slices(startKeyValue.getValue())
                .find(({start, end}) => position >= start && position < end)
            if (isDefined(slice)) {playSlice(slice)}
        }),
        {terminate: () => activeSource.clear(source => source.stop())}
    )

    Workers.Transients.detect(audioData).then(seconds => {
        transientSeconds.length = 0
        transientSeconds.push(...seconds)
        if (mode.getValue() === "transients" && phase.getValue() === "preslice") {regenerate()}
    })
    regenerate()
    noteLabel.textContent = MidiKeys.toFullString(startKeyValue.getValue())

    const dialog = (
        <Dialog headline="Auto-Chop"
                icon={IconSymbol.Scissors}
                growWidth
                style={{width: "80vw", height: "72vh"}}
                buttons={[
                    {text: "Cancel", onClick: handler => handler.close()},
                    {
                        text: "Chop", primary: true, onClick: handler => {
                            const slices = model.slices(startKeyValue.getValue())
                            if (slices.length > 0) {
                                service.project.editing.modify(() => deviceAdapter.chop({
                                    file: resolveFile(), startKey: startKeyValue.getValue(), slices
                                }))
                            }
                            handler.close()
                        }
                    }
                ]}>
            <div className={className}>
                <div className="controls">
                    {controlsGroup}
                    <div className="always">
                        <label>Start-Key</label>
                        <div className="key-field">
                            <NumberInput lifecycle={lifecycle} model={startKeyValue}
                                         guard={{guard: value => clamp(Math.round(value), 0, MAX_KEY - 1)}}/>
                            {noteLabel}
                        </div>
                    </div>
                    {readout}
                    <Button lifecycle={lifecycle} onClick={() => reset()} className="reset"
                            appearance={{color: Colors.gray}}><span>Reset</span></Button>
                </div>
                <div className="display">
                    {canvas}
                </div>
                <TimelineRangeSlider lifecycle={lifecycle} range={range} className="range-slider"/>
                <div className="hint">
                    Click a slice to hear it · drag a line to move · alt-click the waveform to add a
                    slice · alt-click a line to delete it
                </div>
            </div>
        </Dialog>
    )
    dialog.addEventListener("close", () => lifecycle.terminate())
    Surface.get().body.appendChild(dialog)
    dialog.showModal()
}

export const ChopDialog = {open: openChopDialog}
