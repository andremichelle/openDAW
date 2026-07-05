import {createElement, PageFactory} from "@opendaw/lib-jsx"
import {isDefined, MutableObservableOption, Procedure, Terminator, UUID} from "@opendaw/lib-std"
import {Address} from "@opendaw/lib-box"
import {AnimationFrame} from "@opendaw/lib-dom"
import {LiveStreamReceiver} from "@opendaw/lib-fusion"
import {DeviceBox, DeviceBoxUtils, ProjectSkeleton} from "@opendaw/studio-adapters"
import {AudioBusBox, AudioUnitBox} from "@opendaw/studio-boxes"
import {Env} from "../../Env"
import {createEngineHost} from "../../engine-host"
import {decodeBundle} from "../../bundle"
import {SampleStorage} from "../../sample-storage"

// LIVE METERS: loads any openDAW project (.od) or bundle (.odb) and shows the engine's live telemetry — one row
// per audio unit, one column per device. Audio devices (instruments, tape, effects, the channel strip) render a
// stereo peak/RMS meter; midi devices (and instruments' note intake) a note-activity indicator. The data flows
// through the UNCHANGED lib-fusion LiveStream protocol: the engine registers meter slots in its broadcast table,
// the worklet mirrors them onto a `LiveStreamBroadcaster` as views over wasm memory, and this page subscribes a
// `LiveStreamReceiver` on the same "engine-live-data" channel — the exact studio wire format.
const PEAKS = Address.compose(UUID.Lowest, 0) // the master strip (TS `EngineAddresses.PEAKS`)
const UNIT_MIDI_KEY = 21
const UNIT_INPUT_KEY = 22
const UNIT_AUDIO_KEY = 23

const deviceLabel = (device: DeviceBox): string => {
    const label = device.label.getValue()
    return label.length > 0 ? label : device.name
}

// One stereo peak/RMS meter cell: per channel a peak fill with an RMS fill on top, both scaled on a -60..0 dB
// range; a peak beyond 0 dB marks the cell clipping. Updated straight from the receiver's Float32Array.
const createMeter = (): {element: HTMLElement, update: Procedure<Float32Array>} => {
    const decibels = (peak: number): number => Math.max(0.0, Math.min(1.0, 1.0 + Math.log10(Math.max(peak, 1.0e-4)) / 3.0))
    const peakLeft: HTMLDivElement = <div className="fill peak"/>
    const peakRight: HTMLDivElement = <div className="fill peak"/>
    const rmsLeft: HTMLDivElement = <div className="fill rms"/>
    const rmsRight: HTMLDivElement = <div className="fill rms"/>
    const element: HTMLDivElement = (
        <div className="live-meter">
            <div className="channel">{peakLeft}{rmsLeft}</div>
            <div className="channel">{peakRight}{rmsRight}</div>
        </div>
    )
    const update = (values: Float32Array): void => {
        peakLeft.style.height = `${decibels(values[0]) * 100.0}%`
        peakRight.style.height = `${decibels(values[1]) * 100.0}%`
        rmsLeft.style.height = `${decibels(values[2]) * 100.0}%`
        rmsRight.style.height = `${decibels(values[3]) * 100.0}%`
        element.classList.toggle("clip", values[0] > 1.0 || values[1] > 1.0)
    }
    return {element, update}
}

// One note cell: the engine broadcasts a 128-bit held-note set per unit / midi-fx (the TS `NoteBroadcaster`
// mirror, an Integers package); any held note lights the dot, which decays once all notes released.
const createNoteIndicator = (): {element: HTMLElement, update: Procedure<Int32Array>} => {
    const dot: HTMLDivElement = <div className="dot"/>
    const element: HTMLDivElement = <div className="live-note">{dot}</div>
    const state = {energy: 0.0}
    const update = (bits: Int32Array): void => {
        if ((bits[0] | bits[1] | bits[2] | bits[3]) !== 0) {
            state.energy = 1.0
        } else {
            state.energy *= 0.90
        }
        dot.style.opacity = state.energy.toFixed(3)
    }
    return {element, update}
}

export const LiveMetersPage: PageFactory<Env> = ({lifecycle}) => {
    const status: HTMLParagraphElement = <p>Choose a project (<code>.od</code>) or bundle (<code>.odb</code>).</p>
    const host: HTMLDivElement = <div/>
    const board: HTMLDivElement = <div/>
    const logs: HTMLDivElement = <div/>
    const current = new MutableObservableOption<Terminator>()
    AnimationFrame.start(window) // the LiveStreamReceiver dispatches its SAB reads on the animation frame
    lifecycle.own({terminate: () => AnimationFrame.stop()})
    const load = async (file: File): Promise<void> => {
        current.ifSome(terminator => terminator.terminate())
        host.replaceChildren()
        board.replaceChildren()
        logs.replaceChildren()
        status.textContent = `Decoding ${file.name}…`
        const bytes = await file.arrayBuffer()
        const boxGraph = await (async () => {
            if (file.name.endsWith(".odb")) {
                const bundle = await decodeBundle(bytes)
                status.textContent = `Caching ${bundle.samples.length} sample(s)…`
                await Promise.all(bundle.samples.map(({uuid, wav}) => SampleStorage.writeAudio(uuid, wav)))
                return bundle.boxGraph
            }
            return ProjectSkeleton.decode(bytes).boxGraph
        })()
        const terminator = lifecycle.spawn()
        current.wrap(terminator)
        const receiver = new LiveStreamReceiver()
        terminator.own(receiver)
        const engine = createEngineHost(boxGraph, terminator, {
            channel: `live-meters-${file.name}`,
            onMessenger: messenger => terminator.own(receiver.connect(messenger.channel("engine-live-data")))
        })
        host.append(engine.element)
        logs.append(engine.log)
        // One row per AudioUnitBox (in mixer order), one column per device: midi fx | instrument/tape | audio fx,
        // closed by the unit's channel strip (the OUTPUT unit's strip broadcasts at the master PEAKS address).
        const boxes = boxGraph.boxes()
        const units = boxes.filter(box => box instanceof AudioUnitBox)
            .sort((left, right) => left.index.getValue() - right.index.getValue())
        const devicesOf = (unit: AudioUnitBox, key: number): Array<DeviceBox> => boxes
            .filter(DeviceBoxUtils.isDeviceBox)
            // A PlayfieldSampleBox is tagged "device" but has no `host` (it attaches through its composite slot).
            .filter(device => isDefined(device.host) && device.host.targetAddress.mapOr(address =>
                UUID.equals(address.uuid, unit.address.uuid) && address.fieldKeys[0] === key, false))
        const rows = units.map(unit => {
            const midi = devicesOf(unit, UNIT_MIDI_KEY)
                .sort((left, right) => DeviceBoxUtils.lookupIndexField(left).getValue() - DeviceBoxUtils.lookupIndexField(right).getValue())
            const instruments = devicesOf(unit, UNIT_INPUT_KEY)
            const audio = devicesOf(unit, UNIT_AUDIO_KEY)
                .sort((left, right) => DeviceBoxUtils.lookupIndexField(left).getValue() - DeviceBoxUtils.lookupIndexField(right).getValue())
            const bus = boxes.find(box => box instanceof AudioBusBox && box.output.targetAddress.mapOr(address =>
                UUID.equals(address.uuid, unit.address.uuid), false))
            const unitType = unit.type.getValue()
            const name = instruments.length > 0 ? deviceLabel(instruments[0])
                : isDefined(bus) && bus instanceof AudioBusBox && bus.label.getValue().length > 0 ? bus.label.getValue()
                    : unitType
            const cells: Array<HTMLElement> = []
            const meterCell = (label: string, address: Address): void => {
                const meter = createMeter()
                terminator.own(receiver.subscribeFloats(address, meter.update))
                cells.push(<div className="live-cell"><span className="name">{label}</span>{meter.element}</div>)
            }
            const noteCell = (label: string, address: Address): void => {
                const note = createNoteIndicator()
                terminator.own(receiver.subscribeIntegers(address, note.update))
                cells.push(<div className="live-cell"><span className="name">{label}</span>{note.element}</div>)
            }
            midi.forEach(device => noteCell(deviceLabel(device), device.address))
            instruments.forEach(device => {
                noteCell("notes", unit.address) // the UNIT's 128-bit note set (TS NoteEventInstrument address)
                meterCell(deviceLabel(device), device.address)
            })
            audio.forEach(device => meterCell(deviceLabel(device), device.address))
            meterCell("strip", unitType === "output" ? PEAKS : unit.address)
            return <div className="live-row"><span className="unit">{name}</span><div className="cells">{cells}</div></div>
        })
        board.append(<div className="live-board">{rows}</div>)
        status.textContent = `Loaded ${file.name} — ${units.length} unit(s). Press Play.`
    }
    const input: HTMLInputElement = <input type="file" accept=".od,.odb"/>
    input.onchange = () => {
        const file = input.files?.[0]
        if (!isDefined(file)) {return}
        load(file).catch(reason => {status.textContent = `Failed: ${reason instanceof Error ? reason.message : String(reason)}`})
    }
    return (
        <div className="page">
            <h2>Live Meters</h2>
            <p>Loads a project or bundle and shows the engine's LIVE telemetry through the studio's LiveStream
                protocol: every audio unit is a row, every device a column with its own stereo peak/RMS meter — midi
                devices (and each instrument's note intake) flash a note indicator instead.</p>
            <div className="metro-controls">
                <label>Project </label>
                {input}
            </div>
            {host}
            {board}
            {status}
            {logs}
        </div>
    )
}
