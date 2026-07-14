import {createElement, PageFactory} from "@opendaw/lib-jsx"
import {UUID} from "@opendaw/lib-std"
import {AudioFileBox, AudioRegionBox, AudioSignalsmithBox, AudioUnitBox, TapeDeviceBox, TrackBox, ValueEventCollectionBox, WarpMarkerBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {Env} from "../../Env"
import {createEngineHost} from "../../engine-host"
import {SampleStorage} from "../../sample-storage"

// Realtime Signalsmith stretch: a few looping regions, each played through an AudioSignalsmithBox play-mode (the
// stereo-coupled phase vocoder in the wasm engine). The warp markers pin each loop's musical length to its source
// seconds, so moving the transport TEMPO away from a loop's native BPM time-stretches it live, and the SEMITONES
// slider drives the box's `transpose` field (pitch-shift, tempo-independent). Both edits stream through the
// unchanged SyncSource; the engine re-reads the region on the play-mode-box monitor, so they take effect while
// playing. The loop samples are seeded into the OPFS sample cache under fixed uuids, so the page is fully offline.

const BAR = 3840          // pulses (960 PPQN * 4)
const TRANSPORT_SPAN = 8 * BAR   // a multiple of every loop's bar count (2/4/8), so each tiles cleanly

type Loop = {
    readonly key: string
    readonly name: string
    readonly file: string     // public url
    readonly uuid: string     // stable sample/file uuid (also the OPFS cache key)
    readonly bpm: number      // native tempo — the transport tempo at which this loop plays unstretched
    readonly bars: number
    readonly seconds: number  // source length in seconds (the warp end marker)
}

const LOOPS: ReadonlyArray<Loop> = [
    {key: "endeavour", name: "Dark dub drums", file: "/loops/endeavour-140.wav", uuid: "5c0a7e10-0000-4000-8000-000000000009", bpm: 140, bars: 2, seconds: 3.4286},
    {key: "chipshop", name: "ChipShop combo", file: "/loops/chipshop-140.wav", uuid: "5c0a7e10-0000-4000-8000-00000000000a", bpm: 140, bars: 4, seconds: 6.8572},
    {key: "drums", name: "Techno drums", file: "/loops/techno-128.wav", uuid: "5c0a7e10-0000-4000-8000-000000000001", bpm: 128, bars: 2, seconds: 3.7500},
    {key: "attack", name: "Attack hits", file: "/loops/attack-175.wav", uuid: "5c0a7e10-0000-4000-8000-000000000004", bpm: 175, bars: 4, seconds: 5.4857},
    {key: "pad", name: "Derelict pad", file: "/loops/pad-125.wav", uuid: "5c0a7e10-0000-4000-8000-000000000002", bpm: 125, bars: 4, seconds: 7.6800},
    {key: "chord", name: "Dub chord", file: "/loops/dub-125.wav", uuid: "5c0a7e10-0000-4000-8000-000000000003", bpm: 125, bars: 4, seconds: 7.6800},
    {key: "guitar", name: "Guitar chords", file: "/loops/guitar-100.wav", uuid: "5c0a7e10-0000-4000-8000-000000000007", bpm: 100, bars: 8, seconds: 19.2000},
    {key: "story", name: "HT story", file: "/loops/story-124.wav", uuid: "5c0a7e10-0000-4000-8000-000000000008", bpm: 124, bars: 4, seconds: 7.7143},
    {key: "borealis", name: "Borealis pad", file: "/loops/borealis-85.wav", uuid: "5c0a7e10-0000-4000-8000-000000000005", bpm: 85, bars: 4, seconds: 11.2941},
    {key: "drone", name: "Alien drone", file: "/loops/drone-135.wav", uuid: "5c0a7e10-0000-4000-8000-000000000006", bpm: 135, bars: 8, seconds: 14.2222}
]

const START_BPM = 140

export const SignalsmithPage: PageFactory<Env> = ({lifecycle}) => {
    const status: HTMLParagraphElement = <p>Preparing loops…</p>
    const mount: HTMLDivElement = <div/>
    const build = async (): Promise<void> => {
        await Promise.all(LOOPS.map(async loop => {
            const uuid = UUID.parse(loop.uuid)
            if (!(await SampleStorage.has(uuid))) {
                const wav = await fetch(loop.file).then(response => response.arrayBuffer())
                await SampleStorage.writeAudio(uuid, wav)
            }
        }))
        const {boxGraph, mandatoryBoxes} = ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
        const {rootBox, primaryAudioBusBox, timelineBox} = mandatoryBoxes
        boxGraph.beginTransaction()
        const entries = LOOPS.map((loop, index) => {
            const unit = AudioUnitBox.create(boxGraph, UUID.generate(), box => {
                box.collection.refer(rootBox.audioUnits)
                box.output.refer(primaryAudioBusBox.input)
                box.index.setValue(index + 1)
            })
            TapeDeviceBox.create(boxGraph, UUID.generate(), box => box.host.refer(unit.input))
            const track = TrackBox.create(boxGraph, UUID.generate(), box => {
                box.type.setValue(TrackType.Audio)
                box.enabled.setValue(true)
                box.index.setValue(0)
                box.target.refer(unit)
                box.tracks.refer(unit.tracks)
            })
            const file = AudioFileBox.create(boxGraph, UUID.parse(loop.uuid), box => {
                box.startInSeconds.setValue(0)
                box.endInSeconds.setValue(loop.seconds)
                box.fileName.setValue(loop.name)
            })
            const signalsmith = AudioSignalsmithBox.create(boxGraph, UUID.generate())
            const span = loop.bars * BAR
            WarpMarkerBox.create(boxGraph, UUID.generate(), box => {box.owner.refer(signalsmith.warpMarkers); box.position.setValue(0); box.seconds.setValue(0)})
            WarpMarkerBox.create(boxGraph, UUID.generate(), box => {box.owner.refer(signalsmith.warpMarkers); box.position.setValue(span); box.seconds.setValue(loop.seconds)})
            const collection = ValueEventCollectionBox.create(boxGraph, UUID.generate())
            const region = AudioRegionBox.create(boxGraph, UUID.generate(), box => {
                box.position.setValue(0)
                box.duration.setValue(TRANSPORT_SPAN)
                box.loopOffset.setValue(0)
                box.loopDuration.setValue(span)
                box.regions.refer(track.regions)
                box.file.refer(file)
                box.events.refer(collection.owners)
                box.mute.setValue(index !== 0)
            })
            region.playMode.refer(signalsmith)
            return {loop, region, signalsmith, semitones: 0}
        })
        timelineBox.tempoTrack.enabled.setValue(false)
        timelineBox.bpm.setValue(START_BPM)
        timelineBox.loopArea.from.setValue(0)
        timelineBox.loopArea.to.setValue(TRANSPORT_SPAN)
        timelineBox.loopArea.enabled.setValue(true)
        boxGraph.endTransaction()
        const host = createEngineHost(boxGraph, lifecycle, {channel: "signalsmith-sync", metronome: false})
        const edit = (procedure: () => void): void => {boxGraph.beginTransaction(); procedure(); boxGraph.endTransaction()}
        const label = (semitones: number): string => semitones > 0 ? `+${semitones}` : String(semitones)
        let active = entries[0]
        const bpmValue: HTMLSpanElement = <span>{String(START_BPM)}</span>
        const bpmInput: HTMLInputElement = <input type="range" min="40" max="220" step="1" value={String(START_BPM)}/>
        const setBpm = (bpm: number): void => {
            bpmValue.textContent = String(bpm)
            if (bpmInput.value !== String(bpm)) {bpmInput.value = String(bpm)}
            edit(() => timelineBox.bpm.setValue(bpm))
        }
        bpmInput.oninput = () => setBpm(parseInt(bpmInput.value, 10))
        const semiValue: HTMLSpanElement = <span>0</span>
        const semiInput: HTMLInputElement = <input type="range" min="-24" max="24" step="1" value="0"/>
        semiInput.oninput = () => {
            const semitones = parseInt(semiInput.value, 10)
            semiValue.textContent = label(semitones)
            active.semitones = semitones
            edit(() => active.signalsmith.transpose.setValue(semitones))
        }
        const buttons = entries.map(entry => {
            const button: HTMLButtonElement = <button className={entry === active ? "active" : ""}>{entry.loop.name}<small>{`${entry.loop.bpm} bpm · ${entry.loop.bars} bar`}</small></button>
            button.onclick = () => {
                active = entry
                buttons.forEach((other, index) => other.classList.toggle("active", entries[index] === entry))
                edit(() => entries.forEach(other => other.region.mute.setValue(other !== entry)))
                semiInput.value = String(entry.semitones)
                semiValue.textContent = label(entry.semitones)
                setBpm(entry.loop.bpm) // jump the transport to this loop's native tempo (unstretched)
            }
            return button
        })
        const metronome: HTMLInputElement = <input type="checkbox"/>
        metronome.onchange = () => host.setMetronome(metronome.checked)
        const controls: HTMLDivElement = (
            <div className="signalsmith-controls">
                <div className="row"><label>Loop</label><div className="loop-buttons">{buttons}</div></div>
                <div className="row"><label>Tempo {bpmValue} bpm</label>{bpmInput}<small>selecting a loop jumps to its native tempo — move away to time-stretch</small></div>
                <div className="row"><label>Semitones {semiValue} st</label>{semiInput}<small>pitch-shift of the active loop (tempo-independent)</small></div>
                <div className="row"><label className="inline"><span>{metronome}</span> Metronome</label></div>
            </div>
        )
        mount.replaceChildren(host.element, controls, host.log)
        status.textContent = "Ready — press Play, then move Tempo (time-stretch) and Semitones (pitch)."
    }
    void build()
    return (
        <div className="page">
            <h2>Signalsmith Stretch</h2>
            <p>Looping audio regions played through the stereo Signalsmith phase-vocoder play-mode. <b>Tempo</b>
                time-stretches the active loop (each loop is unstretched at its native BPM); <b>Semitones</b>
                pitch-shifts it independently of tempo. Both change live while playing.</p>
            {status}
            {mount}
        </div>
    )
}
