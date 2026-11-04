// Measures the round trip of the armed audio capture on BlackHole, so the recordings after it use it
const context = P.env.audioContext
const input = await blackHole(context)
if (input === undefined) {return {error: "BlackHole 2ch not found"}}
const {Option} = window.__std
P.engine.preferences.settings.metronome.enabled = false
P.captureDevices.allCaptures()
    .filter(capture => capture.constructor.name !== "CaptureAudio")
    .forEach(capture => capture.armed.setValue(false))
const capture = P.captureDevices.allCaptures().find(capture => capture.constructor.name === "CaptureAudio")
P.editing.modify(() => {
    capture.deviceId.setValue(Option.wrap(input.deviceId))
    capture.captureBox.inputLatency.setValue(-2.0)
})
const result = await capture.measureRoundTrip()
return {...result, ms: result.seconds * 1000, spreadMs: result.spreadSeconds * 1000, stored: capture.roundTrip.nonEmpty()}
