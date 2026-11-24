import {Errors, int, isDefined, Nullable, SortedSet, Terminable, tryCatch, UUID} from "@opendaw/lib-std"
import {MonitoringMapEntry, EngineCommands} from "@opendaw/studio-adapters"

// two per source, matches the engine's MONITOR_CHANNELS
export const MAX_MONITORING_CHANNELS = 16

export type MonitoringSource = {
    readonly uuid: UUID.Bytes
    readonly sourceNode: AudioNode
    readonly numChannels: 1 | 2
    readonly destinationNode: AudioNode
}

const isInvalidAccess = (error: unknown): boolean => Errors.isDOMException(error) && error.name === "InvalidAccessError"

export class MonitoringRouter implements Terminable {
    readonly #context: BaseAudioContext
    readonly #worklet: AudioWorkletNode
    readonly #commands: EngineCommands
    readonly #splitter: ChannelSplitterNode
    readonly #sources: SortedSet<UUID.Bytes, MonitoringSource> = UUID.newSet<MonitoringSource>(entry => entry.uuid)

    #inputMerger: Nullable<ChannelMergerNode> = null
    #inputSplitters: Array<[AudioNode, ChannelSplitterNode]> = []
    #outputMergers: Array<ChannelMergerNode> = []

    constructor(worklet: AudioWorkletNode, commands: EngineCommands) {
        this.#context = worklet.context
        this.#worklet = worklet
        this.#commands = commands
        this.#splitter = this.#context.createChannelSplitter(MAX_MONITORING_CHANNELS)
        worklet.connect(this.#splitter, 1)
    }

    registerSource(uuid: UUID.Bytes, sourceNode: AudioNode, numChannels: 1 | 2, destinationNode: AudioNode): void {
        this.#sources.add({uuid, sourceNode, numChannels, destinationNode}, true)
        this.#rebuild()
    }

    unregisterSource(uuid: UUID.Bytes): void {
        this.#sources.removeByKeyIfExist(uuid)
        this.#rebuild()
    }

    // every source takes two channels: the strip returns stereo, a mono input goes into both sides
    #rebuild(): void {
        this.#disconnectAll()
        if (this.#sources.isEmpty()) {
            this.#commands.updateMonitoringMap([])
            return
        }
        const totalChannels = this.#sources.size() * 2
        if (totalChannels > MAX_MONITORING_CHANNELS) {
            console.warn(`MonitoringRouter: ${totalChannels} channels requested, max is ${MAX_MONITORING_CHANNELS}. Some sources will not receive effects monitoring.`)
        }
        const inputMerger = this.#context.createChannelMerger(Math.min(totalChannels, MAX_MONITORING_CHANNELS))
        inputMerger.connect(this.#worklet)
        this.#inputMerger = inputMerger
        const map: Array<MonitoringMapEntry> = []
        let channel = 0
        for (const {uuid, sourceNode, numChannels, destinationNode} of this.#sources) {
            if (channel + 2 > MAX_MONITORING_CHANNELS) {break}
            const inputSplitter = this.#context.createChannelSplitter(numChannels)
            sourceNode.connect(inputSplitter)
            this.#inputSplitters.push([sourceNode, inputSplitter])
            const channels: ReadonlyArray<int> = [channel, channel + 1]
            channels.forEach((target, side) => inputSplitter.connect(inputMerger, Math.min(side, numChannels - 1), target))
            map.push({uuid, channels})
            const outputMerger = this.#context.createChannelMerger(2)
            this.#splitter.connect(outputMerger, channels[0], 0)
            this.#splitter.connect(outputMerger, channels[1], 1)
            outputMerger.connect(destinationNode)
            this.#outputMergers.push(outputMerger)
            channel += 2
        }
        this.#commands.updateMonitoringMap(map)
    }

    #disconnectAll(): void {
        if (isDefined(this.#inputMerger)) {
            this.#inputMerger.disconnect()
            this.#inputMerger = null
        }
        this.#inputSplitters.forEach(([sourceNode, inputSplitter]) => {
            // the source's owner may have disconnected it already
            const disconnected = tryCatch(() => sourceNode.disconnect(inputSplitter))
            if (disconnected.status === "failure" && !isInvalidAccess(disconnected.error)) {throw disconnected.error}
            inputSplitter.disconnect()
        })
        this.#inputSplitters = []
        this.#outputMergers.forEach(merger => {
            this.#splitter.disconnect(merger)
            merger.disconnect()
        })
        this.#outputMergers = []
    }

    terminate(): void {
        this.#disconnectAll()
        this.#sources.clear()
    }
}
