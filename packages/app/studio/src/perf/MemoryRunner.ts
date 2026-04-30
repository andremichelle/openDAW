import MemoryWorker from "./memory-worker.ts?worker"
import {MEMORY_TESTS, MemoryResult, runMemoryTest} from "./MemoryBenchmark"

export type MemoryProgress = { readonly current: string, readonly index: number, readonly total: number }

type WorkerMessage =
    | { readonly kind: "progress", readonly id: string, readonly label: string, readonly index: number, readonly total: number }
    | { readonly kind: "result", readonly result: MemoryResult }
    | { readonly kind: "done" }

const yieldToEventLoop = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

export const runMemoryBenchmarks = async (
    onProgress: (progress: MemoryProgress) => void,
    onResult: (result: MemoryResult) => void
): Promise<void> => {
    const total = MEMORY_TESTS.length * 2
    let step = 0
    for (const test of MEMORY_TESTS) {
        onProgress({current: `${test.label} (main)`, index: step, total})
        await yieldToEventLoop()
        onResult(runMemoryTest(test, "main"))
        step++
    }
    const worker = new MemoryWorker()
    try {
        await new Promise<void>((resolve, reject) => {
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
            worker.onerror = (event: ErrorEvent) => reject(new Error(event.message))
            worker.postMessage({kind: "run", tests: MEMORY_TESTS})
        })
    } finally {
        worker.terminate()
    }
}
