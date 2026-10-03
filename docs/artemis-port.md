# Google Artemis → NEXUS port (core milestone)

Source: https://github.com/google/artemis (Apache 2.0). License: `src/lib/artemis/assets/LICENSE-ARTEMIS.txt`. Each ported file carries attribution.

## Architecture
User message → Android request router (`request-router.ts`: deterministic, then small model) → NORMAL (normal NEXUS) / ANDROID (`phone_task`) / AMBIGUOUS (asks you). `phone_task` passes the goal + your manually selected Flash/Pro mode to `runArtemis` (`engine.ts`). The mode is read once and frozen; provider failover (`/api/artemis-llm` → `routeChat`) has no mode input and cannot change it.

Phone path: engine → `AndroidAgentActuator` → `phone_agent_command` → PC local agent → tailnet → NEXUS Android Agent. **No ADB.**

## Component matrix
| Upstream | NEXUS file | Status |
|---|---|---|
| flash_runner.md, flash_summarizer.md, planner.json, operator.json, checker.json, pixel_safety_net.md | `assets/` | exact, unmodified |
| prompt_assembly.py | `template.ts` | TS translation |
| utils/plan_grammar.py | `plan.ts` | TS translation |
| mcp/action_manifest.py, action_specs.py | `manifest.ts` | TS; ADB tools unsupported |
| agents/flash/runner.py | `flash.ts` | TS; transcript image pruning via step summaries |
| agents/planner/planner.py | `planner.ts` | TS; validator structured output parsed from JSON |
| agents/operator/* + graph/graph.py | `pro.ts` | explicit state machine replaces LangGraph |
| agents/validator/* | `validator.ts`, `session.ts` | XML-first, pixel fallback, self-healing, one dispatch retry |
| agents/checker/* | `checker.ts` | TS; read-only probes unsupported (were ADB) |
| graph/state.py, incidents | `types.ts`, `session.ts` | typed events added |
| memory/* | `memory.ts` | in-memory per run |
| llm/* | `llm.ts`, `client-llm.ts`, `/api/artemis-llm` | replaced by NEXUS provider router |
| actuators/adb | `actuator.ts` | **replaced** by zero-ADB Android Agent actuator |

## Known differences (honest list)
- Core milestone only: Explorer/Diagnoser/video helper agents, replay_steps, get_step_screenshot and upstream long-term history retrieval are **not yet ported** (upstream prompts gate them on availability, so they are simply not offered).
- Structured outputs are parsed from JSON text instead of provider-native schemas.
- Model behaviour differs from upstream Gemini models; the provider is whatever NEXUS routing selects.
- Provider-level timeouts of the NEXUS router still apply; the Artemis client adds none.
- Checker has no device probes (upstream used ADB).
- `manage_app stop` is degraded (Home); arbitrary keycodes unsupported.
- NEXUS addition: risky-step confirmation (`risk.ts`) — send/pay/delete/call, ENTER, app stop.

## Zero-ADB audit
`src/lib/artemis/artemis.test.ts` fails if any source file declares ADB tools or contains ADB fallback language.
