// Generates test-files/all-boxes.od: a box graph containing ONE instance of every box type, with
// pointers best-effort wired to type-compatible targets. A fully VALID all-types project isn't
// constructible (exclusive/structural rules), so we serialize without endTransaction validation —
// which is fine for the fixture's purpose: exercising every box type's serialization end to end so
// the Rust reader can be golden-tested against real TS bytes for all types.
import { writeFileSync } from "node:fs";
import { isDefined, Option, UUID } from "@opendaw/lib-std";
import { BoxGraph } from "@opendaw/lib-box";
import { BoxIO } from "@opendaw/studio-boxes";
import { ProjectSkeleton } from "../src/project/ProjectSkeleton";
const uuidFor = (index) => {
    const bytes = new Uint8Array(UUID.length);
    bytes[0] = (index >>> 24) & 0xff;
    bytes[1] = (index >>> 16) & 0xff;
    bytes[2] = (index >>> 8) & 0xff;
    bytes[3] = (index + 1) & 0xff;
    bytes[6] = 0x40;
    bytes[8] = 0x80;
    return bytes;
};
const graph = new BoxGraph(Option.wrap(BoxIO.create));
graph.beginTransaction();
BoxIO.names.forEach((name, index) => BoxIO.create(name, graph, uuidFor(index)));
const boxes = graph.boxes();
// Index every vertex (box + nested field) by the pointer types it accepts.
const acceptors = new Map();
const indexAcceptors = (vertex) => {
    vertex.pointerRules.accepts.forEach(type => {
        const list = acceptors.get(type) ?? [];
        list.push(vertex);
        acceptors.set(type, list);
    });
};
const walkFields = (fields, visit) => {
    for (const field of fields) {
        if (field.deprecated) {
            continue;
        } // deprecated fields aren't serialized; never wire to them
        visit(field);
        field.accept({
            visitObjectField: object => walkFields(object.fields(), visit),
            visitArrayField: array => walkFields(array.fields(), visit)
        });
    }
};
boxes.forEach(box => {
    indexAcceptors(box);
    walkFields(box.fields(), indexAcceptors);
});
// Best-effort: wire each pointer field to a compatible, non-self target.
const pointers = [];
boxes.forEach(box => walkFields(box.fields(), field => field.accept({ visitPointerField: pointer => pointers.push(pointer) })));
let wired = 0;
pointers.forEach(pointer => {
    const target = (acceptors.get(pointer.pointerType) ?? [])
        .find(vertex => !vertex.address.equals(pointer.address));
    if (isDefined(target)) {
        pointer.refer(target);
        wired++;
    }
});
// Serialize without endTransaction (validation would reject an all-types graph).
const bytes = ProjectSkeleton.encode(graph);
writeFileSync("../../../test-files/all-boxes.od", new Uint8Array(bytes));
console.debug(`wrote all-boxes.od: ${boxes.length} boxes, ${wired}/${pointers.length} pointers wired`);
