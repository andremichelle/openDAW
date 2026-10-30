// The browser alone, no studio: clicks scheduled on a fresh context's clock go out to BlackHole and come back
// through getUserMedia into a minimal worklet that stamps every quantum with its context frame. Reports the
// round trip of every click, for several streams opened one after another.
const {streams = 3, clicksPerStream = 20, studioContext = false, keepAlive = false} = window.__scenario
const context = studioContext ? P.env.audioContext : new AudioContext({latencyHint: "interactive"})
const input = await blackHole(context)
if (input === undefined) {return {error: "BlackHole 2ch not found"}}
await context.resume()
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
if (studioContext) {
    P.engine.stop(true)
    P.engine.preferences.settings.metronome.enabled = false
}
const click = context.createBuffer(1, 64, context.sampleRate)
click.getChannelData(0).fill(0.9)
const rows = []
for (let stream = 0; stream < streams; stream++) {
    const media = await navigator.mediaDevices.getUserMedia({audio: {
        deviceId: {exact: input.deviceId}, echoCancellation: false, noiseSuppression: false, autoGainControl: false
    }})
    const source = context.createMediaStreamSource(media)
    const stamp = new AudioWorkletNode(context, "stamp")
    const arrivals = []
    let lastArrival = -Infinity
    stamp.port.onmessage = ({data}) => {
        if (data - lastArrival > context.sampleRate * 0.2) {arrivals.push(data)}
        lastArrival = data
    }
    source.connect(stamp)
    const sink = context.createGain()
    sink.gain.value = 0.0
    if (keepAlive) {
        source.connect(sink)
        sink.connect(context.destination)
    }
    await new Promise(resolve => setTimeout(resolve, 500))
    const emitted = []
    const first = context.currentTime + 0.2
    for (let index = 0; index < clicksPerStream; index++) {
        const node = context.createBufferSource()
        node.buffer = click
        node.connect(context.destination)
        const time = first + index * 0.5
        node.start(time)
        emitted.push(Math.round(time * context.sampleRate))
    }
    await new Promise(resolve => setTimeout(resolve, (clicksPerStream * 0.5 + 0.6) * 1000))
    const trips = emitted.map(frame => {
        const arrival = arrivals.find(value => value >= frame && value - frame < context.sampleRate * 0.2)
        return arrival === undefined ? NaN : (arrival - frame) / context.sampleRate * 1000
    })
    const found = trips.filter(Number.isFinite)
    rows.push({
        stream, clicks: found.length,
        firstMs: found[0], lastMs: found[found.length - 1],
        minMs: Math.min(...found), maxMs: Math.max(...found),
        outputLatencyMs: context.outputLatency * 1000
    })
    source.disconnect()
    stamp.disconnect()
    sink.disconnect()
    media.getTracks().forEach(track => track.stop())
}
if (!studioContext) {await context.close()}
return rows
