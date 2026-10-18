// The native engines in a desktop release, brotli compressed next to them: the server answers with the .br (studio
// public/.htaccess), the app decodes it and checks the checksum of the decoded engine. Level 9: 43 MB to 13 MB in a
// few seconds, level 11 saves 1.5 MB more for a minute per engine.
import {readdirSync, readFileSync, writeFileSync} from "node:fs"
import {join} from "node:path"
import {brotliCompressSync, constants} from "node:zlib"

const isEngine = name => name === "opendaw-engine" || name === "opendaw-engine.exe"

// folder holds one folder per platform (dist-desktop/engine), answers the written .br paths
export const compressEngines = folder => readdirSync(folder, {withFileTypes: true}).filter(entry => entry.isDirectory())
    .flatMap(platform => readdirSync(join(folder, platform.name)).filter(isEngine).map(name => join(folder, platform.name, name)))
    .map(path => {
        const bytes = readFileSync(path)
        writeFileSync(`${path}.br`, brotliCompressSync(bytes, {
            params: {[constants.BROTLI_PARAM_QUALITY]: 9, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length}
        }))
        return `${path}.br`
    })
