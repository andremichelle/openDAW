import {DefaultObservableValue} from "@opendaw/lib-std"

// Panel-wide control settings held at module scope, so they survive the panel unmounting and remounting
// (minimize -> reopen). The per-card models used to be `owned(lifecycle, …)`, which reset to their default
// every time the panel was reopened. Subscriptions to these still live in each card's lifecycle; only the
// values persist here. (Session-scoped; a full page reload resets them.)
export const AnalysisSettings = {
    vuRef: new DefaultObservableValue("0 dBFS"),
    spectrumLog: new DefaultObservableValue(true),
    spectrumSlope: new DefaultObservableValue("4.5 dB/oct"),
    spectrumHold: new DefaultObservableValue(false),
    spectrumAvg: new DefaultObservableValue(false),
    levelScale: new DefaultObservableValue("dBFS"),
    gonioMode: new DefaultObservableValue("L/R"),
    scopeTrig: new DefaultObservableValue(false)
} as const
