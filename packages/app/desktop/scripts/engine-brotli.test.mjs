import {test} from "node:test"
import assert from "node:assert/strict"
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {brotliDecompressSync} from "node:zlib"
import {compressEngines} from "./engine-brotli.mjs"

// The engine was downloaded uncompressed (43 MB instead of 13): each engine gets a .br that decodes to the same bytes
test("every engine gets a compressed copy of the same bytes", () => {
    const folder = mkdtempSync(join(tmpdir(), "engines-"))
    const engines = {"windows/opendaw-engine.exe": "windows", "linux/opendaw-engine": "linux"}
    for (const [path, content] of Object.entries(engines)) {
        mkdirSync(join(folder, path, ".."), {recursive: true})
        writeFileSync(join(folder, path), content.repeat(10_000))
    }
    const written = compressEngines(folder)
    assert.equal(written.length, 2)
    for (const [path, content] of Object.entries(engines)) {
        assert.ok(existsSync(join(folder, `${path}.br`)), `${path}.br`)
        assert.equal(brotliDecompressSync(readFileSync(join(folder, `${path}.br`))).toString(), content.repeat(10_000))
    }
})

// the server sets the encoding only for the files its rule names, an engine .br without it fails the app's checksum
test("the server marks the engines' compressed copies as brotli", () => {
    const htaccess = readFileSync(new URL("../../studio/public/.htaccess", import.meta.url), "utf8")
    const rules = [...htaccess.matchAll(/<FilesMatch "([^"]+)">\s*\n([\s\S]*?)<\/FilesMatch>/g)]
        .filter(([, , body]) => body.includes("Content-Encoding br")).map(([, pattern]) => new RegExp(pattern))
    for (const name of ["opendaw-engine.br", "opendaw-engine.exe.br"]) {
        assert.ok(rules.some(rule => rule.test(name)), `${name} is served as brotli`)
    }
    assert.ok(!rules.some(rule => rule.test("opendaw-engine.exe")), "the uncompressed engine stays as it is")
})
