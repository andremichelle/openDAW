import MemoryWorker from "./memory-worker.ts?worker"
import {MEMORY_TESTS, MemoryResult, runMemoryTest} from "./MemoryBenchmark"

export type MemoryProgress = { readonly current: string, readonly index: number, readonly total: number }
export type MemoryWorkerError = { readonly kind: "worker-error", readonly message: string }

type WorkerMessage =
    | { readonly kind: "progress", readonly id: string, readonly label: string, readonly index: number, readonly total: number }
    | { readonly kind: "result", readonly result: MemoryResult }
    | { readonly kind: "done" }

const yieldToEventLoop = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

export const runMemoryBenchmarks = async (
    onProgress: (progress: MemoryProgress) => void,
    onResult: (result: MemoryResult) => void,
    onWorkerError?: (error: MemoryWorkerError) => void
): Promise<void> => {
    const total = MEMORY_TESTS.length * 2
    let step = 0
    for (const test of MEMORY_TESTS) {
        onProgress({current: `${test.label} (main)`, index: step, total})
        await yieldToEventLoop()
        onResult(runMemoryTest(test, "main"))
        step++
    }
    let worker: Worker
    try {
        worker = new MemoryWorker()
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn("Memory worker construction failed:", message)
        onWorkerError?.({kind: "worker-error", message: `worker construct: ${message}`})
        return
    }
    try {
        await new Promise<void>((resolve) => {
            worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
                const message = event.data
                if (message.kind === "progress") {
                    onProgress({
                        current: `${message.label} (worker)`,
                        index: step + message.index,
                        total
                    })
                } else if (message.kind === "result") {
                    onResult(message.result)
                } else if (message.kind === "done") {
                    resolve()
                }
            }
            worker.onerror = (event: ErrorEvent) => {
                event.preventDefault()
                const message = event.message || event.filename || "unknown worker error"
                console.warn("Memory worker error:", message)
                onWorkerError?.({kind: "worker-error", message: `worker error: ${message}`})
                resolve()
            }
            worker.onmessageerror = () => {
                onWorkerError?.({kind: "worker-error", message: "worker messageerror (structured clone failed)"})
                resolve()
            }
            try {
                worker.postMessage({kind: "run", tests: MEMORY_TESTS})
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error)
                onWorkerError?.({kind: "worker-error", message: `postMessage: ${message}`})
                resolve()
            }
        })
    } finally {
        worker.terminate()
    }
}
