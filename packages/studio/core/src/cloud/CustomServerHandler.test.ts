import {afterAll, beforeAll, describe, expect, it} from "vitest"
import {ChildProcess, execFileSync, spawn} from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import * as net from "node:net"
import {createHash, randomBytes} from "node:crypto"
import {asDefined, Errors, tryCatch} from "@opendaw/lib-std"
import {CustomServerHandler} from "./CustomServerHandler"

// the server file and its generator live in the app (CustomServerFile), this is the same fill in short
const templatePath = path.resolve(__dirname, "../../../../app/studio/src/custom-server/opendaw-server.php")
const hasPhp = tryCatch(() => execFileSync("php", ["-v"], {stdio: "ignore"})).status === "success"
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")
const createToken = () => randomBytes(32).toString("base64url")
const generate = (template: string, token: string, origins: ReadonlyArray<string>) => template
    .replace("'__TOKEN_HASH__'", `'${sha256(token)}'`)
    .replace("'__ORIGINS__'", origins.map(origin => `'${origin}'`).join(", "))
    .replace("'__DATA_FOLDER__'", `'opendaw-data-${sha256(`folder:${token}`).substring(0, 32)}'`)

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, "127.0.0.1", () => {
        const address = server.address()
        server.close(() => typeof address === "object" && address !== null ? resolve(address.port) : reject())
    })
})

const bytes = (size: number, seed: number = 1) => {
    const result = new Uint8Array(size)
    for (let index = 0; index < size; index++) {result[index] = (index * 31 + seed) & 0xff}
    return result
}
const same = (first: ArrayBuffer, second: Uint8Array) => Buffer.compare(Buffer.from(first), Buffer.from(second)) === 0

describe.skipIf(!hasPhp)("CustomServerHandler", () => {
    const token = createToken()
    let root = ""
    let base = ""
    let dataFolder = ""
    let server: ChildProcess

    // jsdom runs XMLHttpRequest with real CORS against the page origin, so uploads go through the preflight
    const handler = (signal?: AbortSignal, file: string = "opendaw.php", secret: string = token) =>
        new CustomServerHandler({url: `${base}/${file}`, token: secret}, signal)
    const sessions = () => fs.readdirSync(path.join(root, dataFolder, ".sessions"))

    beforeAll(async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "opendaw-handler-"))
        const template = fs.readFileSync(templatePath, "utf8")
        const source = generate(template, token, ["https://opendaw.studio", location.origin])
        dataFolder = asDefined(/const DATA_FOLDER = '([^']+)'/.exec(source)?.[1])
        fs.writeFileSync(path.join(root, "opendaw.php"), source)
        fs.writeFileSync(path.join(root, "foreign.php"),
            generate(template, token, ["https://opendaw.studio"]))
        // the router answers 503 while a fail-next counter file holds a positive number, then serves normally
        fs.writeFileSync(path.join(root, "router.php"), `<?php
$flag = __DIR__ . '/fail-next';
if ($_SERVER['REQUEST_METHOD'] !== 'OPTIONS' && is_file($flag) && (int)file_get_contents($flag) > 0) {
    file_put_contents($flag, (string)((int)file_get_contents($flag) - 1));
    header('Access-Control-Allow-Origin: ' . ($_SERVER['HTTP_ORIGIN'] ?? '*'));
    http_response_code(503);
    exit;
}
return false;`)
        const port = await freePort()
        base = `http://127.0.0.1:${port}`
        server = spawn("php", ["-S", `127.0.0.1:${port}`, "-t", root, path.join(root, "router.php")], {stdio: "ignore"})
        for (let attempt = 0; attempt < 50; attempt++) {
            if (await fetch(`${base}/opendaw.php`).then(() => true, () => false)) {return}
            await new Promise(resolve => setTimeout(resolve, 100))
        }
        throw new Error("php server did not start")
    })

    afterAll(() => {
        server?.kill()
        if (root.length > 0) {fs.rmSync(root, {recursive: true, force: true})}
    })

    it("reports the server version", async () => {
        expect(await handler().version()).toBe(CustomServerHandler.Version)
        await expect(handler().alive()).resolves.toBeUndefined()
    })

    it("explains a wrong token", async () => {
        await expect(handler(undefined, "opendaw.php", createToken()).alive())
            .rejects.toThrow("The server rejected the token.")
    })

    it("round trips a small file", async () => {
        const data = bytes(1234)
        await handler().upload("samples/small.wav", data.slice().buffer)
        expect(await handler().exists("samples/small.wav")).toBe(true)
        expect(await handler().exists("samples/other.wav")).toBe(false)
        expect(same(await handler().download("samples/small.wav"), data)).toBe(true)
        expect(await handler().list("samples")).toContain("small.wav")
        expect(await handler().list()).toContain("samples")
    })

    it("deletes files and folders", async () => {
        await handler().upload("trash/a/b.json", bytes(4).buffer)
        await handler().delete("trash/a/b.json")
        expect(await handler().exists("trash/a/b.json")).toBe(false)
        await handler().delete("trash")
        expect(await handler().list()).not.toContain("trash")
        await expect(handler().delete("trash")).resolves.toBeUndefined()
    })

    it("rejects a missing file with FileNotFound", async () => {
        await expect(handler().download("missing/file.wav")).rejects.toBeInstanceOf(Errors.FileNotFound)
    })

    it("returns an empty list for a missing folder", async () => {
        expect(await handler().list("missing")).toEqual([])
    })

    it("uploads exactly one chunk in a single request", async () => {
        const data = bytes(CustomServerHandler.ChunkSize, 3)
        await handler().upload("edge/exact.wav", data.slice().buffer)
        expect(same(await handler().download("edge/exact.wav"), data)).toBe(true)
        expect(sessions()).toEqual([])
    })

    it("uploads in chunks with rising progress", async () => {
        const data = bytes(CustomServerHandler.ChunkSize * 2 + 4321, 5)
        const values: Array<number> = []
        await handler().upload("samples/large.wav", data.slice().buffer, value => values.push(value))
        expect(same(await handler().download("samples/large.wav"), data)).toBe(true)
        expect(values.length).toBeGreaterThan(1)
        expect(values.every((value, index) => index === 0 || value >= values[index - 1])).toBe(true)
        expect(values[values.length - 1]).toBe(1.0)
        expect(sessions()).toEqual([])
    }, 60_000)

    it("uploads one byte over the chunk size in two chunks", async () => {
        const data = bytes(CustomServerHandler.ChunkSize + 1, 7)
        await handler().upload("edge/over.wav", data.slice().buffer)
        expect(same(await handler().download("edge/over.wav"), data)).toBe(true)
    }, 60_000)

    it("keeps the old file when an upload is aborted", async () => {
        const original = bytes(10, 9)
        await handler().upload("abort/file.wav", original.slice().buffer)
        const controller = new AbortController()
        const upload = handler(controller.signal).upload("abort/file.wav",
            bytes(CustomServerHandler.ChunkSize * 3, 2).buffer,
            value => {if (value > 0.4) {controller.abort()}})
        const result = await upload.then(() => "resolved", error => error)
        expect(Errors.isAbort(result)).toBe(true)
        expect(same(await handler().download("abort/file.wav"), original)).toBe(true)
    }, 60_000)

    it("does not start when already aborted", async () => {
        const controller = new AbortController()
        controller.abort()
        const result = await handler(controller.signal).upload("abort/never.wav", bytes(10).buffer)
            .then(() => "resolved", error => error)
        expect(Errors.isAbort(result)).toBe(true)
        expect(await handler().exists("abort/never.wav")).toBe(false)
        const listing = await handler(controller.signal).list().then(() => "resolved", error => error)
        expect(Errors.isAbort(listing)).toBe(true)
    })

    it("retries transient server errors on reads and uploads", async () => {
        const flag = path.join(root, "fail-next")
        fs.writeFileSync(flag, "2")
        await handler().upload("retry/file.wav", bytes(64, 4).buffer)
        fs.writeFileSync(flag, "2")
        expect(same(await handler().download("retry/file.wav"), bytes(64, 4))).toBe(true)
        expect(fs.readFileSync(flag, "utf8")).toBe("0")
    }, 30_000)

    it("gives up after the last attempt", async () => {
        const flag = path.join(root, "fail-next")
        fs.writeFileSync(flag, String(CustomServerHandler.MaxAttempts))
        await expect(handler().list()).rejects.toThrow("not reachable")
        fs.writeFileSync(flag, String(CustomServerHandler.MaxAttempts))
        await expect(handler().upload("retry/never.wav", bytes(4).buffer)).rejects.toThrow("503")
        fs.rmSync(flag)
    }, 30_000)

    it("explains a rejected path", async () => {
        await expect(handler().upload("../escape.wav", bytes(1).buffer)).rejects.toThrow("400 path")
    })

    it("fails when the server file does not allow this origin", async () => {
        await expect(handler(undefined, "foreign.php").upload("x.wav", bytes(1).buffer)).rejects.toThrow()
    }, 30_000)

    it("fails on an unreachable server", async () => {
        const closed = await freePort()
        await expect(new CustomServerHandler({url: `http://127.0.0.1:${closed}/opendaw.php`, token}).alive())
            .rejects.toThrow("not reachable")
    }, 30_000)
})
