import { OdieBaseController } from "./OdieBaseController"
import { Nullable } from "@opendaw/lib-std"

export class OdieViewController extends OdieBaseController {
    public async switchScreen(screen: string): Promise<boolean> {
        try {
            // @ts-ignore - ScreenKeys union can be tricky from string, but StudioService handles it
            this.studio.switchScreen(screen as Nullable<Workspace.ScreenKeys>)
            return true
        } catch (e) {
            console.error("switchScreen failed", e)
            return false
        }
    }

    public async toggleKeyboard(): Promise<boolean> {
        try {
            // @ts-ignore - StudioService.toggleSoftwareKeyboard
            this.studio.toggleSoftwareKeyboard()
            return true
        } catch (e) {
            console.error("toggleKeyboard failed", e)
            return false
        }
    }
}
