// Measures the round trip of the armed audio capture's own chain after recording cycles and after the events
// that move it, with clicks scheduled on the studio context while the metronome is off.
const {Option} = window.__std
const context = P.env.audioContext
const input = await blackHole(context)
if (input === undefined) {return {error: "BlackHole 2ch not found"}}
P.engine.preferences.settings.metronome.enabled = false
P.captureDevices.allCaptures().forEach(capture => capture.armed.setValue(false))
const capture = P.captureDevices.allCaptures().find(capture => capture.constructor.name === "CaptureAudio")
P.editing.modify(() => capture.deviceId.setValue(Option.wrap(input.deviceId)))
capture.armed.setValue(true)
for (let attempt = 0; attempt < 100 && capture.outputNode.isEmpty(); attempt++) {await sleep(50)}
const processor = `registerProcessor("stamp", class extends AudioWorkletProcessor {
    process(inputs) {
        const channel = inputs[0]?.[0]
        if (channel !== undefined) {
            for (let index = 0; index < channel.length; index++) {
                if (Math.abs(channel[index]) > 0.25) {
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
    await context.audioWorklet.addModule(URL.createObjectURL(new Blob([processor], {type: "application/javascript"})))
    window.__stampContexts.add(context)
}
const click = context.createBuffer(1, 64, context.sampleRate)
click.getChannelData(0).fill(0.9)
const rows = []
const measure = async step => {
    const node = capture.outputNode.unwrapOrNull()
    if (node === null) {return rows.push({step, trip: "no chain"})}
    const stamp = new AudioWorkletNode(context, "stamp")
    const arrivals = []
    let lastArrival = -Infinity
    stamp.port.onmessage = ({data}) => {
        if (data - lastArrival > context.sampleRate * 0.15) {arrivals.push(data)}
        lastArrival = data
    }
    node.connect(stamp)
    const emitted = []
    const first = context.currentTime + 0.15
    for (let index = 0; index < 3; index++) {
        const source = context.createBufferSource()
        source.buffer = click
        source.connect(context.destination)
        source.start(first + index * 0.3)
        emitted.push(Math.round((first + index * 0.3) * context.sampleRate))
    }
    await sleep(1200)
    node.disconnect(stamp)
    const trips = emitted.map(frame => {
        const arrival = arrivals.find(value => value >= frame && value - frame < context.sampleRate * 0.15)
        return arrival === undefined ? "?" : ((arrival - frame) / context.sampleRate * 1000).toFixed(1)
    })
    rows.push({step, trip: trips.join(" "), state: context.state})
}
await measure("armed")
for (const cycle of [1, 2]) {
    P.engine.setPosition(0)
    P.startRecording(false)
    await sleep(800)
    await measure(`take ${cycle}: recording`)
    P.stopRecording()
    await sleep(2500)
    P.engine.stop(true)
    await measure(`take ${cycle}: saved and stopped`)
}
await core.AudioDevices.requestPermission()
await measure("after a permission request")
const second = await navigator.mediaDevices.getUserMedia({audio: {deviceId: {exact: input.deviceId}}})
second.getTracks().forEach(track => track.stop())
await measure("after a second stream on the device")
P.engine.setPosition(0)
P.startRecording(false)
await sleep(800)
await measure("next take: recording")
P.stopRecording()
await sleep(2500)
P.engine.stop(true)
capture.input.rechannel()
await sleep(300)
await measure("after a new source node on the same stream")
capture.armed.setValue(false)
await sleep(200)
capture.armed.setValue(true)
for (let attempt = 0; attempt < 100 && capture.outputNode.isEmpty(); attempt++) {await sleep(50)}
await sleep(300)
await measure("after re-arming")
return rows
