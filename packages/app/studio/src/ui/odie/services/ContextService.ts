import { DefaultObservableValue, isDefined, Nullable, Option, Terminator } from "@opendaw/lib-std"
import type { StudioService } from "../../../service/StudioService"
import type { Project, ProjectProfile } from "@opendaw/studio-core"

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
    private studio: Nullable<StudioService> = null
    readonly #terminator = new Terminator()

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

    private projectSubscription = new Terminator()

    public setStudio(studio: StudioService) {
        if (this.studio === studio) return
        this.studio = studio
        console.debug("ContextService: Connected to Studio.")

        // Cleanup previous
        this.#terminator.terminate()
        this.projectSubscription.terminate()

        // Listen for Project Load/Unload
        if (isDefined(this.studio.projectProfileService)) {
            this.#terminator.own(this.studio.projectProfileService.catchupAndSubscribe((optProfile: Option<ProjectProfile>) => {
                if (optProfile.nonEmpty()) {
                    const project = optProfile.unwrap().project
                    this.onProjectLoaded(project)
                } else {
                    this.resetFocus()
                }
            }))
        }
    }

    private onProjectLoaded(project: Project) {
        // Cleanup previous project listeners
        this.projectSubscription.terminate()

        // Subscribe to Selection
        if (project.selection) {
            this.projectSubscription.own(project.selection.subscribe({
                onSelected: () => this.scanSelection(project),
                onDeselected: () => this.scanSelection(project)
            }))
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

    private scanSelection(project: Project) {
        try {
            const selection = project.selection.selected() as unknown[]
            if (selection.length === 0) {
                this.resetFocus()
                return
            }

            // Heuristic: The first item is our focus
            const primary = selection[0] as {
                meta?: { name?: { toString(): string } }
                name?: { toString(): string }
                address?: { toString(): string }
                audioUnits?: { pointerHub?: { incoming(): Array<{ box: { meta?: { name?: { toString(): string } }, cls?: { name: string } } }> } }
                constructor?: { name: string }
            }

            // 1. Identify Name
            let name = "Unknown Element"
            if (isDefined(primary.meta?.name)) name = primary.meta.name.toString()
            else if (isDefined(primary.name)) name = primary.name.toString()
            else if (isDefined(primary.address)) name = primary.address.toString()

            // 2. Identify Plugins
            // Tracks have 'audioUnits' (PointerHub)
            let plugins: string[] = []

            if (isDefined(primary.audioUnits?.pointerHub)) {
                const units = primary.audioUnits.pointerHub.incoming()
                plugins = units.map((u) => {
                    const box = u.box
                    return box.meta?.name?.toString() || box.cls?.name || "Unknown Plugin"
                })
            }
            // Check if it's a plugin itself
            else if (isDefined(primary.constructor) && primary.constructor.name.includes("AudioUnit")) {
                plugins = [name]
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
        if (isDefined(this.studio)) {
            const s = this.studio

            const projectName = s.hasProfile
                ? s.profile.meta.name
                : "No Project Loaded"

            let bpm = 120
            let key = "C Major"
            let timeSignature = "4/4"
            let isPlaying = false

            try {
                // 2. Transport & Engine
                if (isDefined(s.engine) && isDefined(s.engine.isPlaying)) {
                    isPlaying = s.engine.isPlaying.getValue()
                }

                // 3. Timeline / Global Specs
                const profile = s.profile as unknown as Nullable<{
                    project: {
                        timelineBox: {
                            bpm: { getValue(): number }
                            signature: { toString(): string }
                            key: { getValue(): string }
                        }
                        key?: { getValue(): string }
                    }
                }>

                if (isDefined(profile?.project?.timelineBox)) {
                    const timeline = profile.project.timelineBox
                    if (isDefined(timeline.bpm)) bpm = timeline.bpm.getValue()
                    if (isDefined(timeline.signature)) timeSignature = timeline.signature.toString()
                    if (isDefined(timeline.key)) key = timeline.key.getValue()
                    else if (isDefined(profile.project.key)) key = profile.project.key.getValue()
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
