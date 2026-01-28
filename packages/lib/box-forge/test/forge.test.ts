import {beforeEach, describe, expect, it, vi} from "vitest"
import {ByteArrayInput, ByteArrayOutput, Float, Option, UUID} from "@moises-ai/lib-std"
import {Compression} from "@moises-ai/lib-dom"
import {BoxGraph, BoxEditing, PointerField} from "@moises-ai/lib-box"
import {PointerType} from "./Pointers"
import {AudioConnectionBox, BoxIO, DelayBox, DrumBox, NetworkBox} from "./gen"

interface TestScene {
    delay: DelayBox
    drum: DrumBox
    graph: BoxGraph
    network: NetworkBox
}

describe("running tests on forged source code", () => {
    beforeEach<TestScene>((scene: TestScene) => {
        const graph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
        scene.graph = graph
        graph.beginTransaction()
        scene.network = NetworkBox.create(graph, UUID.generate())
        scene.drum = DrumBox.create(graph, UUID.generate())
        scene.delay = DelayBox.create(graph, UUID.generate())
        graph.endTransaction()
    })
    it("random access", () => {
        const id = UUID.generate()
        const graph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
        graph.beginTransaction()
        const box = DrumBox.create(graph, id)
        graph.endTransaction()
        expect(box.address.uuid).toBe(id)
        expect(box.cutoff.getValue()).toBe(18000.0) // init
        expect(box.patterns.getField(3).steps.getField(9).mode.getValue()).toBe(true) // init
        graph.beginTransaction()
        box.cutoff.setValue(Float.toFloat32(Math.PI))
        graph.endTransaction()
        expect(box.cutoff.getValue()).toBe(Float.toFloat32(Math.PI))
        expect(box.patterns.getField(3).steps.getField(9).key.getValue()).toBe(0)
        graph.beginTransaction()
        box.patterns.getField(3).steps.getField(9).key.setValue(7)
        graph.endTransaction()
        expect(box.patterns.getField(3).steps.getField(9).key.getValue()).toBe(7)
    })
    it("connect & delete delay", (scene: TestScene) => {
        const module_added = vi.fn()
        const module_removed = vi.fn()
        const subscription = scene.network.modules.pointerHub.subscribe({
            onAdded: (_pointer: PointerField) => module_added(),
            onRemoved: (_pointer: PointerField) => module_removed()
        }, PointerType.NetworkModule)
        expect(() => scene.graph.edges().validateRequirements()).toThrow()
        scene.graph.beginTransaction()
        scene.drum.network.refer(scene.network.modules)
        scene.delay.network.refer(scene.network.modules)
        scene.graph.endTransaction()
        expect(() => scene.graph.edges().validateRequirements()).not.toThrow()
        scene.graph.beginTransaction()
        const audioConnection = AudioConnectionBox.create(scene.graph, UUID.generate())
        scene.graph.endTransaction()
        expect(() => scene.graph.edges().validateRequirements()).toThrow()
        scene.graph.beginTransaction()
        audioConnection.network.refer(scene.network.connections)
        audioConnection.output.refer(scene.drum.audioOutput)
        audioConnection.input.refer(scene.delay.audioInput)
        scene.graph.endTransaction()
        expect(() => scene.graph.edges().validateRequirements()).not.toThrow()
        expect(Array.from(scene.graph.dependenciesOf(scene.drum).boxes)).toStrictEqual([audioConnection])
        expect(Array.from(scene.graph.dependenciesOf(scene.delay).boxes)).toStrictEqual([audioConnection])
        expect(Array.from(scene.graph.dependenciesOf(scene.network).boxes)).toStrictEqual([scene.drum, audioConnection, scene.delay])
        expect(Array.from(scene.graph.dependenciesOf(audioConnection).boxes)).toStrictEqual([])
        scene.graph.beginTransaction()
        scene.delay.delete()
        scene.graph.endTransaction()
        expect(scene.delay.isAttached()).false
        expect(audioConnection.isAttached()).false
        expect(scene.drum.isAttached()).true
        expect(scene.network.isAttached()).true
        expect(module_added).toBeCalledTimes(2)
        expect(module_removed).toBeCalledTimes(1)
        subscription.terminate()
    })
    it("connect & delete connection", (scene: TestScene) => {
        expect(() => scene.graph.edges().validateRequirements()).toThrow()
        scene.graph.beginTransaction()
        scene.drum.network.refer(scene.network.modules)
        scene.delay.network.refer(scene.network.modules)
        scene.graph.endTransaction()
        expect(() => scene.graph.edges().validateRequirements()).not.toThrow()
        scene.graph.beginTransaction()
        const audioConnection = AudioConnectionBox.create(scene.graph, UUID.generate())
        scene.graph.endTransaction()
        expect(() => scene.graph.edges().validateRequirements()).toThrow()
        scene.graph.beginTransaction()
        audioConnection.network.refer(scene.network.connections)
        audioConnection.output.refer(scene.drum.audioOutput)
        audioConnection.input.refer(scene.delay.audioInput)
        scene.graph.endTransaction()
        expect(() => scene.graph.edges().validateRequirements()).not.toThrow()
        scene.graph.beginTransaction()
        audioConnection.delete()
        scene.graph.endTransaction()
        expect(audioConnection.isAttached()).false
        expect(scene.delay.isAttached()).true
        expect(scene.drum.isAttached()).true
        expect(scene.network.isAttached()).true
    })
    it("editing", (scene: TestScene) => {
        // init
        scene.graph.beginTransaction()
        scene.drum.network.refer(scene.network.modules)
        scene.delay.network.refer(scene.network.modules)
        scene.graph.endTransaction()

        // runtime
        const editing = new BoxEditing(scene.graph)
        const connectionFinder = editing.modify(() => {
            const connectionBox = AudioConnectionBox.create(scene.graph, UUID.generate())
            connectionBox.output.refer(scene.drum.audioOutput)
            connectionBox.input.refer(scene.delay.audioInput)
            connectionBox.network.refer(scene.network.connections)
            return () => scene.graph.findVertex(connectionBox.address).unwrap() as AudioConnectionBox
        }).unwrap()
        expect(connectionFinder().isAttached()).true
        expect(connectionFinder().output.nonEmpty()).true
        expect(connectionFinder().input.nonEmpty()).true

        editing.modify(() => connectionFinder().delete())
        editing.undo()
        expect(connectionFinder().isAttached()).true
        expect(connectionFinder().output.nonEmpty()).true
        expect(connectionFinder().input.nonEmpty()).true
        editing.undo()
        editing.redo()
        expect(connectionFinder().isAttached()).true
        expect(connectionFinder().output.nonEmpty()).true
        expect(connectionFinder().input.nonEmpty()).true
        editing.redo()
        expect(() => connectionFinder()).toThrow()

        editing.modify(() => {
            const connectionBox = AudioConnectionBox.create(scene.graph, UUID.generate())
            connectionBox.output.refer(scene.drum.audioOutput)
            connectionBox.input.refer(scene.delay.audioInput)
            connectionBox.network.refer(scene.network.connections)
            scene.delay.delete()
        })
        editing.undo()
        editing.redo()
    })
})

describe("exclusive constraint tests", () => {
    it("connecting one pointer to exclusive field succeeds", () => {
        const graph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
        graph.beginTransaction()
        const network = NetworkBox.create(graph, UUID.generate())
        const drum = DrumBox.create(graph, UUID.generate())
        const delay = DelayBox.create(graph, UUID.generate())
        drum.network.refer(network.modules)
        delay.network.refer(network.modules)
        const audioConnection = AudioConnectionBox.create(graph, UUID.generate())
        audioConnection.network.refer(network.connections)
        audioConnection.output.refer(drum.audioOutput)
        audioConnection.input.refer(delay.exclusiveInput)
        graph.endTransaction()
        expect(() => graph.edges().validateRequirements()).not.toThrow()
    })
    it("connecting second pointer to exclusive field throws at transaction end", () => {
        const graph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
        graph.beginTransaction()
        const network = NetworkBox.create(graph, UUID.generate())
        const drum1 = DrumBox.create(graph, UUID.generate())
        const drum2 = DrumBox.create(graph, UUID.generate())
        const delay = DelayBox.create(graph, UUID.generate())
        drum1.network.refer(network.modules)
        drum2.network.refer(network.modules)
        delay.network.refer(network.modules)
        const conn1 = AudioConnectionBox.create(graph, UUID.generate())
        conn1.network.refer(network.connections)
        conn1.output.refer(drum1.audioOutput)
        conn1.input.refer(delay.exclusiveInput)
        const conn2 = AudioConnectionBox.create(graph, UUID.generate())
        conn2.network.refer(network.connections)
        conn2.output.refer(drum2.audioOutput)
        conn2.input.refer(delay.exclusiveInput)
        graph.endTransaction()
        expect(() => graph.edges().validateRequirements()).toThrow(/exclusive but has 2 incoming pointers/)
    })
    it("disconnect and reconnect to exclusive field works", () => {
        const graph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
        graph.beginTransaction()
        const network = NetworkBox.create(graph, UUID.generate())
        const drum1 = DrumBox.create(graph, UUID.generate())
        const drum2 = DrumBox.create(graph, UUID.generate())
        const delay = DelayBox.create(graph, UUID.generate())
        drum1.network.refer(network.modules)
        drum2.network.refer(network.modules)
        delay.network.refer(network.modules)
        const conn1 = AudioConnectionBox.create(graph, UUID.generate())
        conn1.network.refer(network.connections)
        conn1.output.refer(drum1.audioOutput)
        conn1.input.refer(delay.exclusiveInput)
        graph.endTransaction()
        expect(() => graph.edges().validateRequirements()).not.toThrow()
        graph.beginTransaction()
        conn1.delete()
        graph.endTransaction()
        graph.beginTransaction()
        const conn2 = AudioConnectionBox.create(graph, UUID.generate())
        conn2.network.refer(network.connections)
        conn2.output.refer(drum2.audioOutput)
        conn2.input.refer(delay.exclusiveInput)
        graph.endTransaction()
        expect(() => graph.edges().validateRequirements()).not.toThrow()
    })
})

describe("running tests on forged source code", () => {
    it("serialization", () => {
        const graph = new BoxGraph()
        graph.beginTransaction()
        const template = DrumBox.create(graph, UUID.generate())
        graph.endTransaction()
        const output = ByteArrayOutput.create()
        graph.beginTransaction()
        template.compressor.setValue(true)
        template.patterns.getField(3).steps.getField(7).key.setValue(42)
        graph.endTransaction()
        template.write(output)

        graph.beginTransaction()
        const recreation = DrumBox.create(graph, UUID.generate())
        recreation.read(new ByteArrayInput(output.toArrayBuffer()))
        graph.endTransaction()
        expect(template.compressor.getValue()).toBe(true)
        expect(template.patterns.getField(3).steps.getField(7).key.getValue()).toBe(42)
    })
    it.skip("serialization compressed", async () => {
        const graph = new BoxGraph()
        graph.beginTransaction()
        const template = DrumBox.create(graph, UUID.generate())
        template.compressor.setValue(true)
        template.patterns.getField(3).steps.getField(7).key.setValue(42)
        graph.endTransaction()
        const output = ByteArrayOutput.create()
        template.write(output)
        const outputBuffer = output.toArrayBuffer() as ArrayBuffer
        const buffer = await Compression.encode(outputBuffer)
        console.debug("compression ratio", `${(buffer.byteLength / outputBuffer.byteLength * 100).toFixed(1)}%`)
        const input = new ByteArrayInput(await Compression.decode(buffer)) // this times out
        graph.beginTransaction()
        const recreation = DrumBox.create(graph, UUID.generate())
        recreation.read(input)
        graph.endTransaction()
        expect(template.compressor.getValue()).toBe(true)
        expect(template.patterns.getField(3).steps.getField(7).key.getValue()).toBe(42)
    })
})