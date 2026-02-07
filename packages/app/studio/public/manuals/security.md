# 🔐 Security Advisory: API Keys & Privacy

**Last Updated:** 2026-01-07

## 1. Where are my keys stored?
Odie stores your API keys (Google Gemini, OpenAI, etc.) in your browser's `localStorage`.
- **Path**: `odie_provider_configs`
- **Encryption**: Keys are stored as plain text to ensure compatibility with client-side execution.

## 2. Is this safe?
**Yes, for personal devices.**
This is a "Client-Side Only" application. Your keys go directly from your browser to Google/OpenAI. They never touch an OpenDAW server (because we don't have one!).

**Review Risks:**
- **Public Computers**: NEVER use Odie on a public library or cafe computer. If you forget to clear the cache, the next person can use your quota.
- **Malicious Extensions**: If you have untrusted Chrome Extensions installed, they can theoretically read your `localStorage`.

## 3. Best Practices
1.  **Use specific keys**: Generate a unique API Key just for OpenDAW. Do not reuse your "Production" or "Company" keys.
2.  **Set Limits**: Configure usage quotas in your Google AI Studio or OpenAI dashboard to prevent billing runaway.
3.  **Clear Data**: When finished on a shared device, open Odie Settings and click **"Reset Wizard"** to wipe all keys.

## 4. Local AI (Ollama)
For maximum privacy, use the **Local** provider option (Ollama).
- **Zero Data Leakage**: Your prompts never leave `localhost`.
- **Offline Capable**: Works without internet.
- **Cost**: Free.
