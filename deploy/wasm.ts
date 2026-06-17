import SftpClient from "ssh2-sftp-client"

// Deploys the WASM test app to the wasm.opendaw.studio docroot (already created on the server).
// Separate from the studio deploy — touches nothing else.
const config = {
    host: process.env.SFTP_WASM_HOST,
    port: Number(process.env.SFTP_WASM_PORT),
    username: process.env.SFTP_WASM_USERNAME,
    password: process.env.SFTP_WASM_PASSWORD
} as const

const distDir = "./packages/app/wasm/dist"

// SPA fallback (client routes resolve on deep-link/refresh) + cross-origin isolation so
// SharedArrayBuffer is available (shared memory / assets, coming soon).
const htaccess = `RewriteEngine On
RewriteCond %{REQUEST_FILENAME} !-f
RewriteCond %{REQUEST_FILENAME} !-d
RewriteRule . /index.html [L]

<IfModule mod_headers.c>
  Header set Cross-Origin-Opener-Policy "same-origin"
  Header set Cross-Origin-Embedder-Policy "require-corp"
  Header set Cross-Origin-Resource-Policy "cross-origin"
  Header set Cache-Control "no-store, no-cache, must-revalidate, max-age=0"
  Header set Pragma "no-cache"
  Header set Expires "0"
  Header unset ETag
  Header unset Last-Modified
</IfModule>

FileETag None
`

;(async () => {
    const sftp = new SftpClient()
    await sftp.connect(config)
    // The dedicated wasm SFTP account is rooted at the wasm.opendaw.studio docroot,
    // so upload into its home directory rather than a hardcoded subpath.
    const remoteHome = await sftp.cwd()
    const remoteDir = remoteHome.endsWith("/") ? remoteHome.slice(0, -1) : remoteHome
    console.log(`uploading ${distDir} -> ${remoteDir || "/"}`)
    await sftp.uploadDir(distDir, remoteDir || "/")
    await sftp.put(Buffer.from(htaccess), `${remoteDir}/.htaccess`)
    await sftp.end()
    console.log("✅ deployed wasm test app to wasm.opendaw.studio")
})().catch((reason) => {
    console.error(reason)
    process.exit(1)
})
