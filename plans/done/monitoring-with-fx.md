# Monitoring with FX

## Goal
Route monitoring audio through the AudioUnit's effect chain instead of directly to speakers.

## Approach
1. Recreate `ChannelMergerNode` on every monitoring state change
2. Map: `Array<{ uuid: UUID.Bytes, channels: Array<int> }>`
3. `MonitoringMixProcessor` reads assigned channels, mixes into instrument buffer
4. Map sent to worklet on every rebuild

## Architecture

### Main Thread (EngineWorklet.ts)
```typescript
#channelMerger: Nullable<ChannelMergerNode> = null
#monitoringSources: Map<UUID.Bytes, { node: AudioNode, numChannels: 1 | 2 }> = UUID.newMap()

registerMonitoringSource(uuid: UUID.Bytes, node: AudioNode, numChannels: 1 | 2): void {
    this.#monitoringSources.set(uuid, { node, numChannels })
    this.#rebuildMonitoringMerger()
}

unregisterMonitoringSource(uuid: UUID.Bytes): void {
    this.#monitoringSources.delete(uuid)
    this.#rebuildMonitoringMerger()
}

#rebuildMonitoringMerger(): void {
    // Disconnect old merger
    if (isDefined(this.#channelMerger)) {
        this.#channelMerger.disconnect()
        this.#channelMerger = null
    }

    if (this.#monitoringSources.size === 0) {
        this.#commands.updateMonitoringMap([])
        return
    }

    // Calculate total channels needed
    let totalChannels = 0
    for (const { numChannels } of this.#monitoringSources.values()) {
        totalChannels += numChannels
    }

    // Create new merger
    this.#channelMerger = this.context.createChannelMerger(totalChannels)
    this.#channelMerger.connect(this)

    // Connect sources and build map
    const map: Array<{ uuid: UUID.Bytes, channels: Array<int> }> = []
    let channel = 0

    for (const [uuid, { node, numChannels }] of this.#monitoringSources) {
        if (numChannels === 2) {
            const splitter = this.context.createChannelSplitter(2)
            node.connect(splitter)
            splitter.connect(this.#channelMerger, 0, channel)
            splitter.connect(this.#channelMerger, 1, channel + 1)
            map.push({ uuid, channels: [channel, channel + 1] })
            channel += 2
        } else {
            node.connect(this.#channelMerger, 0, channel)
            map.push({ uuid, channels: [channel] })
            channel += 1
        }
    }

    this.#commands.updateMonitoringMap(map)
}
```

### Worklet Thread (EngineProcessor.ts)
```typescript
#currentInput: ReadonlyArray<Float32Array> = []

// In render()
render(inputs: Float32Array[][], ...): boolean {
    this.#currentInput = inputs[0] ?? []
    // ...
}

// Command handler
updateMonitoringMap: (map: Array<{ uuid: UUID.Bytes, channels: Array<int> }>) => {
    this.#audioUnits.forEach(unit => unit.clearMonitoringChannels())
    for (const { uuid, channels } of map) {
        this.optAudioUnit(uuid).ifSome(unit => unit.setMonitoringChannels(channels))
    }
}

getMonitoringChannel(channelIndex: int): Option<Float32Array> {
    if (channelIndex >= this.#currentInput.length) return Option.None
    return Option.wrap(this.#currentInput[channelIndex])
}
```

### MonitoringMixProcessor.ts
```typescript
export class MonitoringMixProcessor extends AbstractProcessor implements Processor, AudioInput {
    #source: Option<AudioBuffer> = Option.None
    #channels: Option<Array<int>> = Option.None

    setAudioSource(source: AudioBuffer): Terminable {
        this.#source = Option.wrap(source)
        return { terminate: () => this.#source = Option.None }
    }

    setChannels(channels: Array<int>): void {
        this.#channels = Option.wrap(channels)
    }

    clearChannels(): void {
        this.#channels = Option.None
    }

    get isActive(): boolean {
        return this.#channels.nonEmpty()
    }

    process(_processInfo: ProcessInfo): void {
        if (this.#source.isEmpty() || this.#channels.isEmpty()) return
        const [targetL, targetR] = this.#source.unwrap().channels()
        const channels = this.#channels.unwrap()

        const optL = this.context.getMonitoringChannel(channels[0])
        if (optL.isEmpty()) return
        const inputL = optL.unwrap()

        const inputR = channels.length === 2
            ? this.context.getMonitoringChannel(channels[1]).unwrapOrElse(inputL)
            : inputL

        for (let i = 0; i < RenderQuantum; i++) {
            targetL[i] += inputL[i]
            targetR[i] += inputR[i]
        }
    }
}
```

### AudioDeviceChain.ts (`#wire`)
```typescript
#monitoringMixer: Option<MonitoringMixProcessor> = Option.None

#wire(): void {
    let source: AudioDeviceProcessor = optInput.unwrap()
    let edgeSource: Processor = source.outgoing

    if (this.#monitoringMixer.nonEmpty() && this.#monitoringMixer.unwrap().isActive) {
        const mixer = this.#monitoringMixer.unwrap()
        this.#disconnector.own(mixer.setAudioSource(source.audioOutput))
        this.#disconnector.own(context.registerEdge(source.outgoing, mixer))
        edgeSource = mixer
    }

    for (const target of this.#orderedEffects) {
        if (target.adapter().enabledField.getValue()) {
            this.#disconnector.own(target.setAudioSource(source.audioOutput))
            this.#disconnector.own(context.registerEdge(edgeSource, target.incoming))
            source = target
            edgeSource = target.outgoing
        }
    }
    // ... channelStrip, output
}
```

### CaptureAudio.ts
```typescript
type MonitoringMode = "off" | "direct" | "effects"

#monitoringMode: MonitoringMode = "off"

get monitoringMode(): MonitoringMode { return this.#monitoringMode }
set monitoringMode(value: MonitoringMode) {
    if (this.#monitoringMode === value) return
    this.#disconnectMonitoring()
    this.#monitoringMode = value
    this.#connectMonitoring()
}

// In constructor, subscribe to requestChannels changes:
captureAudioBox.requestChannels.catchupAndSubscribe(owner => {
    // ... existing channel handling ...

    // Re-register if monitoring with effects (channel count may have changed)
    if (this.#monitoringMode === "effects" && isDefined(this.#audioChain)) {
        const engine = this.manager.project.engine
        engine.unregisterMonitoringSource(this.audioUnitBox.address.uuid)
        engine.registerMonitoringSource(this.audioUnitBox.address.uuid, this.#audioChain.gainNode, this.#audioChain.channelCount)
    }
})

#connectMonitoring(): void {
    if (!isDefined(this.#audioChain)) return
    switch (this.#monitoringMode) {
        case "off":
            break
        case "direct":
            this.#audioChain.gainNode.connect(this.manager.project.env.audioContext.destination)
            break
        case "effects":
            const engine = this.manager.project.engine
            engine.registerMonitoringSource(this.audioUnitBox.address.uuid, this.#audioChain.gainNode, this.#audioChain.channelCount)
            break
    }
}

#disconnectMonitoring(): void {
    if (!isDefined(this.#audioChain)) return
    switch (this.#monitoringMode) {
        case "off":
            break
        case "direct":
            this.#audioChain.gainNode.disconnect(this.manager.project.env.audioContext.destination)
            break
        case "effects":
            this.#audioChain.gainNode.disconnect()
            this.manager.project.engine.unregisterMonitoringSource(this.audioUnitBox.address.uuid)
            break
    }
}
```

## Flow
```
CaptureAudio.monitorWithEffects = true
    ↓
engine.registerMonitoringSource(uuid, gainNode, numChannels)
    ↓
#rebuildMonitoringMerger()
    ↓
- disconnect old merger
- create new ChannelMergerNode(totalChannels)
- connect all sources
- build map with channel assignments
- commands.updateMonitoringMap(map)
    ↓
EngineProcessor: clear all → set channels for units in map
    ↓
AudioUnit.setMonitoringChannels() → invalidateWiring()
    ↓
#wire() includes mixer in edge chain
```

## Processing Order
```
instrument.process()  →  mixer.process()  →  effect.process()
     ↓                        ↓
writes to buffer      reads from input[0][channels],
                      mixes into source buffer
```
