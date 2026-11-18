import {afterAll, beforeAll, describe, expect, it} from "vitest"
import {ChildProcess, execFileSync, spawn} from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import * as net from "node:net"
import {asDefined, tryCatch} from "@opendaw/lib-std"
import {CustomServerFile} from "./CustomServerFile"

const template = fs.readFileSync(path.join(__dirname, "opendaw-server.php"), "utf8")
const hasPhp = tryCatch(() => execFileSync("php", ["-v"], {stdio: "ignore"})).status === "success"

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, "127.0.0.1", () => {
        const address = server.address()
        server.close(() => typeof address === "object" && address !== null ? resolve(address.port) : reject())
    })
})

describe("CustomServerFile.generate", () => {
    it("replaces every placeholder", async () => {
        const token = CustomServerFile.createToken()
        const source = await CustomServerFile.generate(template, token, CustomServerFile.originsFor("https://localhost:8080"))
        expect(source).not.toContain("__TOKEN_HASH__")
        expect(source).not.toContain("__ORIGINS__")
        expect(source).not.toContain("__DATA_FOLDER__")
        expect(source).toContain("'https://opendaw.studio', 'https://dev.opendaw.studio', 'https://localhost:8080'")
        expect(source).not.toContain(token)
    })
    it("derives the same data folder from the same token", async () => {
        const token = CustomServerFile.createToken()
        const first = await CustomServerFile.generate(template, token, CustomServerFile.DefaultOrigins)
        const second = await CustomServerFile.generate(template, token, CustomServerFile.originsFor("https://localhost:8081"))
        const folder = (source: string) => /const DATA_FOLDER = '([^']+)'/.exec(source)?.[1]
        expect(folder(first)).toMatch(/^opendaw-data-[0-9a-f]{32}$/)
        expect(folder(first)).toBe(folder(second))
    })
    it("does not duplicate a default origin", () => {
        expect(CustomServerFile.originsFor("https://opendaw.studio")).toEqual(CustomServerFile.DefaultOrigins)
    })
    it("rejects origins that could break the php source", async () => {
        const token = CustomServerFile.createToken()
        await expect(CustomServerFile.generate(template, token, ["https://evil.com'];phpinfo();//"])).rejects.toThrow()
        await expect(CustomServerFile.generate(template, token, ["https://opendaw.studio/"])).rejects.toThrow()
    })
    it("creates 256 bit tokens", () => {
        const token = CustomServerFile.createToken()
        expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
        expect(CustomServerFile.createToken()).not.toBe(token)
    })
})

describe.skipIf(!hasPhp)("opendaw-server.php", () => {
    const origin = "https://localhost:8080"
    const token = CustomServerFile.createToken()
    let root = ""
    let base = ""
    let dataFolder = ""
    let server: ChildProcess

    const request = (query: string, init: RequestInit = {}, headers: Record<string, string> = {}) =>
        fetch(`${base}/opendaw.php?${query}`, {
            ...init,
            headers: {"X-OpenDAW-Token": token, "Origin": origin, ...headers}
        })
    const json = async (response: Response) => ({status: response.status, body: await response.json()})
    const upload = (target: string, data: Uint8Array) => request(`action=upload&path=${encodeURIComponent(target)}`,
        {method: "POST", body: data}, {"Content-Type": "application/octet-stream"})
    const download = (target: string) => request(`action=download&path=${encodeURIComponent(target)}`)
    const list = async (target: string) =>
        (await json(await request(`action=list&path=${encodeURIComponent(target)}`))).body.names.sort()
    const bytes = (size: number, seed: number = 1) => {
        const result = new Uint8Array(size)
        for (let index = 0; index < size; index++) {result[index] = (index * 31 + seed) & 0xff}
        return result
    }
    const same = (first: ArrayBuffer, second: Uint8Array) => Buffer.compare(Buffer.from(first), Buffer.from(second)) === 0

    beforeAll(async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "opendaw-server-"))
        const source = await CustomServerFile.generate(template, token, CustomServerFile.originsFor(origin))
        dataFolder = asDefined(/const DATA_FOLDER = '([^']+)'/.exec(source)?.[1])
        fs.writeFileSync(path.join(root, "opendaw.php"), source)
        const port = await freePort()
        base = `http://127.0.0.1:${port}`
        server = spawn("php", ["-d", "post_max_size=8M", "-S", `127.0.0.1:${port}`, "-t", root], {stdio: "ignore"})
        for (let attempt = 0; attempt < 50; attempt++) {
            const ready = await fetch(`${base}/opendaw.php?action=alive`).then(() => true, () => false)
            if (ready) {return}
            await new Promise(resolve => setTimeout(resolve, 100))
        }
        throw new Error("php server did not start")
    })

    afterAll(() => {
        server?.kill()
        if (root.length > 0) {fs.rmSync(root, {recursive: true, force: true})}
    })

    describe("access", () => {
        it("answers alive with the version", async () => {
            expect(await json(await request("action=alive"))).toEqual({status: 200, body: {version: 1}})
        })
        it("rejects a wrong token", async () => {
            const response = await request("action=alive", {}, {"X-OpenDAW-Token": CustomServerFile.createToken()})
            expect(response.status).toBe(401)
        })
        it("rejects a missing token", async () => {
            const response = await fetch(`${base}/opendaw.php?action=alive`, {headers: {Origin: origin}})
            expect(response.status).toBe(401)
        })
        it("rejects a token in the query instead of the header", async () => {
            const response = await fetch(`${base}/opendaw.php?action=alive&token=${token}`, {headers: {Origin: origin}})
            expect(response.status).toBe(401)
        })
        it("rejects an unknown origin before anything else", async () => {
            const response = await request("action=alive", {}, {Origin: "https://evil.example"})
            expect(response.status).toBe(403)
            expect(response.headers.get("access-control-allow-origin")).toBeNull()
        })
        it("sends cors headers for a known origin", async () => {
            for (const allowed of [origin, "https://opendaw.studio", "https://dev.opendaw.studio"]) {
                const response = await request("action=alive", {}, {Origin: allowed})
                expect(response.headers.get("access-control-allow-origin")).toBe(allowed)
            }
        })
        it("answers the preflight without a token", async () => {
            const response = await fetch(`${base}/opendaw.php?action=upload`, {
                method: "OPTIONS",
                headers: {
                    "Origin": origin,
                    "Access-Control-Request-Method": "POST",
                    "Access-Control-Request-Headers": "x-opendaw-token, content-type"
                }
            })
            expect(response.status).toBe(204)
            expect(response.headers.get("access-control-allow-origin")).toBe(origin)
            expect(response.headers.get("access-control-allow-headers")).toContain("X-OpenDAW-Token")
        })
        it("refuses an unconfigured template", async () => {
            fs.writeFileSync(path.join(root, "raw.php"), template)
            const response = await fetch(`${base}/raw.php?action=alive`, {headers: {"X-OpenDAW-Token": token}})
            expect(response.status).toBe(500)
        })
        it("rejects unknown actions and wrong methods", async () => {
            expect((await request("action=phpinfo")).status).toBe(400)
            expect((await request("action=upload&path=a")).status).toBe(405)
            expect((await request("action=list", {method: "POST"})).status).toBe(405)
        })
    })

    describe("files", () => {
        it("uploads, checks, downloads and lists", async () => {
            const data = bytes(1000)
            expect((await upload("samples/one.wav", data)).status).toBe(200)
            expect((await json(await request("action=exists&path=samples/one.wav"))).body.exists).toBe(true)
            expect((await json(await request("action=exists&path=samples"))).body.exists).toBe(true)
            expect((await json(await request("action=exists&path=samples/two.wav"))).body.exists).toBe(false)
            expect(new Uint8Array(await (await download("samples/one.wav")).arrayBuffer())).toEqual(data)
            expect(await list("samples")).toEqual(["one.wav"])
            expect(await list("")).toContain("samples")
        })
        it("overwrites an existing file", async () => {
            await upload("over/file.json", bytes(10, 1))
            await upload("over/file.json", bytes(5, 2))
            expect(new Uint8Array(await (await download("over/file.json")).arrayBuffer())).toEqual(bytes(5, 2))
        })
        it("stores an empty file", async () => {
            expect((await upload("empty/zero.bin", new Uint8Array(0))).status).toBe(200)
            expect((await download("empty/zero.bin")).status).toBe(200)
            expect((await (await download("empty/zero.bin")).arrayBuffer()).byteLength).toBe(0)
        })
        it("keeps names that end in .bin", async () => {
            await upload("projects/p1/image.bin", bytes(3))
            expect(await list("projects/p1")).toEqual(["image.bin"])
        })
        it("answers 404 for a missing file and an empty list for a missing folder", async () => {
            expect((await download("nothing/here.wav")).status).toBe(404)
            expect(await list("nothing")).toEqual([])
        })
        it("lists files and folders, never internal entries", async () => {
            await upload("mixed/a.json", bytes(1))
            await upload("mixed/sub/b.json", bytes(1))
            expect(await list("mixed")).toEqual(["a.json", "sub"])
            const top = await list("")
            expect(top.some((name: string) => name.startsWith("."))).toBe(false)
            expect(top).not.toContain("index.html")
        })
        it("deletes files and folders recursively, missing counts as done", async () => {
            await upload("gone/a/b/c.json", bytes(1))
            await upload("gone/d.json", bytes(1))
            expect((await request("action=delete&path=gone/d.json", {method: "POST"})).status).toBe(200)
            expect(await list("gone")).toEqual(["a"])
            expect((await request("action=delete&path=gone", {method: "POST"})).status).toBe(200)
            expect(await list("")).not.toContain("gone")
            expect((await request("action=delete&path=gone", {method: "POST"})).status).toBe(200)
        })
        it("refuses to delete the root", async () => {
            expect((await request("action=delete&path=", {method: "POST"})).status).toBe(400)
        })
        it("refuses to overwrite a folder with a file", async () => {
            await upload("clash/inner/x.json", bytes(1))
            expect((await upload("clash/inner", bytes(1))).status).toBe(409)
        })
        // php does not apply post_max_size to raw bodies, so only the server in front of php limits a single upload
        it("accepts a single upload above post_max_size", async () => {
            const data = bytes(9 * 1024 * 1024)
            expect((await upload("big/single.wav", data)).status).toBe(200)
            expect(same(await (await download("big/single.wav")).arrayBuffer(), data)).toBe(true)
        }, 60_000)
    })

    describe("paths", () => {
        const evil = [
            "../escape.json", "a/../../escape.json", "./a.json", "a/./b.json", "a//b.json", "/a.json", "a/",
            ".htaccess", "a/.hidden", "..", "a\\..\\b.json", "a\u0000b.json", "a:b.json",
            ".sessions/x", ".tmp/x", "x".repeat(201)
        ]
        for (const target of evil) {
            it(`rejects ${JSON.stringify(target)}`, async () => {
                expect((await upload(target, bytes(1))).status).toBe(400)
                expect((await download(target)).status).toBe(400)
                expect((await request(`action=delete&path=${encodeURIComponent(target)}`, {method: "POST"})).status).toBe(400)
            })
        }
        it("rejects percent encoded dots in the raw query", async () => {
            const response = await request("action=upload&path=%2e%2e/escape.json", {method: "POST", body: bytes(1)},
                {"Content-Type": "application/octet-stream"})
            expect(response.status).toBe(400)
        })
        it("stores a literal percent name as a plain name", async () => {
            expect((await upload("%2e%2e/literal.json", bytes(1))).status).toBe(200)
            expect(await list("")).toContain("%2e%2e")
            await request(`action=delete&path=${encodeURIComponent("%2e%2e")}`, {method: "POST"})
        })
        it("never writes outside the data folder", async () => {
            expect(fs.readdirSync(root).sort()).toEqual([dataFolder, "opendaw.php", "raw.php"].sort())
        })
        it("allows the characters the backup uses", async () => {
            const target = "wclaps/com.example plugin@1.2+beta,x=1~y/0f3a-b2c4.tar.gz"
            expect((await upload(target, bytes(2))).status).toBe(200)
            expect(new Uint8Array(await (await download(target)).arrayBuffer())).toEqual(bytes(2))
        })
    })

    describe("execution", () => {
        it("never runs an uploaded php file", async () => {
            const code = new TextEncoder().encode("<?php echo 'EXECUTED'; ?>")
            expect((await upload("evil.php", code)).status).toBe(200)
            expect(fs.existsSync(path.join(root, dataFolder, "evil.php"))).toBe(false)
            expect(fs.existsSync(path.join(root, dataFolder, "evil.php.bin"))).toBe(true)
            const direct = await fetch(`${base}/${dataFolder}/evil.php.bin`)
            expect(await direct.text()).not.toBe("EXECUTED")
            const missing = await fetch(`${base}/${dataFolder}/evil.php`)
            expect(await missing.text()).not.toContain("EXECUTED")
        })
        it("protects the data folder with .htaccess and index.html", () => {
            expect(fs.readFileSync(path.join(root, dataFolder, ".htaccess"), "utf8")).toContain("Require all denied")
            expect(fs.existsSync(path.join(root, dataFolder, "index.html"))).toBe(true)
        })
    })

    describe("chunks", () => {
        const session = () => crypto.randomUUID()
        const chunk = (id: string, index: number, data: Uint8Array) =>
            request(`action=chunk&session=${id}&index=${index}`, {method: "POST", body: data},
                {"Content-Type": "application/octet-stream"})
        const commit = (id: string, target: string, count: number, size: number) =>
            request(`action=commit&session=${id}&count=${count}&size=${size}&path=${encodeURIComponent(target)}`,
                {method: "POST"})

        it("assembles chunks in index order", async () => {
            const id = session()
            const data = bytes(3 * 5 * 1024 * 1024 + 123)
            const size = 5 * 1024 * 1024
            const parts = [0, 1, 2, 3].map(index => data.subarray(index * size, (index + 1) * size))
            for (const index of [2, 0, 3, 1]) {expect((await chunk(id, index, parts[index])).status).toBe(200)}
            expect((await commit(id, "samples/big.wav", 4, data.byteLength)).status).toBe(200)
            expect(same(await (await download("samples/big.wav")).arrayBuffer(), data)).toBe(true)
            expect(fs.existsSync(path.join(root, dataFolder, ".sessions", id))).toBe(false)
        }, 60_000)
        it("accepts a retried chunk", async () => {
            const id = session()
            await chunk(id, 0, bytes(4, 9))
            await chunk(id, 0, bytes(4, 1))
            await chunk(id, 1, bytes(4, 2))
            expect((await commit(id, "retry/file.bin", 2, 8)).status).toBe(200)
            const result = new Uint8Array(await (await download("retry/file.bin")).arrayBuffer())
            expect(result).toEqual(Uint8Array.from([...bytes(4, 1), ...bytes(4, 2)]))
        })
        it("refuses a commit with a missing chunk and keeps the old file", async () => {
            await upload("keep/file.bin", bytes(3, 7))
            const id = session()
            await chunk(id, 0, bytes(4))
            await chunk(id, 2, bytes(4))
            expect((await commit(id, "keep/file.bin", 3, 12)).status).toBe(409)
            expect(new Uint8Array(await (await download("keep/file.bin")).arrayBuffer())).toEqual(bytes(3, 7))
        })
        it("refuses a commit with the wrong size", async () => {
            const id = session()
            await chunk(id, 0, bytes(4))
            expect((await commit(id, "wrong/size.bin", 1, 5)).status).toBe(409)
            expect((await json(await request("action=exists&path=wrong/size.bin"))).body.exists).toBe(false)
        })
        it("accepts a repeated commit whose reply was lost", async () => {
            const id = session()
            await chunk(id, 0, bytes(4, 3))
            await chunk(id, 1, bytes(4, 4))
            expect((await commit(id, "repeat/file.bin", 2, 8)).status).toBe(200)
            expect((await commit(id, "repeat/file.bin", 2, 8)).status).toBe(200)
            expect((await commit(id, "repeat/file.bin", 2, 9)).status).toBe(409)
            const result = new Uint8Array(await (await download("repeat/file.bin")).arrayBuffer())
            expect(result).toEqual(Uint8Array.from([...bytes(4, 3), ...bytes(4, 4)]))
        })
        it("refuses a commit for an unknown session", async () => {
            expect((await commit(session(), "unknown/file.bin", 1, 1)).status).toBe(409)
        })
        it("rejects invalid session ids and indices", async () => {
            expect((await chunk("../../escape", 0, bytes(1))).status).toBe(400)
            expect((await chunk("not-a-uuid", 0, bytes(1))).status).toBe(400)
            expect((await request(`action=chunk&session=${session()}&index=-1`, {method: "POST", body: bytes(1)})).status).toBe(400)
            expect((await request(`action=chunk&session=${session()}&index=1e3`, {method: "POST", body: bytes(1)})).status).toBe(400)
            expect((await commit(session(), "x.bin", 0, 0)).status).toBe(400)
        })
        it("removes stale sessions and temp files on alive", async () => {
            const id = session()
            await chunk(id, 0, bytes(4))
            const folder = path.join(root, dataFolder, ".sessions", id)
            const stray = path.join(root, dataFolder, ".tmp", "stray")
            fs.writeFileSync(stray, "x")
            const old = new Date(Date.now() - 2 * 86400 * 1000)
            fs.utimesSync(folder, old, old)
            fs.utimesSync(stray, old, old)
            const fresh = session()
            await chunk(fresh, 0, bytes(4))
            await request("action=alive")
            expect(fs.existsSync(folder)).toBe(false)
            expect(fs.existsSync(stray)).toBe(false)
            expect(fs.existsSync(path.join(root, dataFolder, ".sessions", fresh))).toBe(true)
        })
    })
})
