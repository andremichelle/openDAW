import {readdirSync, readFileSync, writeFileSync} from "node:fs"
import {join, relative} from "node:path"

const root = process.argv[2]
const walk = (dir, extension = ".html") => readdirSync(dir, {withFileTypes: true}).flatMap(entry =>
    entry.isDirectory() ? walk(join(dir, entry.name), extension) : entry.name.endsWith(extension) ? [join(dir, entry.name)] : [])
const before = "if(t==='dark'){d.dataset.theme='dark'}else{d.dataset.theme='light'}"
const after = "if(t==='light'){d.dataset.theme='light'}else{d.dataset.theme='dark'}"
const googleFonts = /<link[^>]*(?:fonts\.googleapis|fonts\.gstatic)[^>]*>/g
const span = "<span style=\"[^\"]*\">"
const modulePrefix = new RegExp(`${span}( ?)module</span>${span}:</span>(?:${span}[^<.]*</span>)*?${span}\\.</span>${span}`, "g")
const basePath = process.argv[3] ?? "/"
const pages = new Map()
for (const [, label, slug] of readFileSync(join(root, "index.html"), "utf8").matchAll(/"label":"([A-Z]\w*)","slug":"([^"]+)"/g)) {
    if (!/^module\/[^/]+$/.test(slug)) pages.set(label, slug)
}
const labels = new RegExp(`\\b(${[...pages.keys()].sort((left, right) => right.length - left.length).join("|")})\\b`, "g")
const rawLinks = /\{@link [^|}]*\|([^}]*)\}/g
const linkTypes = (html, own) => html.replace(/<code\b[\s\S]*?<\/code>/g, code =>
    code.split(/(<[^>]+>)/).map(part => part.startsWith("<") ? part : part.replace(/;(?=\s*$)/, "").replace(labels, (text, label) =>
        pages.get(label) === own ? text : `<a href="${basePath}${pages.get(label)}" class="no-underline hover:underline">${text}</a>`)).join(""))
walk(root).forEach(file => {
    const own = relative(root, file).replace(/\/index\.html$/, "")
    const html = readFileSync(file, "utf8")
    writeFileSync(file, linkTypes(html.replace(before, after).replace(googleFonts, "").replace(rawLinks, "$1").replace(/\u2800/g, " ")
        .replace(modulePrefix, `<span style="color:#6F42C1;--shiki-dark:#B392F0">$1`), own))
})
walk(root, ".md").forEach(file => {
    const md = readFileSync(file, "utf8")
    writeFileSync(file, md.replace(/module:[^.\s]+\./g, "").replace(/\u2800/g, " "))
})
walk(root, ".js").forEach(file => {
    const js = readFileSync(file, "utf8")
    writeFileSync(file, js.replace(/(\w+)="theme",(\w+)="light"/, '$1="theme",$2="dark"'))
})
// the studio uses Rubik 300 as regular and 400 as bold
const fontFaces = [["400", 300], ["500 700", 400]].map(([weight, file]) =>
    `@font-face{font-family:Rubik;font-weight:${weight};font-style:normal;font-display:swap;src:url(/fonts/rubik-${file}.woff2) format("woff2")}`).join("")
const sizes = "main h1{font-size:1.5rem}main h2{font-size:1.125rem}main h3{font-size:1rem}main code,main pre,main h3 code{font-size:.875rem}"
const assets = join(root, "_assets")
readdirSync(assets).filter(name => name.endsWith(".css")).forEach(name => {
    const css = readFileSync(join(assets, name), "utf8")
    writeFileSync(join(assets, name), fontFaces + sizes + css.replace(/'Source Serif 4',Georgia,serif/g, "Rubik,system-ui,sans-serif").replace(/'Roboto',/g, "Rubik,"))
})
