import type { OdieService } from "../OdieService"

export type CommandHandler = (service: OdieService, args: string[]) => Promise<string | void>

export interface CommandDef {
    id: string
    description: string
    usage: string
    execute: CommandHandler
}

import { ProviderWithKeyStatuses } from "./llm/LLMProvider"

function isProviderWithKeyStatuses(p: unknown): p is ProviderWithKeyStatuses {
    return !!p && typeof (p as ProviderWithKeyStatuses).getKeyStatuses === 'function'
}

export class OdieCommandRegistry {
    private commands = new Map<string, CommandDef>()

    constructor() {
        this.register({
            id: "/play",
            description: "Start Transport",
            usage: "/play",
            execute: async (s) => {
                if (s.appControl.isEmpty()) return "Error: Connection lost"
                s.appControl.unwrap().play()
                return "Playing"
            }
        })

        this.register({
            id: "/stop",
            description: "Stop Transport",
            usage: "/stop",
            execute: async (s) => {
                if (s.appControl.isEmpty()) return "Error: Connection lost"
                s.appControl.unwrap().stop()
                return "Stopped"
            }
        })

        this.register({
            id: "/record",
            description: "Start Recording",
            usage: "/record [countIn? (true/false, default: true)]",
            execute: async (s, args) => {
                if (s.appControl.isEmpty()) return "Error: Connection lost"
                const countIn = args[0] !== "false" && args[0] !== "no"
                s.appControl.unwrap().record(countIn)
                return countIn ? "Recording (Count-In)" : "Recording (Immediate)"
            }
        })

        this.register({
            id: "/add",
            description: "Add a new track",
            usage: "/add [type] [name?]",
            execute: async (s, args) => {
                const type = args[0] || "synth"
                const name = args.slice(1).join(" ") || "New Track"

                if (s.appControl.isEmpty()) return "Error: Connection lost"

                const result = await s.appControl.unwrap().addTrack(type, name)
                return result.success ? result.message : `Error: ${result.reason}`
            }
        })

        this.register({
            id: "/new",
            description: "Start a new project",
            usage: "/new",
            execute: async (s) => {
                if (s.appControl.isEmpty()) return "Error: Connection lost"
                await s.appControl.unwrap().newProject()
                return "New Project Created"
            }
        })

        this.register({
            id: "/samples",
            description: "List available samples",
            usage: "/samples",
            execute: async (s) => {
                if (s.appControl.isEmpty()) return "Error: Connection lost"
                const samples = await s.appControl.unwrap().listSamples()
                if (samples.length === 0) return "No samples found."
                let report = "## Available Samples\n\n"
                report += samples.map(s => `- ${s.name}`).join("\n")
                return report
            }
        })

        this.register({
            id: "/soundfonts",
            description: "List available soundfonts",
            usage: "/soundfonts",
            execute: async (s) => {
                if (s.appControl.isEmpty()) return "Error: Connection lost"
                const sfs = await s.appControl.unwrap().listSoundfonts()
                if (sfs.length === 0) return "No soundfonts found."
                let report = "## Available Soundfonts\n\n"
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
                if (!trackName || !query) return "Usage: /set-nano [trackName] [sampleQuery]"
                if (s.appControl.isEmpty()) return "Error: Connection lost"
                const res = await s.appControl.unwrap().setNanoSample(trackName, query)
                return res.success ? res.message : `Error: ${res.reason}`
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
                if (!trackName || isNaN(padIndex) || !query) return "Usage: /set-pad [trackName] [padIndex] [sampleQuery]"
                if (s.appControl.isEmpty()) return "Error: Connection lost"
                const res = await s.appControl.unwrap().setPlayfieldPad(trackName, padIndex, query)
                return res.success ? res.message : `Error: ${res.reason}`
            }
        })

        this.register({
            id: "/set-sf",
            description: "Set soundfont for a track",
            usage: "/set-sf [trackName] [soundfontQuery]",
            execute: async (s, args) => {
                const trackName = args[0]
                const query = args.slice(1).join(" ")
                if (!trackName || !query) return "Usage: /set-sf [trackName] [soundfontQuery]"
                if (s.appControl.isEmpty()) return "Error: Connection lost"
                const res = await s.appControl.unwrap().setSoundfont(trackName, query)
                return res.success ? res.message : `Error: ${res.reason}`
            }
        })

        this.register({
            id: "/help",
            description: "List commands",
            usage: "/help",
            execute: async () => `## Odie Help

### Natural Language
Odie understands music production context. Ask naturally:

| Category | Examples |
| :--- | :--- |
| **Workflow** | _"Add a drum track"_, _"Delete selected region"_, _"Split clip here"_ |
| **Mixing** | _"Set volume to -3dB"_, _"Pan this track left"_, _"Add a Reverb"_ |
| **Transport** | _"Set tempo to 140 bpm"_, _"Loop this section"_ |
| **GenUI** | _"Show a vintage compressor"_, _"Compare EQ vs Filter"_ |

---

### Commands
Direct control over the Studio and Chat.

#### Transport & Project
| Command | Description |
| :--- | :--- |
| \`/play\` | Start transport |
| \`/stop\` | Stop transport |
| \`/record\` | Start recording (Add \`false\` for no count-in) |
| \`/new\` | Create new project |

#### Tracks & Effects
| Command | Description |
| :--- | :--- |
| \`/add [type]\` | Add track (e.g. \`/add audio\`, \`/add drums\`) |
| \`/list\` | List all tracks |
| \`/effect [track] [type]\` | Add audio effect (e.g. \`/effect Bass Reverb\`) |
| \`/meff [track] [type]\` | Add MIDI effect (e.g. \`/meff Keys Arpeggiator\`) |

#### Assets
| Command | Description |
| :--- | :--- |
| \`/samples\` | List samples |
| \`/soundfonts\` | List soundfonts |
| \`/set-nano [track] [query]\` | Load sampler directly |
| \`/set-sf [track] [query]\` | Load soundfont directly |

#### Chat
| Command | Description |
| :--- | :--- |
| \`/clear\` | Clear chat history |
`
        })

        this.register({
            id: "/dev",
            description: "Show Developer Commands",
            usage: "/dev",
            execute: async () => `## Developer Tools

| Command | Description |
| :--- | :--- |
| \`/debug\` | Dump state to console |
| \`/verify-ui\` | Test GenUI rendering |
| \`/keys\` | API key status |
`
        })

        this.register({
            id: "/clear",
            description: "Clear Chat History",
            usage: "/clear",
            execute: async (s) => {
                s.messages.setValue([])
                return "Chat History Cleared"
            }
        })

        this.register({
            id: "/debug",
            description: "Dump Debug Info to Console",
            usage: "/debug",
            execute: async (s) => {
                const info = s.lastDebugInfo.getValue()
                console.log("Odie Debug Dump", info)
                return "Debug info dumped to console"
            }
        })

        this.register({
            id: "/purge",
            description: "Factory Reset (Requires valid confirmation)",
            usage: "/purge strictly-confirm",
            execute: async (_s, args) => {
                if (args[0] !== "strictly-confirm") {
                    return "Error: To factory reset, you must type '/purge strictly-confirm'. This action cannot be undone."
                }
                console.log("Purging Odie Data...")
                localStorage.clear()
                location.reload()
                return "Purged"
            }
        })

        this.register({
            id: "/verify-ui",
            description: "Test GenUI Rendering",
            usage: "/verify-ui",
            execute: async (s) => {
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
                return "GenUI Test Payload Injected"
            }
        })


        this.register({
            id: "/effect",
            description: "Add an audio effect to a track",
            usage: "/effect [track] [type]",
            execute: async (s, args) => {
                if (args.length < 2) return "Usage: /effect [track] [type]"
                const type = args[args.length - 1]
                const track = args.slice(0, -1).join(" ")

                if (s.appControl.isEmpty()) return "Error: Connection lost"
                const res = await s.appControl.unwrap().addEffect(track, type)
                return res.success ? res.message : `Error: ${res.reason}`
            }
        })

        this.register({
            id: "/meff",
            description: "Add a MIDI effect to a track",
            usage: "/meff [track] [type]",
            execute: async (s, args) => {
                if (args.length < 2) return "Usage: /meff [track] [type]"
                const type = args[args.length - 1]
                const track = args.slice(0, -1).join(" ")

                if (s.appControl.isEmpty()) return "Error: Connection lost"
                const res = await s.appControl.unwrap().addMidiEffect(track, type)
                return res.success ? res.message : `Error: ${res.reason}`
            }
        })

        this.register({
            id: "/list",
            description: "List all tracks",
            usage: "/list",
            execute: async (s) => {
                if (s.appControl.isEmpty()) return "Error: Connection lost"
                const tracks = s.appControl.unwrap().listTracks()
                if (tracks.length === 0) return "No tracks found."
                return "## Track List\n" + tracks.map((t, i) => `${i + 1}. **${t}**`).join("\n")
            }
        })

        this.register({
            id: "/keys",
            description: "Show API Key status",
            usage: "/keys",
            execute: async (s, _args) => {
                const provider = s.ai.getActiveProvider()

                if (!isProviderWithKeyStatuses(provider)) {
                    return "Warning: Key status not available for current provider."
                }

                const statuses = provider.getKeyStatuses()
                if (!statuses || statuses.length === 0) {
                    return "No API keys configured."
                }

                let report = "## API Key Library\n\n"
                report += "| # | Key | Status | Active |\n"
                report += "|---|-----|--------|--------|\n"

                for (let i = 0; i < statuses.length; i++) {
                    const k = statuses[i]
                    const statusIcon = k.status === 'ready' ? '✓' :
                        k.status === 'exhausted' ? '⌛' :
                            k.status === 'invalid' ? '✗' : '?'
                    const activeIcon = k.isActive ? ' •' : ''
                    const maskedKey = k.key.length > 8
                        ? `${k.key.slice(0, 4)}...${k.key.slice(-4)}`
                        : "********"
                    report += `| ${i + 1} | ${maskedKey} | ${statusIcon} ${k.status.toUpperCase()} | ${activeIcon} |\n`
                }

                const ready = statuses.filter((k) => k.status === 'ready' || k.status === 'unknown').length
                const exhausted = statuses.filter((k) => k.status === 'exhausted').length
                const invalid = statuses.filter((k) => k.status === 'invalid').length

                report += `\n**Summary:** ${ready} Ready, ${exhausted} Exhausted, ${invalid} Invalid`
                return report
            }
        })

        this.register({
            id: "/status",
            description: "Show system status",
            usage: "/status",
            execute: async (s) => {
                const provider = s.ai.getActiveProvider()
                const config = provider ? s.ai.getConfig(provider.id) : null
                const activeModel = config?.modelId || "Auto"
                const models = (provider && typeof provider.fetchModels === 'function')
                    ? await provider.fetchModels()
                    : []

                let report = "## Odie Alpha Status\n\n"
                report += `- **Provider:** ${provider?.manifest.name || "None"}\n`
                report += `- **Model:** ${activeModel || "None"}\n`
                report += `- **Available Models:** ${models.length}\n`

                if (provider && provider.validate) {
                    const res = await provider.validate()
                    report += `- **Connection:** ${res.ok ? "✅ Ready" : "❌ Disconnected"}\n`
                    if (!res.ok) report += `  - *Reason:* ${res.message}\n`
                }

                return report
            }
        })

        this.register({
            id: "/diagnose",
            description: "Run connection sweep",
            usage: "/diagnose",
            execute: async (s) => {
                const provider = s.ai.getActiveProvider()
                if (!provider) return "Error: No active provider"

                if (!provider.validate) {
                    return "Standard provider detected. Connection is managed by cloud."
                }

                const res = await provider.validate()
                let report = `## Connection Sweep\n\n`
                report += `**Status:** ${res.ok ? "✅ SUCCESS" : "❌ FAILED"}\n`
                report += `**Message:** ${res.message}\n\n`

                if (!res.ok && provider.debugLog) {
                    report += "### Debug Logs\n```\n" + provider.debugLog + "\n```"
                }

                return report
            }
        })
    }

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
            return `Error: ${(e instanceof Error) ? e.message : String(e)}`
        }
    }
}

export const commandRegistry = new OdieCommandRegistry()
