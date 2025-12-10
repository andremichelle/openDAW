import SftpClient from "ssh2-sftp-client"
import * as fs from "fs"
import {execSync} from "child_process"

const config = {
    host: process.env.SFTP_HOST,
    port: Number(process.env.SFTP_PORT),
    username: process.env.SFTP_USERNAME,
    password: process.env.SFTP_PASSWORD
} as const

const sftp = new SftpClient()
const distDir = "./packages/app/studio/dist"
const buildInfoPath = "./packages/app/studio/public/build-info.json"
const branchName = process.env.BRANCH_NAME || "main"
const isMainBranch = branchName === "main"
const domain = isMainBranch ? "opendaw.studio" : "dev.opendaw.studio"
const envFolder = isMainBranch ? "main" : "dev"
const readBuildInfo = () => JSON.parse(fs.readFileSync(buildInfoPath, "utf8"))
const createRootHtaccess = (mainReleaseDir: string, devReleaseDir: string) => `# openDAW
#
Header set Access-Control-Allow-Origin "https://localhost:8080"
Header set Access-Control-Allow-Methods "GET, POST, OPTIONS, PUT, DELETE"
Header set Access-Control-Allow-Headers "Authorization, Content-Type, X-Requested-With"
Header set Access-Control-Allow-Credentials "true"
Header set Cross-Origin-Opener-Policy "same-origin"
Header set Cross-Origin-Embedder-Policy "require-corp"

RewriteEngine On
RewriteBase /

# --------------------------------------------------
# Allow extract.php to execute (don't redirect it)
RewriteRule ^extract\\.php$ - [L]

# Pass through requests that already target a release folder
# This allows existing sessions to continue fetching from their version
RewriteCond %{REQUEST_URI} ^/(main|dev)/releases/ [NC]
RewriteRule ^ - [L]

# Route entry points based on hostname (only non-release paths reach here)
RewriteCond %{HTTP_HOST} ^dev\\.opendaw\\.studio$ [NC]
RewriteRule ^(.*)$ ${devReleaseDir}/$1 [L]

RewriteCond %{HTTP_HOST} ^opendaw\\.studio$ [NC]
RewriteRule ^(.*)$ ${mainReleaseDir}/$1 [L]
# --------------------------------------------------
`

;(async () => {
    await sftp.connect(config)

    const {uuid} = readBuildInfo()
    const releaseDir = `/${envFolder}/releases/${uuid}`

    console.log(`deploying branch "${branchName}" to ${domain}`)
    console.log("creating", releaseDir)
    await sftp.mkdir(releaseDir, true).catch(() => {})

    // Compress dist directory
    console.log("compressing dist...")
    const tarballPath = "./dist.tar.gz"
    execSync(`tar -czf ${tarballPath} -C ${distDir} .`)

    // Upload the single compressed file
    console.log("uploading compressed dist...")
    const remoteTarball = `${releaseDir}/dist.tar.gz`
    const startTime = Date.now()
    await sftp.put(tarballPath, remoteTarball)
    console.log(`Upload took ${((Date.now() - startTime) / 1000).toFixed(1)}s`)

    // Extract on server via PHP
    console.log("extracting on server via PHP...")
    const extractUrl = `https://${domain}/extract.php?file=${encodeURIComponent(remoteTarball)}`
    const extractResponse = await fetch(extractUrl)
    if (!extractResponse.ok) {
        throw new Error(`Extraction failed: ${extractResponse.status} - ${await extractResponse.text()}`)
    }
    console.log(await extractResponse.text())

    // Clean up local tarball
    fs.unlinkSync(tarballPath)

    // Read existing .htaccess or create default values
    console.log("updating root .htaccess...")
    let mainReleaseDir: string | null = null
    let devReleaseDir: string | null = null

    try {
        const existingHtaccess = await sftp.get("/.htaccess")
        const content = existingHtaccess.toString()

        // Try new format first
        const mainMatch = content.match(/RewriteCond %\{HTTP_HOST\} \^opendaw.*\nRewriteRule \^\(\.\*\)\$ (\/main\/releases\/[^\s/]+)/)
        const devMatch = content.match(/RewriteCond %\{HTTP_HOST\} \^dev.*\nRewriteRule \^\(\.\*\)\$ (\/dev\/releases\/[^\s/]+)/)

        if (mainMatch) {
            mainReleaseDir = mainMatch[1]
        } else {
            // Try old format (migrate from /releases/ to /main/releases/)
            const oldMatch = content.match(/RewriteRule \^\(\.\*\)\$ (\/releases\/[^\s/]+)/)
            if (oldMatch) {
                mainReleaseDir = oldMatch[1].replace('/releases/', '/main/releases/')
                console.log(`migrating old main release: ${oldMatch[1]} -> ${mainReleaseDir}`)
            }
        }

        if (devMatch) {
            devReleaseDir = devMatch[1]
        }
    } catch (err) {
        console.log("no existing .htaccess found, creating new one")
    }

    // Update the appropriate release directory
    if (isMainBranch) {
        mainReleaseDir = releaseDir
    } else {
        devReleaseDir = releaseDir
    }

    // Use placeholder for environments that haven't been deployed yet
    if (!mainReleaseDir) mainReleaseDir = "/main/releases/not-yet-deployed"
    if (!devReleaseDir) devReleaseDir = "/dev/releases/not-yet-deployed"

    // Create and upload root .htaccess
    const rootHtaccess = createRootHtaccess(mainReleaseDir, devReleaseDir)
    const tmpFile = "./.htaccess"
    fs.writeFileSync(tmpFile, rootHtaccess)
    await sftp.put(tmpFile, "/.htaccess")
    fs.unlinkSync(tmpFile)

    await sftp.end()
    console.log(`✅ Release uploaded and activated: ${releaseDir}`)

    const webhookUrl = process.env.DISCORD_WEBHOOK
    if (webhookUrl) {
        const now = Math.floor(Date.now() / 1000)
        const branchInfo = isMainBranch ? "" : ` (\`${branchName}\`)`
        const content =
            `🚀 **openDAW** deployed <https://${domain}>${branchInfo} using release \`${uuid}\` <t:${now}:R>.`
        try {
            const response = await fetch(webhookUrl, {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({content})
            })
            console.log("Discord:", response.status)
        } catch (err) {
            console.warn("Discord post failed:", err)
        }
    }
})()