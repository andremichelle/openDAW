import {BoxGraph, StringField} from "@opendaw/lib-box"
import {BoxIO, NoteClipBox, NoteRegionBox, ValueClipBox, ValueRegionBox} from "@opendaw/studio-boxes"

// Note and value regions/clips used to be created with a hard-coded "Notes" / "Automation" label. Both are now
// created without a label: notes render nothing and automation renders its parameter name, composed at draw time.
// The stored defaults would read as user-chosen names ("Feedback · Automation"), so they are cleared.
const DefaultLabels = {note: "Notes", value: "Automation"} as const

export const migrateDefaultLabels = (boxGraph: BoxGraph<BoxIO.TypeMap>): void => {
    const cleared: Array<StringField> = []
    for (const box of boxGraph.boxes()) {
        if (box instanceof NoteRegionBox || box instanceof NoteClipBox) {
            if (box.label.getValue() === DefaultLabels.note) {cleared.push(box.label)}
        } else if (box instanceof ValueRegionBox || box instanceof ValueClipBox) {
            if (box.label.getValue() === DefaultLabels.value) {cleared.push(box.label)}
        }
    }
    if (cleared.length === 0) {return}
    console.debug(`Migrate clear ${cleared.length} default region/clip label(s)`)
    boxGraph.beginTransaction()
    cleared.forEach(field => field.setValue(""))
    boxGraph.endTransaction()
}
