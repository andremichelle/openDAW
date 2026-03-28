import {Notifier, Observer, Subscription, Terminable} from "@opendaw/lib-std"

const WINDOW_SECONDS = 5

export class TrafficMeter implements Terminable {
    readonly #uploadBuckets: Int32Array = new Int32Array(WINDOW_SECONDS)
    readonly #downloadBuckets: Int32Array = new Int32Array(WINDOW_SECONDS)
    readonly #notifier = new Notifier<this>()

    #cursor: number = 0
    #timer: ReturnType<typeof setInterval>

    constructor() {
        this.#timer = setInterval(() => this.#tick(), 1000)
    }

    recordUpload(bytes: number): void {this.#uploadBuckets[this.#cursor] += bytes}
    recordDownload(bytes: number): void {this.#downloadBuckets[this.#cursor] += bytes}

    get uploadRate(): number {return this.#sumBuckets(this.#uploadBuckets) / WINDOW_SECONDS}
    get downloadRate(): number {return this.#sumBuckets(this.#downloadBuckets) / WINDOW_SECONDS}

    subscribe(observer: Observer<this>): Subscription {return this.#notifier.subscribe(observer)}

    terminate(): void {clearInterval(this.#timer)}

    #tick(): void {
        const hadTraffic = this.uploadRate > 0 || this.downloadRate > 0
        this.#cursor = (this.#cursor + 1) % WINDOW_SECONDS
        this.#uploadBuckets[this.#cursor] = 0
        this.#downloadBuckets[this.#cursor] = 0
        if (hadTraffic || this.uploadRate > 0 || this.downloadRate > 0) {
            this.#notifier.notify(this)
        }
    }

    #sumBuckets(buckets: Int32Array): number {
        let sum = 0
        for (let i = 0; i < WINDOW_SECONDS; i++) {
            if (i !== this.#cursor) {sum += buckets[i]}
        }
        return sum
    }
}
