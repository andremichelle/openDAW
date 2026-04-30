import {MemoryTest, runMemoryTest} from "./MemoryBenchmark"

type IncomingMessage = { readonly kind: "run", readonly tests: ReadonlyArray<MemoryTest> }

self.onmessage = (event: MessageEvent<IncomingMessage>) => {
    const data = event.data
    if (data.kind !== "run") {return}
    const tests = data.tests
    for (let index = 0; index < tests.length; index++) {
        const test = tests[index]
        self.postMessage({kind: "progress", id: test.id, label: test.label, index, total: tests.length})
        const result = runMemoryTest(test, "worker")
        self.postMessage({kind: "result", result})
    }
    self.postMessage({kind: "done"})
}
