import {DefaultObservableValue} from "@opendaw/lib-std"

const { ipcRenderer } = window.require('electron')

export class AppState {
    readonly projectRoot = new DefaultObservableValue<string>("")
    readonly elevenLabsKey = new DefaultObservableValue<string>("")
    readonly currentSongPath = new DefaultObservableValue<string | null>(null)

    constructor() {
        ipcRenderer.invoke('get-settings').then((saved: any) => {
            if (saved.projectRoot) this.projectRoot.setValue(saved.projectRoot)
            if (saved.elevenLabsKey) this.elevenLabsKey.setValue(saved.elevenLabsKey)
        })
    }

    updateSettings(settings: {projectRoot?: string, elevenLabsKey?: string}) {
        if (settings.projectRoot !== undefined) this.projectRoot.setValue(settings.projectRoot)
        if (settings.elevenLabsKey !== undefined) this.elevenLabsKey.setValue(settings.elevenLabsKey)
        ipcRenderer.invoke('save-settings', settings)
    }
}

export const appState = new AppState()
