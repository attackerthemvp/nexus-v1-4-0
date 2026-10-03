# PC local agent (Python) change for Artemis

NEXUS sends Artemis phone actions as the existing `phone_agent_command` tool: `{"command": "<name>", "args": {...}, "timeout_sec": N}`. The local agent must forward these unchanged to the phone over the existing authenticated tailnet link.

Instructions for the AI editing `nexus_agent.py`:
1. Find the handler for `phone_agent_command`. If it checks commands against a hard-coded allow-list, replace that check with the capability list the phone itself reported at registration (so new phone capabilities work without editing the PC agent).
2. Forward `args` untouched. Honour `timeout_sec` (default 30, max 120) when waiting for the phone's answer.
3. Return the phone's JSON envelope verbatim (`{ok, code, message, ...}`) including large fields like `screenshot_b64` and `xml`. Raise the response size limit to at least 8 MB.
4. Errors: phone not connected → HTTP 503; no answer before timeout → 504; command not in the phone's capability list → 400 `unsupported_command`.
5. Delete every ADB route, `adb` subprocess call, `android_manager.py` ADB usage and ADB setup text. No ADB fallback.
6. `phone_agent_status` must keep returning `agents[].capabilities` exactly as the phone reports them.
