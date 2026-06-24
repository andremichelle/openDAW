import {createElement, PageFactory} from "@opendaw/lib-jsx"
import {Exec} from "@opendaw/lib-std"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {Env} from "../../Env"
import {createEngineHost} from "../../engine-host"

// Live metronome: a real project (TimelineBox) on the main thread streamed to the wasm engine through the
// shared engine host (metronome click on). Editing bpm / signature mutates the TimelineBox, the host's
// SyncSource ships the transaction to the engine, and the playing click reacts live.

const DENOMINATORS = [1, 2, 4, 8, 16]
const NOMINATORS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 12]

export const MetronomePage: PageFactory<Env> = ({lifecycle}) => {
    const {boxGraph, mandatoryBoxes} = ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    const timelineBox = mandatoryBoxes.timelineBox
    const host = createEngineHost(boxGraph, lifecycle, {channel: "metronome-sync", metronome: true})
    const edit = (procedure: Exec): void => {
        boxGraph.beginTransaction()
        procedure()
        boxGraph.endTransaction()
    }
    const bpmLabel: HTMLSpanElement = <span>120</span>
    const setBpm = (value: number): void => {
        bpmLabel.textContent = String(value)
        edit(() => timelineBox.bpm.setValue(value))
    }
    const setNominator = (value: number): void => edit(() => timelineBox.signature.nominator.setValue(value))
    const setDenominator = (value: number): void => edit(() => timelineBox.signature.denominator.setValue(value))
    return (
        <div className="page">
            <h2>Metronome</h2>
            <p>The SyncSource streams live TimelineBox edits to the wasm engine, which renders the click.
                bpm and signature changes apply while playing.</p>
            {host.element}
            <div className="metro-controls">
                <label>BPM {bpmLabel} </label>
                <input type="range" min="40" max="240" value="120"
                       oninput={(event: Event) => setBpm(parseInt((event.target as HTMLInputElement).value, 10))}/>
                <label>Signature </label>
                <select onchange={(event: Event) => setNominator(parseInt((event.target as HTMLSelectElement).value, 10))}>
                    {NOMINATORS.map(value => <option value={String(value)} selected={value === 4}>{String(value)}</option>)}
                </select>
                <span>/</span>
                <select onchange={(event: Event) => setDenominator(parseInt((event.target as HTMLSelectElement).value, 10))}>
                    {DENOMINATORS.map(value => <option value={String(value)} selected={value === 4}>{String(value)}</option>)}
                </select>
            </div>
            {host.log}
        </div>
    )
}
