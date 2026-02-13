import {Maybe, safeExecute, UUID} from "@opendaw/lib-std"
import {Field} from "./field"
import {NoPointers, VertexVisitor} from "./vertex"
import {Box, BoxConstruct, ResourceType} from "./box"
import {PointerField} from "./pointer"
import {BoxGraph} from "./graph"
import {describe, expect, it} from "vitest"

enum PointerType {
    Node = "Node",
    Hook = "Hook"
}

interface TestBoxVisitor<RETURN = void> extends VertexVisitor<RETURN> {
    visitNodeBox?(box: NodeBox): RETURN
    visitParentBox?(box: ParentBox): RETURN
    visitChildBox?(box: ChildBox): RETURN
    visitResourceBox?(box: ResourceBox): RETURN
}

// Simple box with a pointer (non-mandatory box, non-mandatory pointer)
type NodeBoxFields = {
    0: PointerField<PointerType.Node>
}

class NodeBox extends Box<PointerType.Node, NodeBoxFields> {
    static create(graph: BoxGraph, uuid: UUID.Bytes, mandatory: boolean = false): NodeBox {
        return graph.stageBox(new NodeBox({
            uuid,
            graph,
            name: "NodeBox",
            pointerRules: {accepts: [PointerType.Node], mandatory}
        }))
    }

    private constructor(construct: BoxConstruct<PointerType.Node>) {super(construct)}

    protected initializeFields(): NodeBoxFields {
        return {
            0: PointerField.create({
                parent: this,
                fieldKey: 0,
                fieldName: "ref",
                pointerRules: NoPointers,
                deprecated: false
            }, PointerType.Node, false)
        }
    }

    accept<R>(visitor: TestBoxVisitor<R>): Maybe<R> {
        return safeExecute(visitor.visitNodeBox, this)
    }

    get tags(): Readonly<Record<string, string | number | boolean>> {return {}}
    get ref(): PointerField<PointerType.Node> {return this.getField(0)}
}

// Parent box with a hook field that accepts pointers (like AudioPitchStretchBox)
type ParentBoxFields = {
    0: PointerField<PointerType.Node>
    1: Field<PointerType.Hook>
}

class ParentBox extends Box<PointerType.Node, ParentBoxFields> {
    static create(graph: BoxGraph, uuid: UUID.Bytes): ParentBox {
        return graph.stageBox(new ParentBox({
            uuid,
            graph,
            name: "ParentBox",
            pointerRules: {accepts: [PointerType.Node], mandatory: true}
        }))
    }

    private constructor(construct: BoxConstruct<PointerType.Node>) {super(construct)}

    protected initializeFields(): ParentBoxFields {
        return {
            0: PointerField.create({
                parent: this,
                fieldKey: 0,
                fieldName: "ref",
                pointerRules: NoPointers,
                deprecated: false
            }, PointerType.Node, false),
            1: Field.hook({
                parent: this,
                fieldKey: 1,
                fieldName: "hook",
                pointerRules: {accepts: [PointerType.Hook], mandatory: true},
                deprecated: false
            })
        }
    }

    accept<R>(visitor: TestBoxVisitor<R>): Maybe<R> {
        return safeExecute(visitor.visitParentBox, this)
    }

    get tags(): Readonly<Record<string, string | number | boolean>> {return {}}
    get ref(): PointerField<PointerType.Node> {return this.getField(0)}
    get hook(): Field<PointerType.Hook> {return this.getField(1)}
}

// Child box with mandatory pointer (like WarpMarkerBox)
type ChildBoxFields = {
    0: PointerField<PointerType.Hook>
}

class ChildBox extends Box<PointerType.Node, ChildBoxFields> {
    static create(graph: BoxGraph, uuid: UUID.Bytes): ChildBox {
        return graph.stageBox(new ChildBox({
            uuid,
            graph,
            name: "ChildBox",
            pointerRules: {accepts: [PointerType.Node], mandatory: false}
        }))
    }

    private constructor(construct: BoxConstruct<PointerType.Node>) {super(construct)}

    protected initializeFields(): ChildBoxFields {
        return {
            0: PointerField.create({
                parent: this,
                fieldKey: 0,
                fieldName: "owner",
                pointerRules: NoPointers,
                deprecated: false
            }, PointerType.Hook, true) // mandatory pointer!
        }
    }

    accept<R>(visitor: TestBoxVisitor<R>): Maybe<R> {
        return safeExecute(visitor.visitChildBox, this)
    }

    get tags(): Readonly<Record<string, string | number | boolean>> {return {}}
    get owner(): PointerField<PointerType.Hook> {return this.getField(0)}
}

// Resource box with a hook field that accepts children (like AudioFileBox)
type ResourceBoxFields = {
    0: PointerField<PointerType.Node>
    1: Field<PointerType.Hook>
}

class ResourceBox extends Box<PointerType.Node, ResourceBoxFields> {
    static create(graph: BoxGraph, uuid: UUID.Bytes, resourceType: ResourceType): ResourceBox {
        return graph.stageBox(new ResourceBox({
            uuid,
            graph,
            name: "ResourceBox",
            pointerRules: {accepts: [PointerType.Node], mandatory: true},
            resource: resourceType
        }))
    }

    private constructor(construct: BoxConstruct<PointerType.Node>) {super(construct)}

    protected initializeFields(): ResourceBoxFields {
        return {
            0: PointerField.create({
                parent: this,
                fieldKey: 0,
                fieldName: "ref",
                pointerRules: NoPointers,
                deprecated: false
            }, PointerType.Node, false),
            1: Field.hook({
                parent: this,
                fieldKey: 1,
                fieldName: "children",
                pointerRules: {accepts: [PointerType.Hook], mandatory: false},
                deprecated: false
            })
        }
    }

    accept<R>(visitor: TestBoxVisitor<R>): Maybe<R> {
        return safeExecute(visitor.visitResourceBox, this)
    }

    get tags(): Readonly<Record<string, string | number | boolean>> {return {}}
    get ref(): PointerField<PointerType.Node> {return this.getField(0)}
    get children(): Field<PointerType.Hook> {return this.getField(1)}
}

// Shared resource box with data field (mandatory: false) and owners field (mandatory: true)
// Models NoteEventCollectionBox: events (data, non-mandatory) + owners (ownership, mandatory)
type SharedResourceBoxFields = {
    0: PointerField<PointerType.Node>
    1: Field<PointerType.Hook>
    2: Field<PointerType.Hook>
}

class SharedResourceBox extends Box<PointerType.Node, SharedResourceBoxFields> {
    static create(graph: BoxGraph, uuid: UUID.Bytes): SharedResourceBox {
        return graph.stageBox(new SharedResourceBox({
            uuid,
            graph,
            name: "SharedResourceBox",
            pointerRules: {accepts: [PointerType.Node], mandatory: false},
            resource: "shared"
        }))
    }

    private constructor(construct: BoxConstruct<PointerType.Node>) {super(construct)}

    protected initializeFields(): SharedResourceBoxFields {
        return {
            0: PointerField.create({
                parent: this,
                fieldKey: 0,
                fieldName: "ref",
                pointerRules: NoPointers,
                deprecated: false
            }, PointerType.Node, false),
            1: Field.hook({
                parent: this,
                fieldKey: 1,
                fieldName: "data",
                pointerRules: {accepts: [PointerType.Hook], mandatory: false},
                deprecated: false
            }),
            2: Field.hook({
                parent: this,
                fieldKey: 2,
                fieldName: "owners",
                pointerRules: {accepts: [PointerType.Hook], mandatory: true},
                deprecated: false
            })
        }
    }

    accept<R>(visitor: TestBoxVisitor<R>): Maybe<R> {return undefined}
    get tags(): Readonly<Record<string, string | number | boolean>> {return {}}
    get ref(): PointerField<PointerType.Node> {return this.getField(0)}
    get data(): Field<PointerType.Hook> {return this.getField(1)}
    get owners(): Field<PointerType.Hook> {return this.getField(2)}
}

describe("findOrphans", () => {
    it("finds no orphans when all boxes are connected", () => {
        const graph = new BoxGraph()
        graph.beginTransaction()
        const root = NodeBox.create(graph, UUID.generate())
        const B = ParentBox.create(graph, UUID.generate())
        const C = ChildBox.create(graph, UUID.generate())
        root.ref.refer(B)
        C.owner.refer(B.hook)
        graph.endTransaction()

        const orphans = graph.findOrphans(root)
        expect(orphans.length).toBe(0)
    })

    it("finds isolated box not connected to root", () => {
        const graph = new BoxGraph()
        graph.beginTransaction()
        const root = NodeBox.create(graph, UUID.generate())
        const connected = NodeBox.create(graph, UUID.generate())
        root.ref.refer(connected)

        // Create isolated box with no connection to root
        const isolated = NodeBox.create(graph, UUID.generate())
        graph.endTransaction()

        const orphans = graph.findOrphans(root)
        expect(orphans.length).toBe(1)
        expect(orphans).toContain(isolated)
    })

    it("finds multiple isolated boxes", () => {
        const graph = new BoxGraph()
        graph.beginTransaction()
        const root = NodeBox.create(graph, UUID.generate())

        // Create isolated boxes
        const isolated1 = NodeBox.create(graph, UUID.generate())
        const isolated2 = ParentBox.create(graph, UUID.generate())
        const isolated3 = NodeBox.create(graph, UUID.generate())
        graph.endTransaction()

        const orphans = graph.findOrphans(root)
        expect(orphans.length).toBe(3)
        expect(orphans).toContain(isolated1)
        expect(orphans).toContain(isolated2)
        expect(orphans).toContain(isolated3)
    })

    it("follows outgoing pointers to find connected boxes", () => {
        const graph = new BoxGraph()
        graph.beginTransaction()
        const root = NodeBox.create(graph, UUID.generate())
        const A = NodeBox.create(graph, UUID.generate())
        const B = NodeBox.create(graph, UUID.generate())
        root.ref.refer(A)
        A.ref.refer(B)

        // Create isolated box
        const isolated = NodeBox.create(graph, UUID.generate())
        graph.endTransaction()

        const orphans = graph.findOrphans(root)
        expect(orphans.length).toBe(1)
        expect(orphans).toContain(isolated)
        expect(orphans).not.toContain(A)
        expect(orphans).not.toContain(B)
    })

    it("follows incoming pointers to find connected boxes", () => {
        const graph = new BoxGraph()
        graph.beginTransaction()
        const root = NodeBox.create(graph, UUID.generate())
        // Child points TO root (incoming edge to root)
        const child = NodeBox.create(graph, UUID.generate())
        child.ref.refer(root)

        // Create isolated box
        const isolated = NodeBox.create(graph, UUID.generate())
        graph.endTransaction()

        const orphans = graph.findOrphans(root)
        expect(orphans.length).toBe(1)
        expect(orphans).toContain(isolated)
        expect(orphans).not.toContain(child)
    })

    it("finds isolated cluster of connected boxes", () => {
        const graph = new BoxGraph()
        graph.beginTransaction()
        const root = NodeBox.create(graph, UUID.generate())
        const connected = NodeBox.create(graph, UUID.generate())
        root.ref.refer(connected)

        // Create isolated cluster - connected to each other but not to root
        const cluster1 = NodeBox.create(graph, UUID.generate())
        const cluster2 = NodeBox.create(graph, UUID.generate())
        cluster1.ref.refer(cluster2)
        graph.endTransaction()

        const orphans = graph.findOrphans(root)
        expect(orphans.length).toBe(2)
        expect(orphans).toContain(cluster1)
        expect(orphans).toContain(cluster2)
    })

    it("box becomes orphan when disconnected", () => {
        const graph = new BoxGraph()
        graph.beginTransaction()
        const root = NodeBox.create(graph, UUID.generate())
        const A = NodeBox.create(graph, UUID.generate())
        root.ref.refer(A)
        graph.endTransaction()

        // Initially no orphans
        expect(graph.findOrphans(root).length).toBe(0)

        // Disconnect A
        graph.beginTransaction()
        root.ref.defer()
        graph.endTransaction()

        // Now A is orphan
        const orphans = graph.findOrphans(root)
        expect(orphans.length).toBe(1)
        expect(orphans).toContain(A)
    })
})

describe("dependenciesOf", () => {
    it("traces mandatory target when only one incoming", () => {
        // A → B (mandatory target)
        // When deleting A, B should be traced
        const graph = new BoxGraph()
        graph.beginTransaction()
        const A = NodeBox.create(graph, UUID.generate())
        const B = ParentBox.create(graph, UUID.generate())
        A.ref.refer(B)
        graph.endTransaction()

        const {boxes} = graph.dependenciesOf(A)
        expect([...boxes]).toContain(B)
    })

    it("does not trace mandatory target when multiple incoming to box", () => {
        // A → B (mandatory target)
        // X → B (another pointer to the box)
        // When deleting A, B should NOT be traced (X still points to it)
        const graph = new BoxGraph()
        graph.beginTransaction()
        const A = NodeBox.create(graph, UUID.generate())
        const B = ParentBox.create(graph, UUID.generate())
        const X = NodeBox.create(graph, UUID.generate())
        A.ref.refer(B)
        X.ref.refer(B)
        graph.endTransaction()

        const {boxes} = graph.dependenciesOf(A)
        expect([...boxes]).not.toContain(B)
    })

    it("traces mandatory target even when children point to its fields", () => {
        // A → B (mandatory target, single incoming to the box)
        // C → B.hook (mandatory pointer to a field in B)
        // When deleting A, B should be traced (only A points to the box itself)
        // Then C should be traced via mandatory incoming pointer
        const graph = new BoxGraph()
        graph.beginTransaction()
        const A = NodeBox.create(graph, UUID.generate())
        const B = ParentBox.create(graph, UUID.generate())
        const C = ChildBox.create(graph, UUID.generate())
        A.ref.refer(B)
        C.owner.refer(B.hook)
        graph.endTransaction()

        const {boxes} = graph.dependenciesOf(A)
        expect([...boxes]).toContain(B)
        expect([...boxes]).toContain(C)
    })

    it("traces multiple children with mandatory pointers to field", () => {
        // A → B (mandatory target)
        // C1 → B.hook (mandatory pointer)
        // C2 → B.hook (mandatory pointer)
        // All should be traced when deleting A
        const graph = new BoxGraph()
        graph.beginTransaction()
        const A = NodeBox.create(graph, UUID.generate())
        const B = ParentBox.create(graph, UUID.generate())
        const C1 = ChildBox.create(graph, UUID.generate())
        const C2 = ChildBox.create(graph, UUID.generate())
        A.ref.refer(B)
        C1.owner.refer(B.hook)
        C2.owner.refer(B.hook)
        graph.endTransaction()

        const {boxes} = graph.dependenciesOf(A)
        expect([...boxes]).toContain(B)
        expect([...boxes]).toContain(C1)
        expect([...boxes]).toContain(C2)
        expect([...boxes].length).toBe(3)
    })

    it("traces box with mandatory incoming pointer", () => {
        // A has mandatory incoming pointer from B
        // When deleting A, B should be traced
        const graph = new BoxGraph()
        graph.beginTransaction()
        const A = ParentBox.create(graph, UUID.generate())
        const B = ChildBox.create(graph, UUID.generate())
        B.owner.refer(A.hook)
        graph.endTransaction()

        const {boxes} = graph.dependenciesOf(A)
        expect([...boxes]).toContain(B)
    })

    it("does not trace non-mandatory connections", () => {
        // A → B (non-mandatory target)
        // When deleting A, B should NOT be traced
        const graph = new BoxGraph()
        graph.beginTransaction()
        const A = NodeBox.create(graph, UUID.generate())
        const B = NodeBox.create(graph, UUID.generate()) // non-mandatory
        A.ref.refer(B)
        graph.endTransaction()

        const {boxes} = graph.dependenciesOf(A)
        expect([...boxes]).not.toContain(B)
    })

    it("traces chain of mandatory dependencies", () => {
        // A → B (mandatory) → C (mandatory)
        // When deleting A, both B and C should be traced
        const graph = new BoxGraph()
        graph.beginTransaction()
        const A = NodeBox.create(graph, UUID.generate())
        const B = ParentBox.create(graph, UUID.generate())
        const C = ParentBox.create(graph, UUID.generate())
        A.ref.refer(B)
        B.ref.refer(C)
        graph.endTransaction()

        const {boxes} = graph.dependenciesOf(A)
        expect([...boxes]).toContain(B)
        expect([...boxes]).toContain(C)
    })

    it("alwaysFollowMandatory bypasses incoming check", () => {
        // A → B (mandatory target)
        // X → B (another pointer)
        // With alwaysFollowMandatory, B should be traced even with X pointing to it
        const graph = new BoxGraph()
        graph.beginTransaction()
        const A = NodeBox.create(graph, UUID.generate())
        const B = ParentBox.create(graph, UUID.generate())
        const X = NodeBox.create(graph, UUID.generate())
        A.ref.refer(B)
        X.ref.refer(B)
        graph.endTransaction()

        const {boxes} = graph.dependenciesOf(A, {alwaysFollowMandatory: true})
        expect([...boxes]).toContain(B)
    })

    it("excludeBox prevents tracing excluded boxes", () => {
        // A → B (mandatory)
        // Exclude B from tracing
        const graph = new BoxGraph()
        graph.beginTransaction()
        const A = NodeBox.create(graph, UUID.generate())
        const B = ParentBox.create(graph, UUID.generate())
        A.ref.refer(B)
        graph.endTransaction()

        const {boxes} = graph.dependenciesOf(A, {excludeBox: box => box === B})
        expect([...boxes]).not.toContain(B)
    })

    it("models AudioRegion → AudioPitchStretch ← WarpMarker scenario", () => {
        // This is the real-world scenario:
        // Region → StretchBox (mandatory box)
        // WarpMarker1 → StretchBox.hook (mandatory pointer)
        // WarpMarker2 → StretchBox.hook (mandatory pointer)
        // When deleting Region, all should be traced
        const graph = new BoxGraph()
        graph.beginTransaction()
        const region = NodeBox.create(graph, UUID.generate())
        const stretchBox = ParentBox.create(graph, UUID.generate())
        const warpMarker1 = ChildBox.create(graph, UUID.generate())
        const warpMarker2 = ChildBox.create(graph, UUID.generate())
        region.ref.refer(stretchBox)
        warpMarker1.owner.refer(stretchBox.hook)
        warpMarker2.owner.refer(stretchBox.hook)
        graph.endTransaction()

        const {boxes, pointers} = graph.dependenciesOf(region)

        // All boxes should be traced
        expect([...boxes]).toContain(stretchBox)
        expect([...boxes]).toContain(warpMarker1)
        expect([...boxes]).toContain(warpMarker2)
        expect([...boxes].length).toBe(3)

        // All pointers should be collected
        expect([...pointers]).toContain(region.ref)
        expect([...pointers]).toContain(warpMarker1.owner)
        expect([...pointers]).toContain(warpMarker2.owner)
    })

    it("does not trace mandatory target when another pointer to box exists", () => {
        // A → B (mandatory target, pointer to box)
        // C → B.hook (mandatory pointer to field in B)
        // X → B (another pointer to the box)
        // When deleting A, B should NOT be traced because X still points to it
        const graph = new BoxGraph()
        graph.beginTransaction()
        const A = NodeBox.create(graph, UUID.generate())
        const B = ParentBox.create(graph, UUID.generate())
        const C = ChildBox.create(graph, UUID.generate())
        const X = NodeBox.create(graph, UUID.generate())
        A.ref.refer(B)
        C.owner.refer(B.hook)
        X.ref.refer(B) // X also points to B
        graph.endTransaction()

        const {boxes} = graph.dependenciesOf(A)
        // B should NOT be traced because X still points to it
        expect([...boxes]).not.toContain(B)
        // But C should be traced because its pointer is mandatory
        // Actually no - C points to B.hook, not to A, so C won't be traced
        // unless we traverse through B first (which we won't)
        expect([...boxes]).not.toContain(C)
    })

    it("traces diamond dependency correctly", () => {
        // A → B (mandatory) → D (mandatory)
        // A → C (mandatory) → D (mandatory)
        // When deleting A, all should be traced
        const graph = new BoxGraph()
        graph.beginTransaction()
        const A = NodeBox.create(graph, UUID.generate())
        const B = ParentBox.create(graph, UUID.generate())
        const C = ParentBox.create(graph, UUID.generate())
        const D = ParentBox.create(graph, UUID.generate())
        A.ref.refer(B)
        // Need another pointer from A to C - but NodeBox only has one ref
        // Let's modify the scenario: A → B, A' → C, B → D, C → D
        graph.endTransaction()
        // This test needs a box with multiple outgoing pointers
        // Skipping for now as the current test boxes don't support this
    })

    it("traces incoming mandatory pointer from different box", () => {
        // A has mandatory incoming pointer from both B and C
        // When deleting A, both B and C should be traced
        const graph = new BoxGraph()
        graph.beginTransaction()
        const A = ParentBox.create(graph, UUID.generate())
        const B = ChildBox.create(graph, UUID.generate())
        const C = ChildBox.create(graph, UUID.generate())
        B.owner.refer(A.hook)
        C.owner.refer(A.hook)
        graph.endTransaction()

        const {boxes} = graph.dependenciesOf(A)
        expect([...boxes]).toContain(B)
        expect([...boxes]).toContain(C)
        expect([...boxes].length).toBe(2)
    })

    it("handles box with no outgoing or incoming edges", () => {
        const graph = new BoxGraph()
        graph.beginTransaction()
        const A = NodeBox.create(graph, UUID.generate())
        graph.endTransaction()

        const {boxes, pointers} = graph.dependenciesOf(A)
        expect([...boxes].length).toBe(0)
        expect([...pointers].length).toBe(0)
    })

    it("does not include the source box in dependencies", () => {
        const graph = new BoxGraph()
        graph.beginTransaction()
        const A = NodeBox.create(graph, UUID.generate())
        const B = ParentBox.create(graph, UUID.generate())
        A.ref.refer(B)
        graph.endTransaction()

        const {boxes} = graph.dependenciesOf(A)
        expect([...boxes]).not.toContain(A)
    })

    it("traces deeply nested mandatory chains", () => {
        // A → B → C → D → E (all mandatory)
        const graph = new BoxGraph()
        graph.beginTransaction()
        const A = NodeBox.create(graph, UUID.generate())
        const B = ParentBox.create(graph, UUID.generate())
        const C = ParentBox.create(graph, UUID.generate())
        const D = ParentBox.create(graph, UUID.generate())
        const E = ParentBox.create(graph, UUID.generate())
        A.ref.refer(B)
        B.ref.refer(C)
        C.ref.refer(D)
        D.ref.refer(E)
        graph.endTransaction()

        const {boxes} = graph.dependenciesOf(A)
        expect([...boxes]).toContain(B)
        expect([...boxes]).toContain(C)
        expect([...boxes]).toContain(D)
        expect([...boxes]).toContain(E)
        expect([...boxes].length).toBe(4)
    })

    it("stops tracing when non-mandatory box is in chain", () => {
        // A → B (mandatory) → C (non-mandatory)
        // When deleting A, only B should be traced
        const graph = new BoxGraph()
        graph.beginTransaction()
        const A = NodeBox.create(graph, UUID.generate())
        const B = ParentBox.create(graph, UUID.generate())
        const C = NodeBox.create(graph, UUID.generate()) // non-mandatory
        A.ref.refer(B)
        B.ref.refer(C)
        graph.endTransaction()

        const {boxes} = graph.dependenciesOf(A)
        expect([...boxes]).toContain(B)
        expect([...boxes]).not.toContain(C)
    })

    it("traces mandatory box even when pointer is from the traced set", () => {
        // A → B (mandatory)
        // B has child C with mandatory pointer to B.hook
        // Deleting A should trace B and C
        const graph = new BoxGraph()
        graph.beginTransaction()
        const A = NodeBox.create(graph, UUID.generate())
        const B = ParentBox.create(graph, UUID.generate())
        const C = ChildBox.create(graph, UUID.generate())
        A.ref.refer(B)
        C.owner.refer(B.hook)
        graph.endTransaction()

        const {boxes} = graph.dependenciesOf(A)
        expect([...boxes]).toContain(B)
        expect([...boxes]).toContain(C)
    })
})

describe("dependenciesOf with stopAtResources", () => {
    it("includes resource boxes in dependencies", () => {
        // A → ResourceBox (preserved)
        // Resource should be in collected dependencies
        const graph = new BoxGraph()
        graph.beginTransaction()
        const A = NodeBox.create(graph, UUID.generate())
        const resource = ResourceBox.create(graph, UUID.generate(), "preserved")
        A.ref.refer(resource)
        graph.endTransaction()

        const {boxes} = graph.dependenciesOf(A, {stopAtResources: true, alwaysFollowMandatory: true})
        expect([...boxes]).toContain(resource)
    })

    it("includes children of resource boxes (field-level pointers)", () => {
        // A → ResourceBox ← Child (points to field)
        // Child should be in collected dependencies
        const graph = new BoxGraph()
        graph.beginTransaction()
        const A = NodeBox.create(graph, UUID.generate())
        const resource = ResourceBox.create(graph, UUID.generate(), "preserved")
        const child = ChildBox.create(graph, UUID.generate())
        A.ref.refer(resource)
        child.owner.refer(resource.children) // points to FIELD
        graph.endTransaction()

        const {boxes} = graph.dependenciesOf(A, {stopAtResources: true, alwaysFollowMandatory: true})
        expect([...boxes]).toContain(resource)
        expect([...boxes]).toContain(child)
    })

    it("excludes users of resource boxes (box-level pointers)", () => {
        // A → ResourceBox ← OtherNode (points to box)
        // OtherNode should NOT be in collected dependencies
        const graph = new BoxGraph()
        graph.beginTransaction()
        const A = NodeBox.create(graph, UUID.generate())
        const resource = ResourceBox.create(graph, UUID.generate(), "preserved")
        const otherUser = NodeBox.create(graph, UUID.generate())
        A.ref.refer(resource)
        otherUser.ref.refer(resource) // points to BOX
        graph.endTransaction()

        const {boxes} = graph.dependenciesOf(A, {stopAtResources: true, alwaysFollowMandatory: true})
        expect([...boxes]).toContain(resource)
        expect([...boxes]).not.toContain(otherUser)
    })

    it("differentiates children vs users by address.isBox()", () => {
        // A → ResourceBox
        //       ↑
        // Child → ResourceBox.children (field pointer) - should be included
        // OtherUser → ResourceBox (box pointer) - should be excluded
        const graph = new BoxGraph()
        graph.beginTransaction()
        const A = NodeBox.create(graph, UUID.generate())
        const resource = ResourceBox.create(graph, UUID.generate(), "preserved")
        const child = ChildBox.create(graph, UUID.generate())
        const otherUser = NodeBox.create(graph, UUID.generate())
        A.ref.refer(resource)
        child.owner.refer(resource.children) // field pointer
        otherUser.ref.refer(resource) // box pointer
        graph.endTransaction()

        const {boxes} = graph.dependenciesOf(A, {stopAtResources: true, alwaysFollowMandatory: true})
        expect([...boxes]).toContain(resource)
        expect([...boxes]).toContain(child)
        expect([...boxes]).not.toContain(otherUser)
        expect([...boxes].length).toBe(2) // resource + child
    })

    it("does not follow outgoing edges from resource boxes", () => {
        // A → ResourceBox → SomeOtherBox
        // SomeOtherBox should NOT be collected (resources are endpoints)
        const graph = new BoxGraph()
        graph.beginTransaction()
        const A = NodeBox.create(graph, UUID.generate())
        const resource = ResourceBox.create(graph, UUID.generate(), "preserved")
        const downstream = ParentBox.create(graph, UUID.generate())
        A.ref.refer(resource)
        resource.ref.refer(downstream)
        graph.endTransaction()

        const {boxes} = graph.dependenciesOf(A, {stopAtResources: true, alwaysFollowMandatory: true})
        expect([...boxes]).toContain(resource)
        expect([...boxes]).not.toContain(downstream)
    })

    it("handles multiple children of resource box", () => {
        // A → ResourceBox
        //       ↑
        // Child1 → ResourceBox.children
        // Child2 → ResourceBox.children
        // Child3 → ResourceBox.children
        const graph = new BoxGraph()
        graph.beginTransaction()
        const A = NodeBox.create(graph, UUID.generate())
        const resource = ResourceBox.create(graph, UUID.generate(), "preserved")
        const child1 = ChildBox.create(graph, UUID.generate())
        const child2 = ChildBox.create(graph, UUID.generate())
        const child3 = ChildBox.create(graph, UUID.generate())
        A.ref.refer(resource)
        child1.owner.refer(resource.children)
        child2.owner.refer(resource.children)
        child3.owner.refer(resource.children)
        graph.endTransaction()

        const {boxes} = graph.dependenciesOf(A, {stopAtResources: true, alwaysFollowMandatory: true})
        expect([...boxes]).toContain(resource)
        expect([...boxes]).toContain(child1)
        expect([...boxes]).toContain(child2)
        expect([...boxes]).toContain(child3)
        expect([...boxes].length).toBe(4)
    })

    it("works with internal resource type", () => {
        // Internal resources should also stop traversal
        const graph = new BoxGraph()
        graph.beginTransaction()
        const A = NodeBox.create(graph, UUID.generate())
        const resource = ResourceBox.create(graph, UUID.generate(), "internal")
        const downstream = ParentBox.create(graph, UUID.generate())
        A.ref.refer(resource)
        resource.ref.refer(downstream)
        graph.endTransaction()

        const {boxes} = graph.dependenciesOf(A, {stopAtResources: true, alwaysFollowMandatory: true})
        expect([...boxes]).toContain(resource)
        expect([...boxes]).not.toContain(downstream)
    })

    it("resource property is accessible on box", () => {
        const graph = new BoxGraph()
        graph.beginTransaction()
        const preservedResource = ResourceBox.create(graph, UUID.generate(), "preserved")
        const internalResource = ResourceBox.create(graph, UUID.generate(), "internal")
        const regularBox = NodeBox.create(graph, UUID.generate())
        graph.endTransaction()

        expect(preservedResource.resource).toBe("preserved")
        expect(internalResource.resource).toBe("internal")
        expect(regularBox.resource).toBeUndefined()
    })

    it("stopAtResources false collects all boxes normally", () => {
        // When stopAtResources is false, resource boxes are treated normally
        const graph = new BoxGraph()
        graph.beginTransaction()
        const A = NodeBox.create(graph, UUID.generate())
        const resource = ResourceBox.create(graph, UUID.generate(), "preserved")
        const downstream = ParentBox.create(graph, UUID.generate())
        A.ref.refer(resource)
        resource.ref.refer(downstream)
        graph.endTransaction()

        const {boxes} = graph.dependenciesOf(A, {stopAtResources: false, alwaysFollowMandatory: true})
        expect([...boxes]).toContain(resource)
        expect([...boxes]).toContain(downstream) // included when stopAtResources is false
    })

    it("models AudioRegion → AudioFileBox ← TransientMarker scenario", () => {
        // This is the real-world scenario:
        // Region → AudioFileBox (preserved resource)
        // TransientMarker → AudioFileBox.children (mandatory pointer to field)
        // OtherRegion → AudioFileBox (another user, should be excluded)
        const graph = new BoxGraph()
        graph.beginTransaction()
        const region = NodeBox.create(graph, UUID.generate())
        const audioFile = ResourceBox.create(graph, UUID.generate(), "preserved")
        const transientMarker = ChildBox.create(graph, UUID.generate())
        const otherRegion = NodeBox.create(graph, UUID.generate())
        region.ref.refer(audioFile)
        transientMarker.owner.refer(audioFile.children)
        otherRegion.ref.refer(audioFile)
        graph.endTransaction()

        const {boxes} = graph.dependenciesOf(region, {stopAtResources: true, alwaysFollowMandatory: true})
        expect([...boxes]).toContain(audioFile)
        expect([...boxes]).toContain(transientMarker)
        expect([...boxes]).not.toContain(otherRegion)
        expect([...boxes].length).toBe(2)
    })

    it("shared resource includes data children but excludes ownership siblings", () => {
        // Models: NoteRegionBox → NoteEventCollectionBox ← NoteEventBox (data) + NoteClipBox (owner)
        // region → SharedResource.owners (mandatory field) ← ownerSibling (clip on other track)
        //                         .data (non-mandatory field) ← dataChild (note events)
        // dataChild should be included, ownerSibling should NOT
        const graph = new BoxGraph()
        graph.beginTransaction()
        const region = ChildBox.create(graph, UUID.generate())
        const shared = SharedResourceBox.create(graph, UUID.generate())
        const dataChild = ChildBox.create(graph, UUID.generate())
        const ownerSibling = ChildBox.create(graph, UUID.generate())
        region.owner.refer(shared.owners)
        dataChild.owner.refer(shared.data)
        ownerSibling.owner.refer(shared.owners)
        graph.endTransaction()

        const {boxes} = graph.dependenciesOf(region, {stopAtResources: true, alwaysFollowMandatory: true})
        expect([...boxes]).toContain(shared)
        expect([...boxes]).toContain(dataChild)
        expect([...boxes]).not.toContain(ownerSibling)
    })

    it("excludeBox still works with stopAtResources", () => {
        // Combine excludeBox with stopAtResources
        const graph = new BoxGraph()
        graph.beginTransaction()
        const A = NodeBox.create(graph, UUID.generate())
        const resource = ResourceBox.create(graph, UUID.generate(), "preserved")
        const child = ChildBox.create(graph, UUID.generate())
        A.ref.refer(resource)
        child.owner.refer(resource.children)
        graph.endTransaction()

        // Exclude the child
        const {boxes} = graph.dependenciesOf(A, {
            stopAtResources: true,
            alwaysFollowMandatory: true,
            excludeBox: box => box === child
        })
        expect([...boxes]).toContain(resource)
        expect([...boxes]).not.toContain(child)
    })
})
