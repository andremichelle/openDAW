import {afterEach, beforeEach, describe, expect, it, vi} from "vitest"
import {DefaultObservableValue, Exec, Procedure} from "@moises-ai/lib-std"
import {Messenger} from "./messenger"
import {Communicator} from "./communicator"
import {Wait} from "./wait"

type DetailedType = { amount: number, numbers: Uint8Array, nested: { key: { value: "xyz" } } };

interface Protocol {
    sendNotification(num: number): void;
    fetchAndTransformData(data: DetailedType): Promise<DetailedType>;
    runTask(init: Exec, progress: Procedure<number>): Promise<void>;
}

export const setupRemoteCaller = (messenger: Messenger): Protocol =>
    Communicator.sender(messenger, ({
                                        dispatchAndForget,
                                        dispatchAndReturn
                                    }) => new class implements Protocol {
        sendNotification(num: number): void {
            dispatchAndForget(this.sendNotification, num)
        }

        fetchAndTransformData(data: DetailedType): Promise<DetailedType> {
            return dispatchAndReturn(this.fetchAndTransformData, data)
        }

        runTask(init: Exec, progress: Procedure<number>): Promise<void> {
            return dispatchAndReturn(this.runTask, init, progress)
        }
    })

const notificationTracker = new DefaultObservableValue(0)

const remoteImplementation = new class implements Protocol {
    sendNotification(num: number): void {
        notificationTracker.setValue(num)
    }

    fetchAndTransformData(data: DetailedType): Promise<DetailedType> {
        const transformed = {
            ...data,
            amount: data.amount * 2
        }
        return Promise.resolve(transformed)
    }

    runTask(init: Exec, progress: Procedure<number>): Promise<void> {
        init()
        return new Promise<void>((resolve) => {
            let step = 0
            const maxSteps = 15
            const taskInterval = setInterval(() => {
                if (step < maxSteps) {
                    progress(++step / maxSteps)
                } else {
                    clearInterval(taskInterval)
                    resolve()
                }
            }, 30)
        })
    }
}

interface TestingContext {
    inputChannel: BroadcastChannel;
    outputChannel: BroadcastChannel;
    remoteCaller: Protocol;
    executor: Communicator.Executor<Protocol>;
}

describe("RemoteInterface Protocol", async () => {
    beforeEach<TestingContext>(async (context: TestingContext) => {
        const commChannel = "RemoteInterfaceChannel"
        const inputChannel = new BroadcastChannel(commChannel)
        const outputChannel = new BroadcastChannel(commChannel)
        context.inputChannel = inputChannel
        context.outputChannel = outputChannel
        context.remoteCaller = setupRemoteCaller(Messenger.for(inputChannel))
        context.executor = Communicator.executor(Messenger.for(outputChannel), remoteImplementation)
    })

    afterEach<TestingContext>(async (context: TestingContext) => {
        context.inputChannel.close()
        context.outputChannel.close()
    })

    it("should deliver notifications correctly", async (context: TestingContext) => {
        const testNum = 500
        context.remoteCaller.sendNotification(testNum)
        await Wait.observable(notificationTracker)
        expect(notificationTracker.getValue()).toBe(testNum)
    })

    it("should retrieve and process data accurately", async (context: TestingContext) => {
        const testData: DetailedType = {
            amount: 24,
            numbers: new Uint8Array([10, 20, 30]),
            nested: {key: {value: "xyz"}}
        }

        await expect(context.remoteCaller.fetchAndTransformData(testData)).resolves.toStrictEqual({
            ...testData,
            amount: 48
        })
    })

    it("should maintain data immutability during transformation", async (context: TestingContext) => {
        const data: DetailedType = {
            amount: 24,
            numbers: new Uint8Array([10, 20, 30]),
            nested: {key: {value: "xyz"}}
        }

        await expect(context.remoteCaller.fetchAndTransformData(data)).resolves.not.toBe(data)
    })

    it("should ensure task runs with progress updates", async () => {
        const taskInitCallback = vi.fn()
        const progressUpdateCallback = vi.fn()

        const commInput = new BroadcastChannel("TaskExecution")
        const commOutput = new BroadcastChannel("TaskExecution")

        const remoteCaller = setupRemoteCaller(Messenger.for(commInput))
        Communicator.executor(Messenger.for(commOutput), remoteImplementation)

        await remoteCaller.runTask(taskInitCallback, progressUpdateCallback)

        expect(taskInitCallback).toHaveBeenCalledTimes(1)
        expect(progressUpdateCallback).toHaveBeenCalledTimes(15)

        commInput.close()
        commOutput.close()
    })

    it("should broadcast simple messages", async () => {
        const broadcaster = new BroadcastChannel("MessageChannel")
        const receiver = new BroadcastChannel("MessageChannel")
        const messageReceived = vi.fn()

        const broadcastPromise = new Promise((resolve) => {
            receiver.addEventListener("message", () => {
                messageReceived()
                resolve(undefined)
            })
        })

        broadcaster.postMessage({hello: "world"})
        await broadcastPromise
        expect(messageReceived).toBeCalled()

        broadcaster.close()
        receiver.close()
    })

    it("should invoke remote methods and verify execution", async () => {
        interface MediaControl {play(): Promise<void>}

        const sendCh = new BroadcastChannel("MediaChannel")
        const recvCh = new BroadcastChannel("MediaChannel")
        const playInitiated = vi.fn()
        const playVerified = vi.fn()

        const remoteControl = Communicator.sender<MediaControl>(
            Messenger.for(sendCh),
            (dispatcher) => new class implements MediaControl {
                play(): Promise<void> {
                    playInitiated()
                    return dispatcher.dispatchAndReturn(this.play)
                }
            }
        )

        Communicator.executor<MediaControl>(Messenger.for(recvCh), new class implements MediaControl {
            play(): Promise<void> {
                playVerified()
                return Promise.resolve()
            }
        })

        await remoteControl.play()
        expect(playInitiated).toHaveBeenCalledTimes(1)
        expect(playVerified).toHaveBeenCalledTimes(1)

        sendCh.close()
        recvCh.close()
    })
})