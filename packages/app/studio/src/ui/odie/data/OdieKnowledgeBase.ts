export const KNOWLEDGE_MODULES = {
    'Schema': `
### 🧬 1. The Box Schema (DNA)
OpenDAW is a directed acyclic graph (DAG) of **82 reactive nodes** called "Boxes".
- **Foundation**: RootBox (Entry), TimelineBox (Master), UserInterfaceBox (Layout).
- **Composition**: TrackBox, NoteClipBox (MIDI), NoteEventBox (Atomic Note), AudioRegionBox.
- **Devices (35 types)**: Vaporisateur (Granular), Tape (Lo-Fi), Playfield (Sampler), ModularBox.
- **Automation**: ValueClipBox, ValueEventBox, ValueEventCurveBox.
- **Trace**: NoteEventBox (Pos/Pitch) -> NoteRegionBox -> TrackBox -> AudioUnitBox.
`,
    'API': `
### 🎮 2. The ProjectApi (Gatekeeper)
ALL mutations MUST occur within \`project.editing.modify\` blocks using the \`ProjectApi\`.
- **Track Management**: \`createNoteTrack\`, \`createAudioTrack\`, \`deleteAudioUnit\`.
- **Instrument/FX**: \`createInstrument(factory, opts)\`, \`insertEffect(field, factory, index)\`.
- **Event Mutations**: \`createNoteEvent(params)\`, \`createValueEvent(params)\`.
- **Rules**: Never bypass the API. Always use UUID.generate() for new items.
`,
    'SignalFlow': `
### ⚛️ 3. Engineering & Signal Flow
- **The Trinity**: Box (Data) -> Adapter (Reactive UI/API) -> Processor (Audio Thread DSP).
- **Routing**: AudioUnit -> AuxSendBox -> AudioBusBox (Input -> Output).
- **Sync**: Single Master Clock (PPQN). Sample-accurate SharedArrayBuffer synchronization.
`,
    'Persistence': `
### 💾 4. Project Lifecycle
- **Bundle**: \`.opendaw\` (JSZip) containing \`project.project\` (Binary) and \`/samples\`.
- **Header**: Magic \`0x4F50454E\`, Version \`2\`.
- **Storage**: Origin Private File System (OPFS) for persistent sample access.
`,
    'DocumentationIndex': `
### 📚 5. Documentation Awareness
You (Odie) have extensive manuals available to the user in the Knowledge Base (Graduation Cap Icon).
- **Strategy**: "Free AI" (Round Robin Keys), "Local Models" (Ollama).
- **Features**: "GenUI" (Knobs/Tables), "Academy" (Interactive Lessons).
- **Philosophy**: "No MCP" (Native Bridge), "Artist Passport" (Personalization).
If asked about these topics, refer to your specific training or guide the user to the KB.
`
}

export const ODIE_MOLECULAR_KNOWLEDGE = `
# OpenDAW Constitution [MOLECULAR LEVEL]
**Revision**: Legendary Status (Ratified)
**Source**: 100% Source Code Coverage (Phase 3 Audit)

---
${Object.values(KNOWLEDGE_MODULES).join("\n---\n")}
`
