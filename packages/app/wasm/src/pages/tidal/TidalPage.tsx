import {createElement, PageFactory} from "@opendaw/lib-jsx"
import {UUID} from "@opendaw/lib-std"
import {
    AudioUnitBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TidalDeviceBox, TrackBox, VaporisateurDeviceBox
} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {PPQN} from "@opendaw/lib-dsp"
import {applySinePatch} from "../../sine-patch"
import {Env} from "../../Env"
import {createEngineHost} from "../../engine-host"

// A 16-step semiquaver arpeggio over one bar (C-E-G-C), so a steady stream feeds the Tidal effect.
const PATTERN: ReadonlyArray<number> = [60, 64, 67, 72]

export const TidalPage: PageFactory<Env> = ({lifecycle}) => {
    const {boxGraph, mandatoryBoxes} = ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    const timelineBox = mandatoryBoxes.timelineBox

    boxGraph.beginTransaction()
    // One sine synth unit (centered, so a channel offset's auto-pan is audible) playing semiquavers, into a
    // Tidal audio effect on its own fx chain: instrument -> Tidal -> strip.
    const unit = AudioUnitBox.create(boxGraph, UUID.generate(), box => {
        box.collection.refer(mandatoryBoxes.rootBox.audioUnits)
        box.index.setValue(0)
        box.panning.setValue(0.0)
    })
    VaporisateurDeviceBox.create(boxGraph, UUID.generate(), box => {
        box.host.refer(unit.input)
        applySinePatch(box)
    })
    // The Tidal effect. The box fields hold the parameters' REAL values (what the sliders write, what the
    // device reads when un-automated): slope bipolar, symmetry / depth unipolar, rate a fraction index,
    // offset / channel-offset in degrees. Set to the schema defaults so the sliders start in sync.
    const tidal = TidalDeviceBox.create(boxGraph, UUID.generate(), box => {
        box.host.refer(unit.audioEffects)
        box.index.setValue(0)
        box.slope.setValue(-0.25)
        box.symmetry.setValue(0.5)
        box.rate.setValue(3)
        box.depth.setValue(1.0)
        box.offset.setValue(0.0)
        box.channelOffset.setValue(0.0)
    })
    const track = TrackBox.create(boxGraph, UUID.generate(), box => {
        box.tracks.refer(unit.tracks)
        box.target.refer(unit)
    })
    const collection = NoteEventCollectionBox.create(boxGraph, UUID.generate())
    NoteRegionBox.create(boxGraph, UUID.generate(), box => {
        box.regions.refer(track.regions)
        box.position.setValue(0)
        box.duration.setValue(PPQN.Bar)
        box.loopOffset.setValue(0)
        box.loopDuration.setValue(PPQN.Bar)
        box.events.refer(collection.owners)
    })
    for (let step = 0; step < 16; step++) {
        NoteEventBox.create(boxGraph, UUID.generate(), box => {
            box.position.setValue(step * PPQN.SemiQuaver)
            box.duration.setValue(PPQN.SemiQuaver)
            box.pitch.setValue(PATTERN[step % PATTERN.length])
            box.velocity.setValue(0.8)
            box.events.refer(collection.events)
        })
    }
    timelineBox.loopArea.from.setValue(0)
    timelineBox.loopArea.to.setValue(PPQN.Bar)
    timelineBox.loopArea.enabled.setValue(true)
    boxGraph.endTransaction()

    const host = createEngineHost(boxGraph, lifecycle, {channel: "tidal-sync"})

    // Each slider edits its Tidal box field in its own transaction; the SyncSource streams the edit to the
    // engine, which re-pushes the changed parameter to the device live (the device uses the real value
    // directly, since the parameter is not automated).
    const slider = (name: string, min: number, max: number, step: number, initial: number,
                    apply: (value: number) => void): HTMLElement => {
        const digits = step >= 1 ? 0 : 2
        const value: HTMLSpanElement = <span className="value">{initial.toFixed(digits)}</span>
        return (
            <label className="slider">
                <span className="name">{name}</span>
                <input type="range" min={`${min}`} max={`${max}`} step={`${step}`} value={`${initial}`}
                       oninput={(event: Event) => {
                           const next = parseFloat((event.target as HTMLInputElement).value)
                           value.textContent = next.toFixed(digits)
                           boxGraph.beginTransaction()
                           apply(next)
                           boxGraph.endTransaction()
                       }}/>
                {value}
            </label>
        )
    }

    return (
        <div className="page">
            <h2>Tidal</h2>
            <p>A sine synth playing a <strong>semiquaver</strong> arpeggio through a <strong>Tidal</strong>
                audio effect (a tempo-synced LFO that shapes each channel's gain). The sliders edit the
                device's parameters <strong>live</strong>: each writes the box field, the SyncSource streams
                it to the engine, and the engine re-pushes the value to the device. Raise <strong>Ch. Offset</strong>
                to move the two channels apart into an auto-pan. Metronome off.</p>
            <div>
                <button onclick={() => void host.play()}>▶ Play</button>
                <button onclick={() => void host.stop()}>■ Stop</button>
            </div>
            <div className="sliders">
                {slider("Slope", -1, 1, 0.01, -0.25, value => tidal.slope.setValue(value))}
                {slider("Symmetry", 0, 1, 0.01, 0.5, value => tidal.symmetry.setValue(value))}
                {slider("Rate", 0, 16, 1, 3, value => tidal.rate.setValue(value))}
                {slider("Depth", 0, 1, 0.01, 1.0, value => tidal.depth.setValue(value))}
                {slider("Offset", -180, 180, 1, 0, value => tidal.offset.setValue(value))}
                {slider("Ch. Offset", -180, 180, 1, 0, value => tidal.channelOffset.setValue(value))}
            </div>
            {host.state}
            {host.log}
        </div>
    )
}
