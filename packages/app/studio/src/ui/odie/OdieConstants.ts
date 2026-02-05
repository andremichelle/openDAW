/**
 * Odie Constants & Utilities
 * 
 * Standardized constants for timing and utilities for safety.
 */

export const TIMEOUTS = {
    /** Execute immediately on next tick/after render */
    IMMEDIATE: 0,
    /** Brief delay to ensure DOM is ready (e.g. for focus) */
    RENDER_DELAY: 100,
    /** Shorter delay for focus/UI updates */
    FOCUS_DELAY: 50,
    /** Duration for toast messages */
    TOAST_DURATION: 2000,
} as const

/**
 * Generates a UUID safely, falling back to a random string if crypto is unavailable
 * (e.g. in non-secure contexts).
 */
export const safeUUID = (): string => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    // Fallback for non-secure contexts
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}
