import {int, isDefined, Nullable, SortedSet, Terminable, UUID} from "@moises-ai/lib-std"
import {MonitoringMapEntry, EngineCommands} from "@moises-ai/studio-adapters"

const MAX_MONITORING_CHANNELS = 8

type MonitoringSource = {
    uuid: UUID.Bytes
    sourceNode: AudioNode
    numChannels: 1 | 2
    destinationNode: AudioNode
}

export class MonitoringRouter implements Terminable {
    readonly #context: BaseAudioContext
    readonly #worklet: AudioWorkletNode
    readonly #commands: EngineCommands
    readonly #splitter: ChannelSplitterNode
    readonly #sources: SortedSet<UUID.Bytes, MonitoringSource> = UUID.newSet<MonitoringSource>(entry => entry.uuid)

    #inputMerger: Nullable<ChannelMergerNode> = null
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

    #rebuild(): void {
        if (isDefined(this.#inputMerger)) {
            this.#inputMerger.disconnect()
            this.#inputMerger = null
        }
        for (const merger of this.#outputMergers) {
            merger.disconnect()
        }
        this.#outputMergers = []
        if (this.#sources.isEmpty()) {
            this.#commands.updateMonitoringMap([])
            return
        }
        let totalChannels = 0
        for (const {numChannels} of this.#sources) {
            totalChannels += numChannels
        }
        if (totalChannels > MAX_MONITORING_CHANNELS) {
            console.warn(`MonitoringRouter: ${totalChannels} channels requested, max is ${MAX_MONITORING_CHANNELS}. Some sources will not receive effects monitoring.`)
        }
        const usedChannels = Math.min(totalChannels, MAX_MONITORING_CHANNELS)
        this.#inputMerger = this.#context.createChannelMerger(usedChannels)
        this.#inputMerger.connect(this.#worklet)
        const map: Array<MonitoringMapEntry> = []
        let channel = 0
        for (const {uuid, sourceNode, numChannels, destinationNode} of this.#sources) {
            if (channel + numChannels > MAX_MONITORING_CHANNELS) {break}
            const inputSplitter = this.#context.createChannelSplitter(numChannels)
            sourceNode.connect(inputSplitter)
            const channels: Array<int> = []
            for (let i = 0; i < numChannels; i++) {
                inputSplitter.connect(this.#inputMerger, i, channel)
                channels.push(channel)
                channel++
            }
            map.push({uuid, channels})
            const outputMerger = this.#context.createChannelMerger(2)
            if (numChannels === 2) {
                this.#splitter.connect(outputMerger, channels[0], 0)
                this.#splitter.connect(outputMerger, channels[1], 1)
            } else {
                this.#splitter.connect(outputMerger, channels[0], 0)
                this.#splitter.connect(outputMerger, channels[0], 1)
            }
            outputMerger.connect(destinationNode)
            this.#outputMergers.push(outputMerger)
        }
        this.#commands.updateMonitoringMap(map)
    }

    terminate(): void {
        if (isDefined(this.#inputMerger)) {
            this.#inputMerger.disconnect()
            this.#inputMerger = null
        }
        for (const merger of this.#outputMergers) {
            merger.disconnect()
        }
        this.#outputMergers = []
        this.#sources.clear()
    }
}
