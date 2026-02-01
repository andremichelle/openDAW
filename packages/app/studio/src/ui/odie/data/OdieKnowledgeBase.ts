export const KNOWLEDGE_MODULES = {
    'Schema': `
### 🧬 1. The Functional Schema (Common Sense)
OpenDAW uses native devices for specific musical roles. You MUST map user intents to these native tools.

**Instruments (WHAT & WHY):**
- **Playfield**: The Drum Engine. Use for "drums", "sample pads", "percussion", "one-shots".
- **Nano**: Classic Subtractive Synth. Use for "bass", "leads", "synth sounds", "analog warmth".
- **Soundfont**: General MIDI Sample Player. Use for "piano", "orchestral", "strings", "realistic".
- **Vaporisateur**: Granular Engine. Use for "ambient", "texture", "granular sound design".
- **Tape**: Disrupted Lo-Fi Sampler. Use for "lo-fi", "vintage character", "wobbly samples".

**Effects (WHAT & WHY):**
- **NeuralAmp**: AI-powered Saturation. Use for "warmth", "overdrive", "tube grit".
- **Crusher**: Digital Lo-fi. Use for "bitcrushing", "digital distortion", "sample reduction".
- **Fold**: Wavefolder. Use for "aggressive harmonics", "complex distortion".
- **Maximizer**: Lookahead Limiter. Use for "loudness", "peak control", "final chain".
- **Tidal**: Multi-Modulation. Use for "chorus", "flanger", "phaser".
- **Revamp / Dattorro / Reverb**: Space & Depth. Dattorro is "premium algorithmic space".
- **Compressor / Gate**: Dynamic logic & Rhythm precision.
- **Delay / StereoTool**: Time-based echoes & Stereo imaging.

**MIDI Processors (Logic):**
- **Velocity / Pitch**: Utility MIDI transformation.

### 🛠️ 2. The Standard Workflows
Follow these sequences for reliable control:

**A. Designing/Modifying a Sound:**
1. Call \`get_track_details(trackName)\` to identify the current instrument and effect index.
2. Note the \`parameters\` paths (e.g., \`osc1.wave\`, \`cutoff\`).
3. Use \`set_device_param\` with the correct \`deviceType\`, \`deviceIndex\`, and \`paramPath\`.

**B. Understanding the Arrangement:**
1. Call \`get_project_overview()\` for a bird's eye view.
2. Use \`notes_get(trackName)\` to see what MIDI is currently on a track.
3. Use \`inspect_selection()\` to react to what the user has clicked on.

**C. Adding Effects:**
1. Add the effect with \`mixer_add_effect\`.
2. Find its index by calling \`get_track_details\`.
3. Tweak its settings with \`set_device_param\`.
`,
    'API': `
### 🎮 2. The ProjectApi(Gatekeeper)
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
- **Features**: "GenUI" (Knobs/Tables).
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
