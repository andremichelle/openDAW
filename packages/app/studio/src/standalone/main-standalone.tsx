import {AppStandalone} from "./AppStandalone"
import "../main.sass"

document.addEventListener("contextmenu", event => event.preventDefault())

const root = document.getElementById("app")!
root.appendChild(AppStandalone())
