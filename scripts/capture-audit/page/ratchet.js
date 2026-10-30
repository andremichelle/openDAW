// One stream, measured, then left unpulled by the stamp for a pause, then measured again. With `keepAlive`
// a zero-gain sink on the destination keeps the source pulled through the pause.
const {keepAlive = false, pauseMs = 3000, studioContext = true} = window.__scenario
const context = studioContext ? P.env.audioContext : new AudioContext({latencyHint: "interactive"})
const input = await blackHole(context)
if (input === undefined) {return {error: "BlackHole 2ch not found"}}
await context.resume()
if (studioContext) {
    P.engine.stop(true)
    P.engine.preferences.settings.metronome.enabled = false
}
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
const media = await navigator.mediaDevices.getUserMedia({audio: {
    deviceId: {exact: input.deviceId}, echoCancellation: false, noiseSuppression: false, autoGainControl: false
}})
const source = context.createMediaStreamSource(media)
const sink = context.createGain()
sink.gain.value = 0.0
if (keepAlive) {
    source.connect(sink)
    sink.connect(context.destination)
}
const measure = async count => {
    const stamp = new AudioWorkletNode(context, "stamp")
    const arrivals = []
    let lastArrival = -Infinity
    stamp.port.onmessage = ({data}) => {
        if (data - lastArrival > context.sampleRate * 0.2) {arrivals.push(data)}
        lastArrival = data
    }
    source.connect(stamp)
    await new Promise(resolve => setTimeout(resolve, 300))
    const emitted = []
    const first = context.currentTime + 0.2
    for (let index = 0; index < count; index++) {
        const node = context.createBufferSource()
        node.buffer = click
        node.connect(context.destination)
        node.start(first + index * 0.5)
        emitted.push(Math.round((first + index * 0.5) * context.sampleRate))
    }
    await new Promise(resolve => setTimeout(resolve, (count * 0.5 + 0.5) * 1000))
    source.disconnect(stamp)
    const trips = emitted.map(frame => {
        const arrival = arrivals.find(value => value >= frame && value - frame < context.sampleRate * 0.2)
        return arrival === undefined ? NaN : (arrival - frame) / context.sampleRate * 1000
    })
    return trips.filter(Number.isFinite).map(value => value.toFixed(1)).join(" ")
}
const before = await measure(4)
await new Promise(resolve => setTimeout(resolve, pauseMs))
const after = await measure(4)
const again = await measure(4)
source.disconnect()
sink.disconnect()
media.getTracks().forEach(track => track.stop())
if (!studioContext) {await context.close()}
return {before, after, again}
