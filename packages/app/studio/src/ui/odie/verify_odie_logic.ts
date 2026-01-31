
// verify_odie_logic.ts
import { DefaultObservableValue } from "@opendaw/lib-std"

// Mock OdieService partially
class MockOdieService {
    viewState = new DefaultObservableValue<string>("chat")
    appControl = undefined // Simulate broken/unloaded state

    // Paste the logic we want to test directly here or import it if we could (but we can't easily import non-exported class methods in this rig context without full setup)
    // So we will replicate the exact logic body we put in.

    async handleWidgetAction(action: any) {
        console.log("MockService received:", JSON.stringify(action))

        // Priority: Error Actions
        if (action.name === "error_action" && action.context?.actionId) {
            this.handleErrorAction(action.context.actionId)
            return
        }

        if (!this.appControl) {
            console.warn("[Gen UI] Widget action received but no appControl available")
            return
        }
    }

    private async handleErrorAction(actionId: string) {
        console.log("Handling Error Action:", actionId)
        if (actionId === "open_settings") {
            this.viewState.setValue("settings")
        }
    }
}

async function runTest() {
    console.log("🧪 Testing OdieService Logic...")
    const service = new MockOdieService()

    // 1. Initial State
    console.log("State:", service.viewState.getValue()) // Should be 'chat'

    // 2. Simulate Payload from ErrorCard
    // onAction({ name: "error_action", context: { actionId: action.id } })
    const payload = {
        name: "error_action",
        context: {
            actionId: "open_settings"
        }
    }

    // 3. Execute
    await service.handleWidgetAction(payload)

    // 4. Assert
    const outcome = service.viewState.getValue()
    console.log("New State:", outcome)

    if (outcome === "settings") {
        console.log("✅ TEST PASSED: Logic handles payload correctly without appControl.")
    } else {
        console.error("❌ TEST FAILED: View state did not change.")
    }
}

runTest()
