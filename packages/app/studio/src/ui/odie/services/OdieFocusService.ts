export type FocusContext =
    | 'Arrangement'
    | 'Mixer'
    | 'PianoRoll'
    | 'AudioEditor'
    | 'Settings'
    | 'Chat'
    | 'Unknown';

class OdieFocusService {
    private currentFocus: FocusContext = 'Arrangement';
    private listeners: ((focus: FocusContext) => void)[] = [];

    /**
     * Report a change in user focus.
     * UI components should call this when matched/clicked.
     */
    setFocus(focus: FocusContext) {
        if (this.currentFocus === focus) return;

        console.log(`[OdieFocus] Focus changed: ${this.currentFocus} -> ${focus}`);
        this.currentFocus = focus;
        this.notifyListeners();
    }

    /**
     * Get the current active context.
     */
    getFocus(): FocusContext {
        return this.currentFocus;
    }

    /**
     * Subscribe to focus changes.
     */
    onFocusChange(callback: (focus: FocusContext) => void): () => void {
        this.listeners.push(callback);
        return () => {
            this.listeners = this.listeners.filter(cb => cb !== callback);
        };
    }

    private notifyListeners(): void {
        this.listeners.forEach(cb => cb(this.currentFocus));
    }
}

export const odieFocus = new OdieFocusService();
