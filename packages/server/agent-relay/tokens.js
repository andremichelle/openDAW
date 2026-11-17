import {createHash, randomBytes} from "node:crypto"
import {existsSync, readFileSync, renameSync, writeFileSync} from "node:fs"

const hashOf = token => createHash("sha256").update(token).digest("hex")

// Stores only token hashes, a token is shown once to the studio that receives it
export class TokenStore {
    #entries = new Map()
    #file
    #ttl
    #now

    constructor({file, ttl, now = Date.now}) {
        this.#file = file
        this.#ttl = ttl
        this.#now = now
        if (file !== null && existsSync(file)) {
            for (const [hash, entry] of Object.entries(JSON.parse(readFileSync(file, "utf8")))) {
                this.#entries.set(hash, entry)
            }
        }
        this.#purge()
    }

    issue() {
        const token = randomBytes(32).toString("base64url")
        const created = this.#now()
        const entry = {created, expires: created + this.#ttl, tools: null, instructions: null}
        this.#entries.set(hashOf(token), entry)
        this.#save()
        return {token, hash: hashOf(token), expires: entry.expires}
    }

    // the hash of a valid token, null for unknown or expired ones
    resolve(token) {
        if (typeof token !== "string" || token.length === 0) {return null}
        const hash = hashOf(token)
        const entry = this.#entries.get(hash)
        if (entry === undefined) {return null}
        if (entry.expires <= this.#now()) {
            this.#entries.delete(hash)
            this.#save()
            return null
        }
        return hash
    }

    expires(hash) {return this.#entries.get(hash)?.expires ?? 0}

    revoke(hash) {
        if (this.#entries.delete(hash)) {this.#save()}
    }

    remember(hash, {tools, instructions}) {
        const entry = this.#entries.get(hash)
        if (entry === undefined) {return}
        entry.tools = tools
        entry.instructions = instructions
        this.#save()
    }

    tools(hash) {return this.#entries.get(hash)?.tools ?? []}

    instructions(hash) {return this.#entries.get(hash)?.instructions ?? null}

    #purge() {
        const now = this.#now()
        let changed = false
        for (const [hash, entry] of this.#entries) {
            if (entry.expires <= now) {
                this.#entries.delete(hash)
                changed = true
            }
        }
        if (changed) {this.#save()}
    }

    #save() {
        if (this.#file === null) {return}
        const temp = `${this.#file}.tmp`
        writeFileSync(temp, JSON.stringify(Object.fromEntries(this.#entries)))
        renameSync(temp, this.#file)
    }
}
