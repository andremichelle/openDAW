// Cursor-aware value-event placement decision for issue #275. Pure and dependency-free so it is unit-testable.
// Two value events may share one time position: index 0 is the INCOMING value (left of the resulting vertical step),
// index 1 is the OUTGOING value (right). `Side` is the half of the node the cursor is on (left = incoming, right =
// outgoing); it selects which member of a same-time pair a double-click affects.
export namespace ValueEventPlacement {
    export type Side = "incoming" | "outgoing"
    export type Result = "create" | "add-incoming" | "add-outgoing" | "overwrite-incoming" | "overwrite-outgoing"

    // `hasIncoming` / `hasOutgoing` report whether an index-0 / index-1 event already sits at the target time.
    export const resolve = (hasIncoming: boolean, hasOutgoing: boolean, side: Side): Result => {
        if (hasIncoming && hasOutgoing) {return side === "incoming" ? "overwrite-incoming" : "overwrite-outgoing"}
        if (hasIncoming) {return side === "incoming" ? "add-incoming" : "add-outgoing"}
        if (hasOutgoing) {return "overwrite-outgoing"} // defensive: a lone outgoing (index 1) — just move it
        return "create"
    }
}
