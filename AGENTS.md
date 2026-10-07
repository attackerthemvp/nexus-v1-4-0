<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Desktop automation (local agent)
- Desktop control lives in local-agent/nexus_agent.py: launch_app (already-running → Desktop → Desktop\Others → validated Windows search, all paths from %USERPROFILE%), idempotent show_desktop, double-click support, per-action window focusing, fast desktop_read (OCR opt-in). Desktop tests are mock-only in local-agent/test_desktop_actions.py — never touch real input devices in tests.
- In-app UI grounding lives in local-agent/ufo_desktop.py and runs Microsoft UFO's vendored, MIT-licensed inspector/controller from local-agent/ufo_vendor/; keep upstream files intact, isolate NEXUS adaptation in the adapter, and keep nexus_agent.py limited to router mounting and tool registration.
- Android routing uses device continuity (last active device) and demonstrative PC guards in src/lib/artemis/request-router.ts; app names alone never imply Android, so cross-platform apps don't hijack PC tasks.
