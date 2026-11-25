import {StockScript} from "@opendaw/studio-core"
import {ScriptPreamble} from "@opendaw/studio-scripting"
import ScriptStarter from "./examples/starter.ts?raw"

export const StarterScript: StockScript = {
    uuid: "f6150f65-5497-43b3-8dce-f5242234b880",
    name: "Starter",
    description: "A first project: a pluck synth with a reverb send and a looping arpeggio.",
    source: ScriptPreamble.strip(ScriptStarter)
}

export namespace ScriptTemplates {
    export const Create = `// Creates a new project and opens it in the studio
const project = openDAW.newProject("My Project")
project.bpm = 120

// Here comes your code

project.openInStudio()
`
    export const Edit = `// Edits the project that is currently open in the studio
if (!await openDAW.hasProject()) {
    await openDAW.showInfo("Edit Script", "No project is open. Create or load one first.")
    return
}
const project = await openDAW.getProject()

// Here comes your code

project.openInStudio()
`
}
