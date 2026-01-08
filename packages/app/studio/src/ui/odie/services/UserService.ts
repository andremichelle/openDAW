import { DefaultObservableValue } from "@opendaw/lib-std"

export type UserLevel = "beginner" | "intermediate" | "advanced" | "pro"

export interface SonicFingerprint {
    primaryGenre: string
    secondaryGenres: string[]
    vibeKeywords: string[] // e.g. ["Atmospheric", "Dark", "Lo-fi"]
}

export interface TechRider {
    daw: string // Preserved for legacy, but "OpenDAW" is default
    integrations: string[] // e.g. ["Moog", "Serum", "Guitar", "Push 2"]
    workflow: "in-the-box" | "hybrid" | "outboard-heavy" | "recording-focus"
}

export interface UserIdentity {
    role: "producer" | "songwriter" | "mixer" | "sound_designer" | "artist"
    location: string
}

export interface UserDNA {
    name: string
    avatar?: string
    identity: UserIdentity
    level: UserLevel
    sonicFingerprint: SonicFingerprint
    techRider: TechRider
    goals: string[] // e.g. ["learn_mixing", "finish_album"]
    influences: string[] // e.g. ["Daft Punk", "Hans Zimmer"]
}

const DEFAULT_DNA: UserDNA = {
    name: "",
    identity: { role: "producer", location: "" },
    level: "intermediate",
    sonicFingerprint: { primaryGenre: "", secondaryGenres: [], vibeKeywords: [] },
    techRider: { daw: "OpenDAW", integrations: [], workflow: "in-the-box" },
    goals: [],
    influences: []
}

export class UserService {
    readonly dna = new DefaultObservableValue<UserDNA>(DEFAULT_DNA)
    private readonly STORAGE_KEY = "odie_user_dna"

    constructor() {
        this.load()
    }

    private load() {
        try {
            const raw = localStorage.getItem(this.STORAGE_KEY)
            if (raw) {
                const parsed = JSON.parse(raw)
                // Merge with default to ensure all fields exist (schema evolution)
                this.dna.setValue({ ...DEFAULT_DNA, ...parsed })
            }
        } catch (e) {
            console.error("UserService: Failed to load profile", e)
        }
    }

    public save(dna: UserDNA) {
        this.dna.setValue(dna)
        try {
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(dna))
        } catch (e) {
            console.error("UserService: Failed to save profile", e)
        }
    }

    public update(partial: Partial<UserDNA>) {
        const current = this.dna.getValue()
        this.save({ ...current, ...partial })
    }

    public getPromptContext(): string {
        const d = this.dna.getValue()
        return `
### 👤 User Profile (The Artist Passport):
- **Artist**: ${d.name} (${d.identity.role} based in ${d.identity.location})
- **Sonic Fingerprint**: ${d.sonicFingerprint.primaryGenre} | Vibes: ${d.sonicFingerprint.vibeKeywords.join(", ")}
- **Studio Rig**: ${d.techRider.workflow} with ${d.techRider.integrations.join(", ")}
- **Experience Level**: ${d.level.toUpperCase()}
- **Goals**: ${d.goals.join(", ") || "None specified"}
- **Influences**: ${d.influences.join(", ") || "None specified"}

**Guidance Strategy**:
${this.getStrategy(d.level)}
`
    }

    private getStrategy(level: UserLevel): string {
        switch (level) {
            case "beginner":
                return "- **Role**: Patient Mentor.\n- Explain technical terms simply.\n- Proactively suggest next steps.\n- Focus on 'Why' not just 'How'."
            case "intermediate":
                return "- **Role**: Collaborator.\n- Offer workflow tips.\n- Suggest creative alternatives.\n- Assume basic knowledge of DAW tools."
            case "advanced":
                return "- **Role**: Studio Assistant.\n- Be concise and efficient.\n- Focus on speed and precision.\n- Only explain complex concepts if asked."
            case "pro":
                return "- **Role**: Engineer Co-Pilot.\n- Minimal chatter. Maximum action.\n- Execute commands immediately."
            default:
                return "- **Role**: Helpful Assistant."
        }
    }
}

export const userService = new UserService()
