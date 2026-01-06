
// Verification Rig for Odie Local Model Detection (Dependency-Free)
// Run with: npx tsx verification_rig.ts

// --- MOCKS ---

// Mock Console
const originalConsole = { ...console };
// console.log = () => {}; 

// Mock Fetch
const mockFetchHistory: string[] = [];
global.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = url.toString();
    mockFetchHistory.push(urlStr);

    if (urlStr.includes("/api/tags")) {
        return {
            ok: true,
            status: 200,
            statusText: "OK",
            text: async () => JSON.stringify({
                models: [
                    { name: "qwen2.5-coder:latest" }
                ]
            })
        } as Response;
    }

    // Default 404
    return {
        ok: false,
        status: 404,
        statusText: "Not Found"
    } as Response;
};

// --- CODE UNDER TEST (Extracted from OpenAICompatibleProvider.ts) ---

class TestProvider {
    constructor(public id: string, public name: string, public baseUrl: string) { }

    async fetchModels(): Promise<string[]> {
        const baseUrl = this.baseUrl || ""
        if (!baseUrl) return []

        const foundModels: Set<string> = new Set()

        // ... (Strategy 1 omitted for brevity as bug was in Strategy 2) ...

        // Strategy 2: Ollama Standard (/api/tags)
        // CODE UNDER TEST START
        const rootUrl = baseUrl
            .replace(/\/v1\/chat\/completions\/?$/, "")
            .replace(/\/api\/chat\/?$/, "")
            .replace(/\/v1\/?$/, "")
        const targetUrl2 = `${rootUrl}/api/tags`
        // CODE UNDER TEST END

        try {
            const res = await fetch(targetUrl2)
            if (res.ok) {
                // ... (Mocked response parsing)
            }
        } catch (e) { }

        return []
    }
}

// --- TESTS ---

async function runTests() {
    originalConsole.log("🧪 Starting Verification Rig (Isolated): Odie Local Model Detection");
    let passed = 0;
    let failed = 0;

    async function test(name: string, fn: () => Promise<void>) {
        try {
            process.stdout.write(`running ${name}... `);
            mockFetchHistory.length = 0; // Reset history
            await fn();
            console.log("✅ PASS");
            passed++;
        } catch (e: any) {
            console.log("❌ FAIL");
            console.error("  " + e.message);
            failed++;
        }
    }

    // TEST 1: Standard URL
    await test("Strategy 1: Clean Base URL", async () => {
        const provider = new TestProvider("test", "Test", "http://localhost:11434");
        await provider.fetchModels();

        const expected = "http://localhost:11434/api/tags";
        const hitTags = mockFetchHistory.some(u => u === expected);
        if (!hitTags) throw new Error(`Expected ${expected}, got ${mockFetchHistory.join(", ")}`);
    });

    // TEST 2: The Bug Report Case (/api/ollama/api/chat)
    await test("Strategy 2: Robust Strip URL (/api/ollama/api/chat)", async () => {
        // User provided this weird URL
        const nastyUrl = "http://localhost:11434/api/ollama/api/chat";
        const provider = new TestProvider("test", "Test", nastyUrl);
        await provider.fetchModels();

        // The logic should strip /api/chat and append /api/tags
        // EXPECTED: http://localhost:11434/api/ollama/api/tags
        const expected = "http://localhost:11434/api/ollama/api/tags";
        const hitTags = mockFetchHistory.some(u => u === expected);

        if (!hitTags) {
            throw new Error(`Failed to strip URL correctly.\nExpected: ${expected}\nActual Hits:\n${mockFetchHistory.map(h => "  - " + h).join("\n")}`);
        }
    });

    // TEST 3: V1 style URL
    await test("Strategy 3: OpenAI Style (/v1)", async () => {
        const v1Url = "http://localhost:1234/v1";
        const provider = new TestProvider("test", "Test", v1Url);
        await provider.fetchModels();

        // Should strip /v1 and add /api/tags
        const expected = "http://localhost:1234/api/tags";
        const hitTags = mockFetchHistory.some(u => u === expected);

        if (!hitTags) throw new Error(`Expected ${expected}, got ${mockFetchHistory.join(", ")}`);
    });

    originalConsole.log("\n--- SUMMARY ---");
    originalConsole.log(`Total: ${passed + failed}`);
    originalConsole.log(`Passed: ${passed}`);
    originalConsole.log(`Failed: ${failed}`);

    if (failed > 0) process.exit(1);
    process.exit(0);
}

runTests();
