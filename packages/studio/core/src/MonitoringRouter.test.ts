import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {EngineCommands, MonitoringMapEntry} from "@opendaw/studio-adapters"
import {MonitoringRouter} from "./MonitoringRouter"

type Link = { from: FakeNode, to: FakeNode, output: number, input: number }

// records the connections, so the test can read where each channel goes
class FakeNode {
    static readonly links: Array<Link> = []

    readonly name: string
    readonly context: FakeContext

    constructor(name: string,
                context: FakeContext) {
        this.name = name
        this.context = context
    }

    connect(to: FakeNode, output: number = 0, input: number = 0): void {FakeNode.links.push({from: this, to, output, input})}
    disconnect(to?: FakeNode): void {
        const before = FakeNode.links.length
        for (let index = FakeNode.links.length - 1; index >= 0; index--) {
            const link = FakeNode.links[index]
            if (link.from === this && (to === undefined || link.to === to)) {FakeNode.links.splice(index, 1)}
        }
        if (to !== undefined && before === FakeNode.links.length) {throw new Error("not connected")}
    }
}

class FakeContext {
    #count = 0
    createChannelSplitter(channels: number): FakeNode {return new FakeNode(`splitter${channels}#${this.#count++}`, this)}
    createChannelMerger(channels: number): FakeNode {return new FakeNode(`merger${channels}#${this.#count++}`, this)}
}

const createRouter = () => {
    FakeNode.links.length = 0
    const context = new FakeContext()
    const worklet = new FakeNode("worklet", context)
    const maps: Array<ReadonlyArray<MonitoringMapEntry>> = []
    const commands = {updateMonitoringMap: (map: ReadonlyArray<MonitoringMapEntry>) => maps.push(map)}
    const router = new MonitoringRouter(worklet as unknown as AudioWorkletNode, commands as unknown as EngineCommands)
    const engineOutput = FakeNode.links.find(link => link.from === worklet)!.to
    return {context, worklet, maps, router, engineOutput}
}

// the engine output channels that reach a destination's left and right input
const returnChannels = (engineOutput: FakeNode, destination: FakeNode): Array<Array<number>> => {
    const merger = FakeNode.links.find(link => link.to === destination)!.from
    return [0, 1].map(side => FakeNode.links
        .filter(link => link.from === engineOutput && link.to === merger && link.input === side)
        .map(link => link.output))
}

describe("MonitoringRouter", () => {
    // #575: the strip runs in stereo, a mono source must get both of its sides back
    it("returns both strip channels for a one-channel source", () => {
        const {context, maps, router, engineOutput} = createRouter()
        const source = new FakeNode("source", context)
        const destination = new FakeNode("destination", context)
        const uuid = UUID.generate()
        router.registerSource(uuid, source as unknown as AudioNode, 1, destination as unknown as AudioNode)
        const [entry] = maps.at(-1)!
        expect(entry.channels).toEqual([0, 1])
        expect(returnChannels(engineOutput, destination)).toEqual([[0], [1]])
        const splitter = FakeNode.links.find(link => link.from === source)!.to
        const fed = FakeNode.links.filter(link => link.from === splitter).map(link => [link.output, link.input])
        expect(fed).toEqual([[0, 0], [0, 1]])
    })
    it("keeps a two-channel source on its own two channels", () => {
        const {context, maps, router, engineOutput} = createRouter()
        const mono = new FakeNode("mono", context)
        const stereo = new FakeNode("stereo", context)
        const monoOut = new FakeNode("monoOut", context)
        const stereoOut = new FakeNode("stereoOut", context)
        router.registerSource(UUID.generate(), mono as unknown as AudioNode, 1, monoOut as unknown as AudioNode)
        router.registerSource(UUID.generate(), stereo as unknown as AudioNode, 2, stereoOut as unknown as AudioNode)
        const channels = maps.at(-1)!.map(entry => entry.channels)
        expect(channels.flat().sort()).toEqual([0, 1, 2, 3])
        expect(returnChannels(engineOutput, monoOut).flat().length).toBe(2)
        expect(returnChannels(engineOutput, stereoOut).flat().length).toBe(2)
    })
    it("leaves no connection of a source behind after it is unregistered", () => {
        const {context, router, worklet, engineOutput} = createRouter()
        const source = new FakeNode("source", context)
        const destination = new FakeNode("destination", context)
        const uuid = UUID.generate()
        router.registerSource(uuid, source as unknown as AudioNode, 2, destination as unknown as AudioNode)
        router.registerSource(uuid, source as unknown as AudioNode, 2, destination as unknown as AudioNode)
        expect(FakeNode.links.filter(link => link.from === source).length).toBe(1)
        router.unregisterSource(uuid)
        expect(FakeNode.links.filter(link => link.from === source).length).toBe(0)
        expect(FakeNode.links.filter(link => link.to === destination).length).toBe(0)
        expect(FakeNode.links).toEqual([{from: worklet, to: engineOutput, output: 1, input: 0}])
    })
})
