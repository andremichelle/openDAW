import {createElement} from "@opendaw/lib-jsx"
import {EmptyExec} from "@opendaw/lib-std"
import {AudioMaterialFeatures} from "@opendaw/lib-dsp"
import {Colors} from "@opendaw/studio-enums"
import {Dialogs} from "@/ui/components/dialogs.tsx"

// Read-out of the offline material classifier (plans/riffle-material-classifier.md): the measured
// features first, the heuristic probability on top of them. Test surface for calibrating the weights,
// which is why every raw number is shown rather than a verdict alone.
export namespace AudioMaterialDialog {
    type Row = { label: string, value: string }

    const rows = (features: AudioMaterialFeatures): ReadonlyArray<Row> => [
        {label: "Duration", value: `${features.durationSeconds.toFixed(2)} s`},
        {label: "Onsets", value: `${features.onsetCount}`},
        {label: "Onset density", value: `${features.onsetsPerSecond.toFixed(2)} /s`},
        {
            label: "Attack strength (mean / median)", value:
                `${features.strengthMean.toFixed(3)} / ${features.strengthMedian.toFixed(3)}`
        },
        {
            label: "Harmonicity (mean / median)", value:
                `${features.harmonicityMean.toFixed(3)} / ${features.harmonicityMedian.toFixed(3)}`
        },
        {label: "Pitched segments", value: `${(features.pitchedFraction * 100.0).toFixed(1)} %`},
        {label: "Percussive segments", value: `${(features.percussiveFraction * 100.0).toFixed(1)} %`},
        {label: "Beat regularity", value: features.beatRegularity.toFixed(3)},
        {label: "RMS", value: features.rms.toFixed(4)},
        {label: "Analyzer version", value: `${features.analyzerVersion}`}
    ]

    export const show = (headline: string, features: AudioMaterialFeatures, origin?: Element): Promise<void> => {
        const percent = (features.drumLoopProbability * 100.0).toFixed(1)
        const suggestion = features.drumLoopProbability >= 0.5 ? "drum loop (granular)" : "sustained (phase vocoder)"
        const content = (
            <div style={{display: "flex", flexDirection: "column", gap: "0.75em", minWidth: "22em"}}>
                <div style={{display: "flex", justifyContent: "space-between", alignItems: "baseline"}}>
                    <span>drum loop probability</span>
                    <span style={{fontSize: "1.5em", color: Colors.bright.toString()}}>{`${percent} %`}</span>
                </div>
                <span style={{opacity: "0.6"}}>{`suggests ${suggestion}`}</span>
                <div style={{display: "grid", gridTemplateColumns: "1fr auto", gap: "0.25em 1.5em"}}>
                    {rows(features).flatMap(({label, value}) => [
                        (<span style={{opacity: "0.6"}}>{label}</span>),
                        (<span style={{textAlign: "right", fontVariantNumeric: "tabular-nums"}}>{value}</span>)
                    ])}
                </div>
            </div>
        )
        return Dialogs.show({headline, content, origin}).catch(EmptyExec)
    }
}
