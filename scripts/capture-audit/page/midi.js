// Sends a pattern over the virtual cable, every key at the instant its position is heard, and compares
// what the recorder wrote. Pitches are unique per note, so every note is matched to what was sent.
const {bpm, loop = false, countIn = false, jankAt = -1, pickups = false} = window.__scenario
const Bar = 3840
const pulsesPerSecond = bpm * 16
const {Option} = window.__std
// a prompt would block an unattended run
const permission = await navigator.permissions.query({name: "midi"}).then(status => status.state, () => "granted")
// Firefox reports 'prompt' although its test preference grants access without asking
if (permission !== "granted" && window.__scenario.browser !== "firefox") {return {error: `MIDI permission is '${permission}'`}}
await core.MidiDevices.requestPermission()
const access = await navigator.requestMIDIAccess({sysex: false})
const output = [...access.outputs.values()].find(port => port.name === "openDAW Loop In")
const loopOut = [...access.inputs.values()].find(port => port.name === "openDAW Loop Out")
if (output === undefined || loopOut === undefined) {return {error: "virtual cable not found"}}
P.captureDevices.allCaptures().forEach(capture => capture.armed.setValue(false))
const capture = P.captureDevices.allCaptures().find(capture => capture.constructor.name === "CaptureMidi")
P.editing.modify(() => capture.deviceId.setValue(Option.wrap(loopOut.id)))
capture.armed.setValue(true)
await sleep(500)
const unit = P.rootBoxAdapter.audioUnits.adapters()
    .find(unit => unit.box.capture.targetVertex.mapOr(vertex => vertex.box.name === "CaptureMidiBox", false))
P.editing.modify(() => {
    unit.tracks.values().flatMap(track => track.regions.collection.asArray()).forEach(region => region.box.delete())
    P.timelineBox.bpm.setValue(bpm)
    const {loopArea} = P.timelineBox
    loopArea.from.setValue(0)
    loopArea.to.setValue(Bar)
    loopArea.enabled.setValue(loop)
})
const {settings} = P.engine.preferences
settings.recording.allowTakes = true
settings.recording.countInBars = 1
settings.metronome.enabled = false
// the cable's first forward is a few milliseconds late
output.send([0x90, 1, 1], performance.now() + 10)
output.send([0x80, 1, 0], performance.now() + 20)
P.engine.setPosition(0)
await sleep(500)
const context = P.env.audioContext
// the cable may forward late: the recorder is judged against the receipt stamp, the cable against the request
const receipts = new Map()
// Firefox stamps on its own clock, converted the way the studio's MIDI port does it
let foreignOffset = -Infinity
const pageTime = timeStamp => {
    const delta = timeStamp - performance.now()
    if (Math.abs(delta) < 1000) {return timeStamp}
    foreignOffset = Math.max(foreignOffset, delta)
    return timeStamp - foreignOffset
}
const onReceipt = ({data, timeStamp}) => {
    const key = `${(data[0] & 0xF0) === 0x90 ? "on" : "off"} ${data[1]}`
    if (!receipts.has(key)) {receipts.set(key, pageTime(timeStamp))}
}
loopOut.addEventListener("midimessage", onReceipt)
const previousStart = P.engine.recordingStart.mapOr(start => start.contextTime, -1)
const requested = performance.now()
P.startRecording(countIn)
const notes = []
if (pickups) {
    const barMillis = Bar / pulsesPerSecond * 1000
    const at = fraction => requested + 150 + fraction * barMillis
    notes.push({pitch: 20, on: at(0.15), off: at(0.15) + 100, pickup: true})
    notes.push({pitch: 21, on: at(0.35), off: at(0.35) + 100, pickup: true})
    notes.push({pitch: 22, on: at(0.75), off: at(0.75) + barMillis / 2, pickup: true})
    notes.forEach(({pitch, on, off}) => {
        output.send([0x90, pitch, 100], on)
        output.send([0x80, pitch, 0], off)
    })
}
for (let attempt = 0; attempt < 4000 && [-1, previousStart].includes(P.engine.recordingStart.mapOr(start => start.contextTime, -1)); attempt++) {await sleep(2)}
const start = P.engine.recordingStart.unwrap()
const heardAt = position => {
    const stamp = context.getOutputTimestamp()
    return stamp.performanceTime + (start.contextTime + (position - start.position) / pulsesPerSecond - stamp.contextTime) * 1000
}
const heardPositionAt = time => {
    const stamp = context.getOutputTimestamp()
    return start.position + (stamp.contextTime + (time - stamp.performanceTime) / 1000 - start.contextTime) * pulsesPerSecond
}
// two bars of eighths, then a bar of 1/32 notes, each held half its step
const base = Math.ceil(start.position / Bar) * Bar + Bar
const pattern = []
for (let index = 0; index < 16; index++) {pattern.push([base + index * 480, 240])}
for (let index = 0; index < 32; index++) {pattern.push([base + 2 * Bar + index * 120, 60])}
pattern.forEach(([position, length], index) => {
    const pitch = 36 + index
    const on = heardAt(position)
    const off = heardAt(position + length)
    notes.push({pitch, position, length, on, off})
    output.send([0x90, pitch, 100], on)
    output.send([0x80, pitch, 0], off)
})
if (jankAt >= 0) {
    const target = notes.find(note => note.position === base + jankAt).on
    setTimeout(() => {
        const end = performance.now() + 150
        while (performance.now() < end) {}
    }, target - performance.now())
}
await sleep(Math.max(...notes.map(note => note.off)) - performance.now() + 400)
loopOut.removeEventListener("midimessage", onReceipt)
P.stopRecording()
await sleep(800)
P.engine.stop(true)
await sleep(300)
const recorded = new Map()
const regions = unit.tracks.values().flatMap(track => track.regions.collection.asArray())
regions.forEach(region => region.optCollection.ifSome(collection => collection.events.asArray()
    .forEach(event => recorded.set(event.pitch, {position: region.position + event.position, duration: event.duration}))))
const wrapped = position => loop ? ((position % Bar) + Bar) % Bar : position
const rows = notes.filter(note => !note.pickup).map(note => {
    const entry = recorded.get(note.pitch)
    if (entry === undefined) {return {missing: true}}
    const onAt = receipts.get(`on ${note.pitch}`) ?? note.on
    const offAt = receipts.get(`off ${note.pitch}`) ?? note.off
    const receivedPosition = heardPositionAt(onAt)
    const receivedLength = (offAt - onAt) / 1000 * pulsesPerSecond
    return {
        errorMs: (entry.position - wrapped(receivedPosition)) / pulsesPerSecond * 1000,
        lengthErrorMs: (entry.duration - receivedLength) / pulsesPerSecond * 1000,
        cableMs: Math.max(Math.abs(onAt - note.on), Math.abs(offAt - note.off))
    }
})
const found = rows.filter(row => !row.missing)
const result = {
    notes: rows.length,
    missing: rows.length - found.length,
    worstErrorMs: Math.max(0, ...found.map(row => Math.abs(row.errorMs))),
    worstLengthErrorMs: Math.max(0, ...found.map(row => Math.abs(row.lengthErrorMs))),
    worstCableMs: Math.max(0, ...found.map(row => row.cableMs)),
    takes: regions.length,
    worstNote: found.length === 0 ? "" : (() => {
        const index = rows.findIndex(row => !row.missing
            && Math.max(Math.abs(row.errorMs), Math.abs(row.lengthErrorMs)) === Math.max(...found.map(entry => Math.max(Math.abs(entry.errorMs), Math.abs(entry.lengthErrorMs)))))
        return `#${index} ${rows[index].errorMs.toFixed(2)} / ${rows[index].lengthErrorMs.toFixed(2)} ms`
    })()
}
if (pickups) {
    result.pickups = notes.filter(note => note.pickup)
        .map(note => recorded.has(note.pitch) ? `at ${recorded.get(note.pitch).position}` : "dropped").join(", ")
}
return result
