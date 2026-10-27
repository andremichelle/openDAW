import {describe, expect, it} from "vitest"
import {ParameterTree, WclapParameterTree} from "./WclapParameterTree"

// Renders a tree as nested label lists for readable assertions: groups as [label, children], items as labels
type Shape = Array<string | [string, Shape]>
const shape = (tree: ParameterTree<string>): Shape => [
    ...tree.groups.map(({label, tree: child}): [string, Shape] => [label, shape(child)]),
    ...tree.items.map(({label}) => label)
]

const flat = (...names: Array<string>) => names.map(name => ({module: "", name, value: name}))

describe("WclapParameterTree", () => {
    it("keeps names without shared beginnings flat", () => {
        expect(shape(WclapParameterTree.build(flat("mix", "depth", "detune")))).toStrictEqual(["mix", "depth", "detune"])
    })

    it("groups names by a shared first word and shows the rest", () => {
        expect(shape(WclapParameterTree.build(flat("dry", "low cut", "low damp", "high cut", "high damp"))))
            .toStrictEqual([["low", ["cut", "damp"]], ["high", ["cut", "damp"]], "dry"])
    })

    it("joins a chain of single shared words into one group", () => {
        expect(shape(WclapParameterTree.build(flat("Osc A Wave", "Osc A Level", "Osc A Tune"))))
            .toStrictEqual([["Osc A", ["Wave", "Level", "Tune"]]])
    })

    it("nests deeper where the beginnings split again", () => {
        expect(shape(WclapParameterTree.build(flat("Osc A Wave", "Osc A Level", "Osc B Wave", "Osc B Level", "Volume"))))
            .toStrictEqual([["Osc", [["A", ["Wave", "Level"]], ["B", ["Wave", "Level"]]]], "Volume"])
    })

    it("makes no group for a beginning only one name has", () => {
        expect(shape(WclapParameterTree.build(flat("Filter Cutoff", "Filter Resonance", "Noise Level"))))
            .toStrictEqual([["Filter", ["Cutoff", "Resonance"]], "Noise Level"])
    })

    it("keeps a name that equals a group's beginning inside that group", () => {
        expect(shape(WclapParameterTree.build(flat("Osc A", "Osc A Wave", "Osc A Level"))))
            .toStrictEqual([["Osc A", ["Osc A", "Wave", "Level"]]])
    })

    it("nests by module path first, then by shared beginnings inside each module", () => {
        const tree = WclapParameterTree.build([
            {module: "osc/a", name: "Wave Shape", value: "a-shape"},
            {module: "osc/a", name: "Wave Mix", value: "a-mix"},
            {module: "osc/b", name: "Level", value: "b-level"},
            {module: "", name: "Volume", value: "volume"}
        ])
        expect(shape(tree)).toStrictEqual([["osc", [["a", [["Wave", ["Shape", "Mix"]]]], ["b", ["Level"]]]], "Volume"])
    })

    it("drops a module's own label from the start of its parameter names", () => {
        const tree = WclapParameterTree.build([
            {module: "Op 1 to Op 2", name: "Op 1 to Op 2 Active", value: "active"},
            {module: "Op 1 to Op 2", name: "Op 1 to Op 2 Depth", value: "depth"},
            {module: "Op 1 to Op 2", name: "Op 1 to Op 2 Is Enveloped", value: "enveloped"},
            {module: "Op 1 to Op 2", name: "Op 1 to Op 2 Is OneShot", value: "oneshot"},
            {module: "Op 1 to Op 2", name: "Op 1 to Op 2", value: "self"},
            {module: "Op 1 to Op 3", name: "Op 1 to Op 30 Level", value: "partial"}
        ])
        expect(shape(tree)).toStrictEqual([
            ["Op 1 to Op 2", [["Is", ["Enveloped", "OneShot"]], "Active", "Depth", "Op 1 to Op 2"]],
            ["Op 1 to Op 3", ["Op 1 to Op 30 Level"]]
        ])
    })

    it("strips the label per path level", () => {
        const tree = WclapParameterTree.build([
            {module: "Osc/A", name: "A Wave", value: "wave"},
            {module: "Osc/A", name: "A Level", value: "level"}
        ])
        expect(shape(tree)).toStrictEqual([["Osc", [["A", ["Wave", "Level"]]]]])
    })

    it("keeps every value reachable exactly once", () => {
        const names = ["Osc A", "Osc A Wave", "Osc B Wave", "low cut", "dry", "Filter Cutoff", "Filter Env Amount"]
        const collect = (tree: ParameterTree<string>): Array<string> =>
            [...tree.groups.flatMap(({tree: child}) => collect(child)), ...tree.items.map(({value}) => value)]
        expect(collect(WclapParameterTree.build(flat(...names))).toSorted()).toStrictEqual(names.toSorted())
    })
})
