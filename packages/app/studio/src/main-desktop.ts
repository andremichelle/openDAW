import {OpenDAWCloud} from "@/opendaw-api"
import {start} from "@/start"
import {DesktopFiles} from "@/platform/desktop/DesktopFiles"
import {DesktopMenu} from "@/platform/desktop/DesktopMenu"
import {DesktopLifecycle} from "@/platform/desktop/DesktopLifecycle"
import {DesktopTitle} from "@/platform/desktop/DesktopTitle"
import {NativeMenu} from "@/service/NativeMenu"
import {WclapWindows} from "@/service/WclapWindows"

OpenDAWCloud.disable()
DesktopFiles.install()
NativeMenu.install(service => {
    DesktopMenu.attach(service)
    DesktopTitle.attach(service)
})
DesktopLifecycle.install()
WclapWindows.openAsPopout()
start()
