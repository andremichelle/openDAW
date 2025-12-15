import React from "react"
import {createRoot} from "react-dom/client"
import {AppStandalone} from "./AppStandalone"
import "../main.sass"

// Disable context menu
document.addEventListener("contextmenu", event => event.preventDefault())

const root = createRoot(document.getElementById("app")!)
root.render(<AppStandalone/>)
