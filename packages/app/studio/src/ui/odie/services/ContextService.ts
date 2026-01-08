import { DefaultObservableValue } from "@opendaw/lib-std"
import type { StudioService } from "../../../service/StudioService"
import type { Project, ProjectProfile } from "@opendaw/studio-core"
import { Option } from "@opendaw/lib-std"

// -- INTERFACES --

/**
 * The "Soul" of the project.
 * High-level artistic intent that guides the AI's suggestions.
 */
export interface ProjectDNA {
    genre: string
    mood: string
    rules: string[] // e.g. "No 4/4 beats", "Only analog synths"
    userLevel: 'beginner' | 'intermediate' | 'advanced'
}

/**
 * Global State (Always On).
 * The fundamental physics of the project.
 */
export interface GlobalLens {
    projectName: string
    bpm: number
    key: string
    timeSignature: string
    isPlaying: boolean
    dna: ProjectDNA
    modelId?: string
    forceAgentMode?: boolean
}

/**
 * Focus State (Dynamic).
 * What is the user looking at right now?
 */
export interface FocusLens {
    activeView: 'arranger' | 'mixer' | 'editor' | 'browser'
    selectedTrackName?: string | null
    selectedTrackPlugins?: string[]
    selectedClipName?: string | null
    errorState?: string | null // If the user encountered an error recently
}

export interface DAWContext {
    global: GlobalLens
    focus: FocusLens
}

// -- SERVICE --

export class ContextService {
    // The "Brain" State
    public readonly state: DefaultObservableValue<DAWContext>
    private studio?: StudioService // Weak reference to avoid circular imports during boot. Cast to StudioService when used.

    constructor() {
        // Initial / Mock State
        this.state = new DefaultObservableValue<DAWContext>({
            global: {
                projectName: "Untitled Project",
                bpm: 120,
                key: "C Major",
                timeSignature: "4/4",
                isPlaying: false,
                dna: {
                    genre: "Electronic",
                    mood: "Energetic",
                    rules: ["Keep it minimal"],
                    userLevel: "intermediate"
                }
            },
            focus: {
                activeView: 'arranger',
                selectedTrackName: null,
                selectedTrackPlugins: []
            }
        })
    }

    public setStudio(studio: StudioService) {
        this.studio = studio
        console.debug("ContextService: Connected to Studio.")

        // Listen for Project Load/Unload
        if (this.studio && this.studio.projectProfileService) {
            this.studio.projectProfileService.catchupAndSubscribe((optProfile: Option<ProjectProfile>) => {
                // const optProfile = owner.getValue() // Removed, argument IS the value
                if (optProfile.nonEmpty()) {
                    // Project Loaded
                    const project = optProfile.unwrap().project
                    this.onProjectLoaded(project)
                } else {
                    // Project Closed
                    this.resetFocus()
                }
            })
        }
    }

    private onProjectLoaded(project: Project) {
        // Subscribe to Selection
        if (project.selection) {
            project.selection.subscribe({
                onSelected: (_item: any) => this.scanSelection(project),
                onDeselected: (_item: any) => this.scanSelection(project)
            })
        }
        // Initial Scan
        this.scanSelection(project)
    }

    private resetFocus() {
        this.setFocus({
            selectedTrackName: null,
            selectedTrackPlugins: []
        })
    }

    private scanSelection(project: any) {
        try {
            const selection = project.selection.selected() as any[]
            if (selection.length === 0) {
                this.resetFocus()
                return
            }

            // Heuristic: The first item is our focus
            const primary = selection[0]

            // 1. Identify Name
            // Tracks usually have 'meta.name' or just 'name'
            let name = "Unknown Element"
            if (primary.meta?.name) name = primary.meta.name.toString()
            else if (primary.name) name = primary.name.toString()
            else if (primary.address) name = primary.address.toString()

            // 2. Identify Plugins
            // Tracks have 'audioUnits' (PointerHub)
            let plugins: string[] = []

            // Check for AudioUnits Hub
            if (primary.audioUnits && primary.audioUnits.pointerHub) {
                const units = primary.audioUnits.pointerHub.incoming()
                plugins = units.map((u: any) => {
                    const box = u.box
                    // Read plugin name from meta or type
                    return box.meta?.name?.toString() || box.cls?.name || "Unknown Plugin"
                })
            }
            // Check if it's a plugin itself
            else if (primary.constructor && primary.constructor.name.includes("AudioUnit")) {
                plugins = [name]
                // Try to find parent track? Too complex for now.
            }

            this.setFocus({
                selectedTrackName: name,
                selectedTrackPlugins: plugins.length > 0 ? plugins : undefined
            })

            console.debug("Odie Focus:", name, plugins)

        } catch (e) {
            console.warn("ContextService: Failed to scan selection", e)
        }
    }

    /**
     * Snapshots the current DAW state.
     */
    public scan(modelId?: string, forceAgentMode?: boolean): DAWContext {
        if (this.studio) {
            // -- REAL DATA MODE --
            const s = this.studio

            // 1. Project Info
            const projectName = s.hasProfile
                ? s.profile.meta.name
                : "No Project Loaded"

            let bpm = 120
            let key = "C Major"
            let timeSignature = "4/4"
            let isPlaying = false

            try {
                // 2. Transport & Engine
                if (s.engine && s.engine.isPlaying) {
                    isPlaying = s.engine.isPlaying.getValue()
                }

                // 3. Timeline / Global Specs
                if (s.profile && s.profile.project && s.profile.project.timelineBox) {
                    const tl = s.profile.project.timelineBox

                    if (tl.bpm) bpm = tl.bpm.getValue()
                    if (tl.signature) timeSignature = tl.signature.toString()

                    // Best guess for Key - if it exists on Timeline or Root
                    // Note: If Key is missing, we stick to default
                    if ((tl as any).key) key = (tl as any).key.getValue()
                    else if ((s.profile.project as any).key) key = (s.profile.project as any).key.getValue()
                }
            } catch (e) {
                console.warn("ContextService: Sensor Read Error", e)
            }

            return {
                global: {
                    projectName,
                    bpm,
                    key,
                    timeSignature,
                    isPlaying,
                    dna: this.state.getValue().global.dna, // Keep DNA from local state for now
                    modelId: modelId,
                    forceAgentMode: forceAgentMode
                },
                focus: this.state.getValue().focus // Keep focus from local state
            }
        }

        // -- MOCK MODE --
        return this.state.getValue()
    }

    /**
     * Updates the focus context (e.g. user clicked a track).
     * @param focus Partial focus update
     */
    public setFocus(focus: Partial<FocusLens>) {
        const current = this.state.getValue()
        this.state.setValue({
            ...current,
            focus: {
                ...current.focus,
                ...focus
            }
        })
    }
}
