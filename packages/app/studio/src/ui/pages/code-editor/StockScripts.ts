import {StockScript} from "@opendaw/studio-core"
import ScriptStarter from "./examples/starter.ts?raw"
import ScriptAudioRegion from "./examples/create-sample.ts?raw"
import ScriptNanoWavetable from "./examples/nano-wavetable.ts?raw"
import ScriptAcid from "./examples/acid.ts?raw"
import ScriptInventory from "./examples/inventory.ts?raw"
import ScriptCleanup from "./examples/cleanup.ts?raw"

const truncateImports = (script: string) => script.substring(script.indexOf("//"))

export const StarterScript: StockScript = {
    uuid: "f6150f65-5497-43b3-8dce-f5242234b880",
    name: "Starter",
    description: "A first project: a pluck synth with a reverb send and a looping arpeggio.",
    source: truncateImports(ScriptStarter)
}

export const StockScripts: ReadonlyArray<StockScript> = [
    StarterScript,
    {
        uuid: "78d3a837-1fac-40e2-9358-922e7b87dbb0",
        name: "Audio Region",
        description: "Generates a chirp, imports it as a sample and places it on an audio track.",
        source: truncateImports(ScriptAudioRegion)
    },
    {
        uuid: "18a788e6-702e-4808-8acb-e09c3f26be11",
        name: "Nano Wavetable",
        description: "Builds a PADsynth wavetable and plays it with the Nano instrument.",
        source: truncateImports(ScriptNanoWavetable)
    },
    {
        uuid: "80bd7951-efee-49d0-9d97-b6375a7f199b",
        name: "Acid",
        description: "A seeded 303 line with Euclidean 808/909 drums, laid out as a 64-cycle arrangement.",
        source: truncateImports(ScriptAcid)
    },
    {
        uuid: "b49e84c5-b1f5-40e5-baeb-c6e532ccd7e7",
        name: "Inventory",
        description: "Counts everything in the current project and shows the result in a dialog.",
        source: truncateImports(ScriptInventory)
    },
    {
        uuid: "6db46548-aa86-40ea-b53d-e823442adcfb",
        name: "Cleanup",
        description: "Removes empty tracks, muted content, regions beyond the end and unused aux units.",
        source: truncateImports(ScriptCleanup)
    }
]

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
