export const enum VoiceState {
    /** Voice is crossfading - check fadeDirection for in (+1) or out (-1) */
    Fading = 0,
    /** Voice is at full amplitude */
    Active = 1,
    /** Voice has finished and should be removed */
    Done = 2
}
