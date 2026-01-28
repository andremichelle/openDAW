import css from "./NamModelDialog.sass?inline"
import {createElement} from "@moises-ai/lib-jsx"
import {Html} from "@moises-ai/lib-dom"
import {Dialog} from "@/ui/components/Dialog"
import {IconSymbol} from "@moises-ai/studio-enums"
import {NamModel} from "@opendaw/nam-wasm"
import {isDefined, Terminator} from "@moises-ai/lib-std"
import {ArchitectureCanvas} from "./ArchitectureCanvas"
import {computeStats, HistogramCanvas} from "./HistogramCanvas"
import {MagnitudeCanvas} from "./MagnitudeCanvas"
import {Surface} from "@/ui/surface/Surface"

const className = Html.adoptStyleSheet(css, "NamModelDialog")

const formatDate = (date: NonNullable<NamModel["metadata"]>["date"]): string => {
    if (!isDefined(date)) return "Unknown"
    const {year, month, day, hour, minute} = date
    const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
    if (isDefined(hour) && isDefined(minute)) {
        return `${dateStr} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
    }
    return dateStr
}

const StatRow = ({label, value}: { label: string, value: string | number | undefined }) => {
    if (!isDefined(value) || value === "") {return null}
    return (
        <div className="stat">
            <span className="label">{label}</span>
            <span className="value">{value}</span>
        </div>
    )
}

export const showNamModelDialog = (model: NamModel): void => {
    const lifecycle = new Terminator()
    const weights = model.weights
    const hasWeights = isDefined(weights) && weights.length > 0
    const stats = hasWeights ? computeStats(weights) : null
    const meta = model.metadata
    const training = model.training
    const dialog = (
        <Dialog headline="NAM Properties"
                icon={IconSymbol.NeuralAmp}
                buttons={[{text: "Close", onClick: handler => handler.close(), primary: true}]}
                growWidth>
            <div className={className}>
                {isDefined(meta?.name) && <div className="name">{meta.name}</div>}
                <div className="section">
                    <h2>Model</h2>
                    <div className="stats">
                        <StatRow label="Modeled by" value={meta?.modeled_by}/>
                        <StatRow label="Gear Make" value={meta?.gear_make}/>
                        <StatRow label="Gear Model" value={meta?.gear_model}/>
                        <StatRow label="Gear Type" value={meta?.gear_type}/>
                        <StatRow label="Tone Type" value={meta?.tone_type}/>
                        <StatRow label="Date" value={meta?.date ? formatDate(meta.date) : undefined}/>
                    </div>
                </div>
                <div className="section">
                    <h2>Architecture</h2>
                    <div className="stats single-column">
                        <StatRow label="Type" value={model.architecture}/>
                        <StatRow label="Version" value={model.version}/>
                        <StatRow label="Layers" value={model.config.layers.length}/>
                        <StatRow label="Weights" value={stats?.count.toLocaleString()}/>
                    </div>
                </div>
                <div className="section">
                    <h2>Layer Diagram</h2>
                    <ArchitectureCanvas lifecycle={lifecycle} model={model}/>
                </div>
                <div className="section">
                    <h2>Calibration</h2>
                    <div className="stats single-column">
                        <StatRow label="Input Level"
                                 value={isDefined(meta?.input_level_dbu) ? `${meta.input_level_dbu.toFixed(1)} dBu` : undefined}/>
                        <StatRow label="Output Level"
                                 value={isDefined(meta?.output_level_dbu) ? `${meta.output_level_dbu.toFixed(1)} dBu` : undefined}/>
                        <StatRow label="Loudness"
                                 value={isDefined(meta?.loudness) ? `${meta.loudness.toFixed(2)} dB` : undefined}/>
                        <StatRow label="Gain" value={isDefined(meta?.gain) ? meta.gain.toFixed(4) : undefined}/>
                    </div>
                </div>
                {isDefined(training) && (
                    <div className="section">
                        <h2>Training</h2>
                        <div className="stats single-column">
                            <StatRow label="Validation ESR"
                                     value={isDefined(training.validation_esr) ? training.validation_esr.toFixed(6) : undefined}/>
                        </div>
                    </div>
                )}
                {hasWeights && stats !== null && (
                    <div className="section">
                        <h2>Weight Statistics</h2>
                        <div className="stats">
                            <StatRow label="Range" value={`[${stats.min.toFixed(4)}, ${stats.max.toFixed(4)}]`}/>
                            <StatRow label="Mean" value={stats.mean.toFixed(6)}/>
                            <StatRow label="Std Dev" value={stats.stdDev.toFixed(6)}/>
                            <StatRow label="Distribution"
                                     value={`${stats.positive} pos, ${stats.negative} neg, ${stats.zeros} zero`}/>
                        </div>
                    </div>
                )}
                {hasWeights && (
                    <div className="section">
                        <h2>Weight Distribution</h2>
                        <HistogramCanvas lifecycle={lifecycle} weights={weights}/>
                    </div>
                )}
                {hasWeights && (
                    <div className="section">
                        <h2>Weight Magnitude</h2>
                        <MagnitudeCanvas lifecycle={lifecycle} weights={weights}/>
                    </div>
                )}
            </div>
        </Dialog>
    )
    dialog.addEventListener("close", () => lifecycle.terminate())
    Surface.get().body.appendChild(dialog)
    dialog.showModal()
}