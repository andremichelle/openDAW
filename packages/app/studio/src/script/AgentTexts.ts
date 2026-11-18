export type AgentTool = {
    readonly name: string
    readonly description: string
    readonly inputSchema: Readonly<Record<string, unknown>>
}

export namespace AgentTexts {
    export const Instructions: string = [
        "You write scripts for the openDAW studio the user has open.",
        "Work in the project the user has open (openDAW.getProject()). Create a new project only when the user asks for one.",
        "Do not compose or generate music unless the user explicitly asks for it. Your job is restructuring and editing what is already there.",
        "When the user asks you to compose, do what they asked and nothing more. Do not propose musical next steps or additions (like \"add drums\" or \"want a bassline?\"), the musical ideas have to come from the user.",
        "Call begin_task with a short title before your first other openDAW tool call for a request, and end_task when you are done or give up.",
        "If a call answers that the user cancelled, stop working on the request and report what you did so far.",
        "When the user asks for a new project, give it a fitting name: openDAW.newProject(\"Drum Bus Setup\").",
        "End every script that changes the project with project.openInStudio(), the user wants to see and hear the result in the studio.",
        "When the user refers to \"this\", \"the selected\" or \"the open\" device, region or notes, call get_context first and edit the current project (openDAW.getProject()).",
        "Ask the user for approval in the chat before any script calls openDAW.addSample, it adds samples to the user's library."
    ].join("\n")

    export const Tools: ReadonlyArray<AgentTool> = [
        {
            name: "get_api",
            description: "Returns one part of the openDAW scripting API (TypeScript declarations), part 1 starts with the rules for working with openDAW. " +
                "Read ALL parts, starting with part 1, before writing the first script. The result names the number of parts.",
            inputSchema: {type: "object", properties: {part: {type: "integer", minimum: 1}}, required: ["part"]}
        },
        {
            name: "run_script",
            description: "Runs JavaScript (not TypeScript) in the connected openDAW studio. " +
                "Globals: openDAW (the scripting API), sampleRate, baseFrequency, AudioData, WavFile, midiToHz, PPQN, FFT, " +
                "Chord, Interpolation, dbToGain, gainToDb, ClassicWaveform, VoicingMode, Mixing, TransientPlayMode, " +
                "AudioSendRouting. Top level await and return are allowed. Returns the script's return value (plain data, as JSON), " +
                "\"ok\" when it returns nothing, or the error message. Dialogs wait for a person in the studio, pass values directly instead.",
            inputSchema: {type: "object", properties: {code: {type: "string"}}, required: ["code"]}
        },
        {
            name: "begin_task",
            description: "Tells the studio you start working on a request. The studio shows a dialog with the title, " +
                "elapsed time and number of calls, and collects all changes into one undo step.",
            inputSchema: {type: "object", properties: {title: {type: "string"}}, required: ["title"]}
        },
        {
            name: "end_task",
            description: "Tells the studio you finished the request (or gave up). Closes the dialog.",
            inputSchema: {type: "object", properties: {}}
        },
        {
            name: "get_context",
            description: "Returns what the user focuses in the studio right now: project name, the device being edited " +
                "(editingDevice), the region open in the editor (editingRegion), the selected objects (selection), " +
                "playhead and loop range (in PPQN, a quarter note is 960). Objects come as {type, uuid}, " +
                "resolve them in a script with (await openDAW.getProject()).findByUuid(uuid).",
            inputSchema: {type: "object", properties: {}}
        }
    ]

    const PartSize = 48_000

    const splitAtBlankLines = (text: string): ReadonlyArray<string> => {
        const parts: Array<string> = []
        let rest = text
        while (rest.length > PartSize) {
            const cut = rest.lastIndexOf("\n\n", PartSize)
            const index = cut > 0 ? cut : PartSize
            parts.push(rest.slice(0, index))
            rest = rest.slice(index)
        }
        parts.push(rest)
        return parts
    }

    export const apiParts = (texts: ReadonlyArray<string>): ReadonlyArray<string> => {
        const parts = texts.flatMap(splitAtBlankLines)
        return parts.map((part, index) => index === 0 ? `Rules:\n${Instructions}\n\n${part}` : part)
    }
}
