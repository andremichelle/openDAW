import type { OdieService } from "../OdieService"
// [ANTIGRAVITY] Cleaned Up Legacy Imports

export type CommandHandler = (service: OdieService, args: string[]) => Promise<string | void>

export interface CommandDef {
    id: string
    description: string
    usage: string
    execute: CommandHandler
}

interface KeyStatus {
    key: string
    status: 'ready' | 'exhausted' | 'invalid' | 'unknown'
    isActive: boolean
}

interface ProviderWithKeyStatuses {
    getKeyStatuses(): KeyStatus[]
}

function isProviderWithKeyStatuses(p: any): p is ProviderWithKeyStatuses {
    return p && typeof (p as any).getKeyStatuses === 'function'
}

export class OdieCommandRegistry {
    private commands = new Map<string, CommandDef>()

    constructor() {
        this.register({
            id: "/play",
            description: "Start Transport",
            usage: "/play",
            execute: async (s) => {
                if (!s.appControl) return "[ERR] Nervous System Disconnected"
                s.appControl.play()
                return "[PLAY] Playing"
            }
        })

        this.register({
            id: "/stop",
            description: "Stop Transport",
            usage: "/stop",
            execute: async (s) => {
                if (!s.appControl) return "[ERR] Nervous System Disconnected"
                s.appControl.stop()
                return "[STOP] Stopped"
            }
        })

        this.register({
            id: "/record",
            description: "Start Recording",
            usage: "/record [countIn? (true/false, default: true)]",
            execute: async (s, args) => {
                if (!s.appControl) return "[ERR] Nervous System Disconnected"
                const countIn = args[0] !== "false" && args[0] !== "no"
                s.appControl.record(countIn)
                return countIn ? "[REC] Recording (Count-In)" : "[REC] Recording (Immediate)"
            }
        })

        this.register({
            id: "/add",
            description: "Add a new track",
            usage: "/add [type] [name?]",
            execute: async (s, args) => {
                // [ANTIGRAVITY] Unlocked: Pass type directly to OdieAppControl
                // This allows 'tape', 'playfield', 'arpeggio' etc. to work dynamically via the Factory Lookup
                const type = args[0] || "synth"
                const name = args.slice(1).join(" ") || "New Track"

                if (!s.appControl) return "[ERR] Nervous System Disconnected"

                const result = await s.appControl.addTrack(type, name)
                return result.success ? `[OK] ${result.message}` : `❌ ${result.reason}`
            }
        })

        this.register({
            id: "/new",
            description: "Start a new project (Reset)",
            usage: "/new",
            execute: async (s) => {
                if (!s.appControl) return "[ERR] Nervous System Disconnected"
                await s.appControl.newProject()
                return "[NEW] New Project Created (Reset)"
            }
        })

        this.register({
            id: "/samples",
            description: "List available samples",
            usage: "/samples",
            execute: async (s) => {
                if (!s.appControl) return "[ERR] Nervous System Disconnected"
                const samples = await s.appControl.listSamples()
                if (samples.length === 0) return "(Empty) No samples found."
                let report = "## SAMPLES Available Samples\n\n"
                report += samples.map(s => `- ${s.name}`).join("\n")
                return report
            }
        })

        this.register({
            id: "/soundfonts",
            description: "List available soundfonts",
            usage: "/soundfonts",
            execute: async (s) => {
                if (!s.appControl) return "[ERR] Nervous System Disconnected"
                const sfs = await s.appControl.listSoundfonts()
                if (sfs.length === 0) return "(Empty) No soundfonts found."
                let report = "## SOUNDFONTS Available Soundfonts\n\n"
                report += sfs.map(s => `- ${s.name}`).join("\n")
                return report
            }
        })

        this.register({
            id: "/set-nano",
            description: "Set sample for Nano sampler on a track",
            usage: "/set-nano [trackName] [sampleQuery]",
            execute: async (s, args) => {
                const trackName = args[0]
                const query = args.slice(1).join(" ")
                if (!trackName || !query) return "[ERR] Usage: /set-nano [trackName] [sampleQuery]"
                if (!s.appControl) return "[ERR] Nervous System Disconnected"
                const res = await s.appControl.setNanoSample(trackName, query)
                return res.success ? `[OK] ${res.message}` : `[ERR] ${res.reason}`
            }
        })

        this.register({
            id: "/set-pad",
            description: "Set sample for a Playfield pad on a track",
            usage: "/set-pad [trackName] [padIndex] [sampleQuery]",
            execute: async (s, args) => {
                const trackName = args[0]
                const padIndex = parseInt(args[1], 10)
                const query = args.slice(2).join(" ")
                if (!trackName || isNaN(padIndex) || !query) return "[ERR] Usage: /set-pad [trackName] [padIndex] [sampleQuery]"
                if (!s.appControl) return "[ERR] Nervous System Disconnected"
                const res = await s.appControl.setPlayfieldPad(trackName, padIndex, query)
                return res.success ? `[OK] ${res.message}` : `[ERR] ${res.reason}`
            }
        })

        this.register({
            id: "/set-sf",
            description: "Set soundfont for a track",
            usage: "/set-sf [trackName] [soundfontQuery]",
            execute: async (s, args) => {
                const trackName = args[0]
                const query = args.slice(1).join(" ")
                if (!trackName || !query) return "[ERR] Usage: /set-sf [trackName] [soundfontQuery]"
                if (!s.appControl) return "[ERR] Nervous System Disconnected"
                const res = await s.appControl.setSoundfont(trackName, query)
                return res.success ? `[OK] ${res.message}` : `[ERR] ${res.reason}`
            }
        })

        this.register({
            id: "/help",
            description: "List commands",
            usage: "/help",
            execute: async () => `## ODIE USER MANUAL

### Natural Language (The Brain)
Odie understands music production context. Just ask naturally:

| Category | Examples |
| :--- | :--- |
| **Workflow** | _"Add a generic drum track"_, _"Delete the selected region"_, _"Split clip here"_ |
| **Mixing** | _"Set volume to -3dB"_, _"Pan this track left"_, _"Add a Reverb"_ |
| **Transport** | _"Set tempo to 140 bpm"_, _"Loop this section"_ |
| **GenUI** | _"Show me a vintage compressor"_, _"Compare EQ vs Filter"_ |

---

### Precision Tools (Slash Commands)
Direct control over the Studio and Chat.

#### Transport & Project
| Command | Description |
| :--- | :--- |
| \`/play\` | [PLAY] **Play** |
| \`/stop\` | [STOP] **Stop** |
| \`/record\` | [REC] **Record** (Add \`false\` to skip count-in) |
| \`/new\` | [NEW] **New Project** (Reset Studio) |

#### Tracks & Effects
| Command | Description |
| :--- | :--- |
| \`/add [type]\` | **Add Track** (e.g. \`/add audio\`, \`/add drums\`) |
| \`/list\` | [LIST] **List All Tracks** |
| \`/effect [track] [type]\` | **Add Audio FX** (e.g. \`/effect Bass Reverb\`) |
| \`/meff [track] [type]\` | **Add MIDI FX** (e.g. \`/meff Keys Arpeggiator\`) |

#### Assets (Power User)
| Command | Description |
| :--- | :--- |
| \`/samples\` | [SAMPLES] **List Samples** |
| \`/soundfonts\` | [SOUNDFONTS] **List Soundfonts** |
| \`/set-nano [track] [query]\` | **Load Sampler** (Direct Load) |
| \`/set-sf [track] [query]\` | **Load Soundfont** (Direct Load) |

#### Chat Control
| Command | Description |
| :--- | :--- |
| \`/clear\` | [WIPE] **Wipe Chat History** |
`
        })

        // [ANTIGRAVITY] Dev Tools Menu
        this.register({
            id: "/dev",
            description: "Show Developer Commands",
            usage: "/dev",
            execute: async () => `## DEVELOPER TOOLS

| Command | Description |
| :--- | :--- |
| \`/debug\` | [DEBUG] Dump State (Console Log) |
| \`/verify3ui\` | [TEST] Test GenUI (Render Widgets) |
| \`/keys\` | [KEYS] API Key Status |
`
        })

        // [ANTIGRAVITY] New Utility Commands
        this.register({
            id: "/clear",
            description: "Clear Chat History",
            usage: "/clear",
            execute: async (s) => {
                s.messages.setValue([])
                return "[WIPE] Chat History Cleared."
            }
        })

        this.register({
            id: "/debug",
            description: "Dump Debug Info to Console",
            usage: "/debug",
            execute: async (s) => {
                const info = s.lastDebugInfo.getValue()
                console.log("[DEBUG] Odie Debug Dump", info)
                return "[DEBUG] Debug info dumped to Chrome Console."
            }
        })

        this.register({
            id: "/purge",
            description: "Factory Reset (Clear Data & Reload)",
            usage: "/purge",
            execute: async (_s) => {
                // [ANTIGRAVITY] Nuclear Option for Testing Onboarding
                console.log("[PURGE] PURGING ODIE DATA...")
                localStorage.clear()
                location.reload()
                return "[PURGE] Goodbye."
            }
        })

        this.register({
            id: "/verify3ui",
            description: "Test GenUI Rendering",
            usage: "/verify3ui",
            execute: async (s) => {
                // Mock Payload
                s.genUiPayload.setValue({
                    title: "System Diagnostics",
                    root: {
                        id: "root",
                        type: "container",
                        layout: "column",
                        children: [
                            { id: "w1", type: "knob", label: "CPU Load", targetParam: "sys.cpu", min: 0, max: 100 },
                            { id: "w2", type: "switch", label: "Turbo Mode", targetParam: "sys.turbo", onValue: true, offValue: false },
                            { id: "w3", type: "label", text: "System is operational", variant: "body" }
                        ]
                    }
                })
                s.visible.setValue(true)
                return "[TEST] GenUI Test Payload Injected."
            }
        })


        this.register({
            id: "/effect",
            description: "Add an audio effect to a track",
            usage: "/effect [track] [type]",
            execute: async (s, args) => {
                if (args.length < 2) return "[ERR] Usage: /effect [track] [type]"
                const type = args[args.length - 1]
                const track = args.slice(0, -1).join(" ")

                if (!s.appControl) return "[ERR] Nervous System Disconnected"
                const res = await s.appControl.addEffect(track, type)
                return res.success ? `[OK] ${res.message}` : `[ERR] ${res.reason}`
            }
        })

        this.register({
            id: "/meff",
            description: "Add a MIDI effect to a track",
            usage: "/meff [track] [type]",
            execute: async (s, args) => {
                if (args.length < 2) return "[ERR] Usage: /meff [track] [type]"
                const type = args[args.length - 1]
                const track = args.slice(0, -1).join(" ")

                if (!s.appControl) return "[ERR] Nervous System Disconnected"
                const res = await s.appControl.addMidiEffect(track, type)
                return res.success ? `[OK] ${res.message}` : `[ERR] ${res.reason}`
            }
        })

        this.register({
            id: "/list",
            description: "List all tracks",
            usage: "/list",
            execute: async (s) => {
                if (!s.appControl) return "[ERR] Nervous System Disconnected"
                const tracks = s.appControl.listTracks()
                if (tracks.length === 0) return "(Empty) No tracks."
                return "## TRACKS List\n" + tracks.map((t, i) => `${i + 1}. **${t}**`).join("\n")
            }
        })

        // [ANTIGRAVITY] Infinity API Library Status Command
        this.register({
            id: "/keys",
            description: "Show API Key Library status",
            usage: "/keys",
            execute: async (s, _args) => {
                const provider = s.ai.getActiveProvider()

                if (!isProviderWithKeyStatuses(provider)) {
                    return "[WARN] Key status not available for current provider."
                }

                const statuses = provider.getKeyStatuses()
                if (!statuses || statuses.length === 0) {
                    return "(Empty) No API keys in library. Add keys in Settings."
                }

                let report = "## KEYS Infinity API Library\n\n"
                report += "| # | Key | Status | Active |\n"
                report += "|---|-----|--------|--------|\n"

                for (let i = 0; i < statuses.length; i++) {
                    const k = statuses[i]
                    const statusIcon = k.status === 'ready' ? '[OK]' :
                        k.status === 'exhausted' ? '[WAIT]' :
                            k.status === 'invalid' ? '[ERR]' : '[?]'
                    const activeIcon = k.isActive ? ' <--- ACTIVE' : ''
                    report += `| ${i + 1} | ${k.key} | ${statusIcon} ${k.status.toUpperCase()} | ${activeIcon} |\n`
                }

                const ready = statuses.filter((k) => k.status === 'ready' || k.status === 'unknown').length
                const exhausted = statuses.filter((k) => k.status === 'exhausted').length
                const invalid = statuses.filter((k) => k.status === 'invalid').length

                report += `\n**Summary:** ${ready} Ready, ${exhausted} Exhausted, ${invalid} Invalid`
                return report
            }
        })



    } // End Constructor

    register(def: CommandDef) {
        this.commands.set(def.id, def)
    }

    has(cmd: string) {
        return this.commands.has(cmd)
    }

    async execute(cmd: string, args: string[], service: OdieService): Promise<string | null> {
        const def = this.commands.get(cmd)
        if (!def) return null

        try {
            const result = await def.execute(service, args)
            return typeof result === "string" ? result : null
        } catch (e) {
            return `❌ Error executing ${cmd}: ${(e instanceof Error) ? e.message : String(e)}`
        }
    }
}

export const commandRegistry = new OdieCommandRegistry()
