import {createElement, PageFactory} from "@opendaw/lib-jsx"
import {UUID} from "@opendaw/lib-std"
import {ValueEventBox, ValueEventCollectionBox, ValueEventCurveBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {Env} from "../../Env"
import {createEngineHost} from "../../engine-host"

const BAR = 3840 // pulses (PPQN: 960 per quarter, 4/4)
const LOOP_TO = 4 * BAR // 15360, the LoopArea default

export const TempoAutomationPage: PageFactory<Env> = ({lifecycle}) => {
    const {boxGraph, mandatoryBoxes} = ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    const timelineBox = mandatoryBoxes.timelineBox

    // ProjectSkeleton already creates the tempo ValueEventCollectionBox and wires tempoTrack.events to
    // it (owners is mandatory), so reuse that collection rather than orphan it. Add two events plus the
    // loop area over bars 0..4, and a curve on the first event for a gentler initial acceleration.
    const collection = timelineBox.tempoTrack.events.targetVertex.unwrap().box as ValueEventCollectionBox
    boxGraph.beginTransaction()
    const firstEvent = ValueEventBox.create(boxGraph, UUID.generate(), box => {
        box.position.setValue(0)
        box.value.setValue(30) // our engine reads value as raw bpm
        box.events.refer(collection.events)
    })
    // a curve box shapes the first event's segment: slope < 0.5 keeps the tempo low at first, then
    // ramps up faster (slope 0.5 would be linear). It targets the event's interpolation field.
    ValueEventCurveBox.create(boxGraph, UUID.generate(), curve => {
        curve.slope.setValue(0.3)
        curve.event.refer(firstEvent.interpolation)
    })
    ValueEventBox.create(boxGraph, UUID.generate(), box => {
        box.position.setValue(LOOP_TO)
        box.value.setValue(1000)
        box.events.refer(collection.events)
    })
    timelineBox.loopArea.from.setValue(0)
    timelineBox.loopArea.to.setValue(LOOP_TO)
    timelineBox.loopArea.enabled.setValue(true)
    boxGraph.endTransaction()

    const host = createEngineHost(boxGraph, lifecycle, {channel: "tempo-sync", metronome: true})

    const edit = (procedure: () => void): void => {
        boxGraph.beginTransaction()
        procedure()
        boxGraph.endTransaction()
    }
    const setTempoEnabled = (enabled: boolean): void => edit(() => timelineBox.tempoTrack.enabled.setValue(enabled))
    const bpmLabel: HTMLSpanElement = <span>120</span>
    const setBpm = (value: number): void => {
        bpmLabel.textContent = String(value)
        edit(() => timelineBox.bpm.setValue(value))
    }
    return (
        <div className="page">
            <h2>Tempo Automation</h2>
            <p>A tempo track ramps 30→1000 bpm over a 4-bar loop. Turn it off for the fixed slider bpm. The
                readout decodes the engine's EngineState back-channel.</p>
            {host.element}
            <div>
                <label>
                    <input type="checkbox" checked={true}
                           onchange={(event: Event) => setTempoEnabled((event.target as HTMLInputElement).checked)}/>
                    Tempo automation (on = 30→1000 bpm ramp; off = fixed 120 bpm). Loops the first 4 bars either way.
                </label>
            </div>
            <div>
                <label>BPM {bpmLabel} </label>
                <input type="range" min="40" max="240" value="120"
                       oninput={(event: Event) => setBpm(parseInt((event.target as HTMLInputElement).value, 10))}/>
            </div>
            {host.log}
        </div>
    )
}
