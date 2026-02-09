import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker"
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker"

const createWorker = (Worker: new () => Worker): Worker => {
    const worker = new Worker()
    worker.onerror = (event: ErrorEvent) => {
        event.preventDefault()
        console.warn("Monaco worker error (falling back to main thread):", event.message)
    }
    return worker
}

// noinspection JSUnusedGlobalSymbols
self.MonacoEnvironment = {
    getWorker(_workerId: string, label: string) {
        switch (label) {
            case "typescript":
            case "javascript":
                return createWorker(TsWorker)
            default:
                return createWorker(EditorWorker)
        }
    }
}

// FIREFOX WORKAROUND
;(() => {
    if (typeof document.caretPositionFromPoint !== "function") return
    const original = document.caretPositionFromPoint.bind(document)
    document.caretPositionFromPoint = (x: number, y: number) => {
        const clampedY = Math.min(y, window.innerHeight - 2)
        const clampedX = Math.min(x, window.innerWidth - 2)
        return original(Math.max(0, clampedX), Math.max(0, clampedY))
    }
})()