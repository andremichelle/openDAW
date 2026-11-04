// Plays the metronome into BlackHole, records BlackHole's input and finds where the clicks landed on the
// beat grid. `roundTripMs` is the gap plus the latency the recorder applied: the delay the path really has.
const {keepArmed = false, inputLatency = 0} = window.__scenario
const {Option} = window.__std
const context = P.env.audioContext
const input = await blackHole(context)
if (input === undefined) {return {error: "BlackHole 2ch not found"}}
P.engine.preferences.settings.metronome.enabled = true
P.editing.modify(() => P.timelineBox.loopArea.enabled.setValue(false))
P.captureDevices.allCaptures()
    .filter(capture => capture.constructor.name !== "CaptureAudio")
    .forEach(capture => capture.armed.setValue(false))
const capture = P.captureDevices.allCaptures().find(capture => capture.constructor.name === "CaptureAudio")
P.editing.modify(() => capture.captureBox.inputLatency.setValue(inputLatency))
if (!keepArmed || !capture.armed.getValue()) {
    capture.armed.setValue(false)
    P.editing.modify(() => capture.deviceId.setValue(Option.wrap(input.deviceId)))
    await sleep(100)
    capture.armed.setValue(true)
    for (let attempt = 0; attempt < 100 && capture.stream.isEmpty(); attempt++) {await sleep(50)}
}
const unit = P.rootBoxAdapter.audioUnits.adapters()
    .find(unit => unit.box.capture.targetVertex.mapOr(vertex => vertex.box.name === "CaptureAudioBox", false))
P.editing.modify(() => unit.tracks.values().flatMap(track => track.regions.collection.asArray()).forEach(region => region.box.delete()))
if (P.timelineBox.bpm.getValue() !== 120) {P.editing.modify(() => P.timelineBox.bpm.setValue(120))}
P.engine.setPosition(0)
const stampSource = `registerProcessor("stamp", class extends AudioWorkletProcessor {
    process(inputs) {
        const channel = inputs[0]?.[0]
        if (channel !== undefined) {
            for (let index = 0; index < channel.length; index++) {
                if (Math.abs(channel[index]) > 0.05) {
                    this.port.postMessage(currentFrame + index)
                    break
                }
            }
        }
        return true
    }
})`
window.__stampContexts ??= new WeakSet()
if (!window.__stampContexts.has(context)) {
    await context.audioWorklet.addModule(URL.createObjectURL(new Blob([stampSource], {type: "application/javascript"})))
    window.__stampContexts.add(context)
}
const stamp = new AudioWorkletNode(context, "stamp")
const arrivals = []
let lastArrival = -Infinity
stamp.port.onmessage = ({data}) => {
    if (data - lastArrival > context.sampleRate * 0.2) {arrivals.push(data)}
    lastArrival = data
}
const emitter = new AudioWorkletNode(context, "stamp")
const emissions = []
let lastEmission = -Infinity
emitter.port.onmessage = ({data}) => {
    if (data - lastEmission > context.sampleRate * 0.2) {emissions.push(data)}
    lastEmission = data
}
window.__worklet.connect(emitter, 0)
await sleep(300)
const previousStart = P.engine.recordingStart.mapOr(start => start.contextTime, -1)
P.startRecording(false)
for (let attempt = 0; attempt < 1000 && [-1, previousStart].includes(P.engine.recordingStart.mapOr(start => start.contextTime, -1)); attempt++) {await sleep(5)}
// the recording reads the stream through a node built when it was prepared
capture.outputNode.unwrap().connect(stamp)
const lags = []
for (let index = 0; index < 32; index++) {
    const stamp = context.getOutputTimestamp()
    if (stamp.performanceTime > 0) {lags.push((context.currentTime - stamp.contextTime - (performance.now() - stamp.performanceTime) / 1000) * 1000)}
    await sleep(100)
}
P.stopRecording()
await sleep(2500)
P.engine.stop(true)
stamp.disconnect()
window.__worklet.disconnect(emitter)
emitter.disconnect()
const started = P.engine.recordingStart.unwrap()
const beatFrame = position => (started.contextTime + (position - started.position) / 1920) * context.sampleRate
const emissionMinusBeatMs = emissions
    .filter(frame => frame >= beatFrame(started.position))
    .map(frame => {
        const position = started.position + (frame / context.sampleRate - started.contextTime) * 1920
        return +((frame - beatFrame(Math.round(position / 960) * 960)) / context.sampleRate * 1000).toFixed(2)
    }).join(" ")
const takes = unit.tracks.values().flatMap(track => track.regions.collection.asArray())
if (takes.length !== 1) {return {error: `${takes.length} takes`}}
const [region] = takes
const loader = P.sampleManager.getOrCreate(region.box.file.targetVertex.unwrap().box.address.uuid)
for (let attempt = 0; attempt < 100 && loader.data.isEmpty(); attempt++) {await sleep(50)}
const {frames: [samples], sampleRate} = loader.data.unwrap()
const onsets = []
let quiet = sampleRate
for (let index = 0; index < samples.length; index++) {
    if (Math.abs(samples[index]) > 0.05) {
        if (quiet > sampleRate * 0.2) {onsets.push(index)}
        quiet = 0
    } else {
        quiet++
    }
}
const takeStart = region.position / 1920
const offset = region.box.waveformOffset.getValue()
const gaps = onsets.map(frame => {
    const time = takeStart + frame / sampleRate - offset
    return (time - Math.round(time / 0.5) * 0.5) * 1000
}).sort((a, b) => a - b)
const applied = window.__logs.filter(line => line.includes("[RecordAudio] outputLatency=")).at(-1) ?? ""
const appliedMs = [...applied.matchAll(/=([0-9.e-]+)/g)].reduce((sum, match) => sum + Number(match[1]) * 1000, 0)
const gapMs = gaps[Math.floor(gaps.length / 2)]
return {
    file: region.box.file.targetVertex.unwrap().box.address.toString().slice(0, 8),
    clicks: gaps.length,
    gapMs,
    spreadMs: gaps.length > 0 ? gaps[gaps.length - 1] - gaps[0] : NaN,
    appliedMs,
    roundTripMs: gapMs + appliedMs,
    reportedOutputMs: context.outputLatency * 1000,
    compensationMs: P.engine.compensationLatency.getValue() * 1000,
    emissionMinusBeatMs,
    fileMinusArrivalFrames: (() => {
        const anchored = window.__logs.filter(line => line.includes("anchored:")).at(-1) ?? ""
        const firstFrame = Number(/firstQuantumTime=([0-9.]+)/.exec(anchored)?.[1]) * sampleRate
        return onsets.map(frame => {
            const arrival = arrivals.find(value => Math.abs(value - firstFrame - frame) < sampleRate * 0.1)
            return arrival === undefined ? "?" : Math.round(frame - (arrival - firstFrame))
        }).join(" ")
    })(),
    gapsMs: onsets.map(frame => {
        const time = takeStart + frame / sampleRate - offset
        return +((time - Math.round(time / 0.5) * 0.5) * 1000).toFixed(1)
    }).join(" "),
    timestampLagMs: lags.sort((a, b) => a - b)[lags.length >> 1],
    tripMinusLagMs: gapMs + appliedMs - lags[lags.length >> 1]
}
