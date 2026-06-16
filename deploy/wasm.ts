import SftpClient from "ssh2-sftp-client"

// Deploys the WASM test app to the wasm.opendaw.studio docroot (already created on the server).
// Separate from the studio deploy — touches nothing else.
const config = {
    host: process.env.SFTP_HOST,
    port: Number(process.env.SFTP_PORT),
    username: process.env.SFTP_USERNAME,
    password: process.env.SFTP_PASSWORD
} as const

const distDir = "./packages/app/wasm/dist"
// The SFTP login is rooted at the opendaw.studio docroot, so an absolute "/wasm.opendaw.studio"
// resolves under it. Step up one level to reach the sibling subdomain docroot at the server root.
const remoteDir = "../wasm.opendaw.studio"

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
</IfModule>
`

;(async () => {
    const sftp = new SftpClient()
    await sftp.connect(config)
    await sftp.mkdir(remoteDir, true).catch(() => {})
    console.log(`uploading ${distDir} -> ${remoteDir}`)
    await sftp.uploadDir(distDir, remoteDir)
    await sftp.put(Buffer.from(htaccess), `${remoteDir}/.htaccess`)
    await sftp.end()
    console.log("✅ deployed wasm test app to wasm.opendaw.studio")
})().catch((reason) => {
    console.error(reason)
    process.exit(1)
})
