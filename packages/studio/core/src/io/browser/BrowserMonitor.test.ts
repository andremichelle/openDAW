import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import type {Engine} from "../../Engine"
import {BrowserMonitor} from "./BrowserMonitor"

type FakeNode = {
    readonly kind: string
    readonly gain: {value: number}
    readonly pan: {value: number}
    readonly targets: Array<FakeNode>
    channelCount: number
    channelCountMode: string
    channelInterpretation: string
    connect(target: FakeNode): void
    disconnect(target?: FakeNode): void
}

const createNode = (kind: string): FakeNode => {
    const node: FakeNode = {
        kind, gain: {value: 1.0}, pan: {value: 0.0}, targets: [], channelCount: 2, channelCountMode: "max",
        channelInterpretation: "speakers",
        connect: target => {node.targets.push(target)},
        disconnect: target => {node.targets.splice(0, node.targets.length, ...node.targets.filter(entry => entry !== target && target !== undefined))}
    }
    return node
}

const setup = () => {
    const gains: Array<FakeNode> = []
    const context = {
        destination: createNode("destination"),
        createGain: () => {
            const node = createNode("gain")
            gains.push(node)
            return node
        },
        createStereoPanner: () => createNode("panner"),
        createChannelSplitter: () => createNode("splitter"),
        createChannelMerger: () => createNode("merger")
    }
    const registered: Array<AudioNode> = []
    const engine = {
        registerMonitoringSource: (_uuid: UUID.Bytes, node: AudioNode) => registered.push(node),
        unregisterMonitoringSource: () => {}
    }
    const monitor = new BrowserMonitor(context as unknown as AudioContext, engine as unknown as Engine, UUID.generate())
    const [input, left, right] = gains
    return {monitor, input, left, right, registered}
}

describe("BrowserMonitor", () => {
    // #577: the monitor pan follows the channel strip's balance, never above the input level
    it("pans with the channel strip's balance law", () => {
        const {monitor, left, right} = setup()
        expect([left.gain.value, right.gain.value]).toEqual([1.0, 1.0])
        monitor.pan = -1.0
        expect([left.gain.value, right.gain.value]).toEqual([1.0, 0.0])
        monitor.pan = 1.0
        expect([left.gain.value, right.gain.value]).toEqual([0.0, 1.0])
        monitor.pan = 0.5
        expect([left.gain.value, right.gain.value]).toEqual([0.5, 1.0])
        expect(monitor.panNode.pan.value).toBe(0.0)
    })
    it("upmixes a mono input to both sides before the balance", () => {
        const {input} = setup()
        expect([input.channelCount, input.channelCountMode, input.channelInterpretation]).toEqual([2, "explicit", "speakers"])
    })
    // #578: direct monitoring hears the same mixdown as the take and effects monitoring
    it("feeds direct monitoring from the monitoring mixdown", () => {
        const {monitor, input, registered} = setup()
        const sourceNode = createNode("source")
        const monitorMixdown = createNode("mixdown")
        monitor.bind({
            sourceNode: sourceNode as unknown as AudioNode,
            monitorMixdown: monitorMixdown as unknown as AudioNode,
            channelCount: 1
        })
        monitor.mode = "direct"
        expect(monitorMixdown.targets).toEqual([input])
        expect(sourceNode.targets).toEqual([])
        monitor.mode = "effects"
        expect(monitorMixdown.targets).toEqual([])
        expect(registered).toEqual([monitorMixdown])
    })
})
