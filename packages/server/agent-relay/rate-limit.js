// Counts failed attempts per client, too many within the window block the client for a while
export class RateLimit {
    #failures = new Map()
    #blocked = new Map()
    #limit
    #window
    #block
    #now

    constructor({limit, window, block, now = Date.now}) {
        this.#limit = limit
        this.#window = window
        this.#block = block
        this.#now = now
    }

    isBlocked(client) {
        const until = this.#blocked.get(client)
        if (until === undefined) {return false}
        if (until > this.#now()) {return true}
        this.#blocked.delete(client)
        return false
    }

    fail(client) {
        const now = this.#now()
        const recent = (this.#failures.get(client) ?? []).filter(time => time > now - this.#window)
        recent.push(now)
        if (recent.length >= this.#limit) {
            this.#failures.delete(client)
            this.#blocked.set(client, now + this.#block)
        } else {
            this.#failures.set(client, recent)
        }
    }
}
