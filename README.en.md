# PlanCadence

**The study plan is a file, not a chat message.**

PlanCadence (Chinese: 学律) turns an AI-generated study plan into a machine-verifiable, stateful
document — the `studyplan/v1` format — so the plan can actually be executed, reviewed, and
renegotiated instead of being skimmed once and thrown away.

Most AI study tools end at a wall of text. PlanCadence ends at a file that both a student and a
program can read, edit, validate, and roll back.

---

## The problem

Students do not lack material. They lack a closed loop that turns material into an executable plan
and keeps that plan true as reality intervenes — a missed week, a task that took six times longer
than estimated, an exam week that swallows everything.

A language model writes convincing plans but cannot be trusted to hold dates, budgets, and
dependencies. A calendar app holds dates but understands nothing about a student's intent. PlanCadence
splits the difference: a deterministic engine owns the plan, and the model only talks about it.

## What makes it different

1. **A first-class plan format.** `studyplan/v1` is defined once, in zod, and that definition is the
   single source of truth. On top of shape it enforces semantics: unique task ids, referential
   integrity, acyclic dependencies, weekly time budgets, blackout dates, earliest-schedulable dates,
   and deadline bounds. Invalid plans do not silently load.
2. **A deterministic adaptive engine.** Seven classes of drift are detected (overrun, underrun,
   skipped work, deadline pressure, capacity violations, and so on). The engine re-plans, updates
   mastery estimates, and negotiates goals — with guardrails, never with vibes.
3. **Provenance-carrying information retrieval.** A built-in resource library works with no network
   at all; when a network is available, live contest schedules are fetched and stamped with a
   `verifiedAt` timestamp. The model may not invent resources — anything it writes into `resources`
   is dropped, and the number of dropped entries is reported.

## Design rule: the engine computes, the model narrates

Dates, durations, dependencies, and every guardrail are decided in `engine.ts`. The model is a
presentation layer. A hallucination can make the explanation wrong; it cannot make the plan wrong.

The same principle is enforced in code, not in prompts:

- `goal.statement` keeps the student's own words. The model cannot rewrite it — this is enforced by
  the code path, not by asking nicely in a prompt.
- Student constraints are structured, not free text: `Task.notBefore` and `constraints.blackouts`
  exist so that the rule layer can honor intent even when the model is unavailable.

## Guardrails

| Guardrail                                               | Rationale                                                           |
| ------------------------------------------------------- | ------------------------------------------------------------------- |
| Manually rescheduled tasks are locked by default        | "My input was ignored" hurts more than "the schedule is suboptimal" |
| A single adjustment may move at most 30% of the plan    | Prevents a cascade that silently rewrites everything                |
| Difficulty may ramp at most 0.2 per week                | Prevents demoralizing jumps                                         |
| The student's earliest-schedulable date is a hard floor | The engine never outranks the student                               |

## Persistence and versioning

The plan is a real file on the device, not remote state:

- **Native (iOS/Android):** `expo-file-system`
- **Web:** `localStorage`
- **Server:** stateless — plan content goes in as text and comes back as text
- **CLI:** atomic file writes (temp file + rename)

Every change writes the whole plan back and leaves a full snapshot of the previous version, which is
what rollback is built on. After each write the file is read back and compared: if the bytes on disk
do not match what was written, the app reports a storage problem instead of claiming success.

## Offline is a designed path, not a fallback bonus

`packages/shared` may not contain `fetch`, `window`, or Node APIs. That constraint is what allows the
mobile app to compute a full review on-device with no network. Every model-backed capability has a
deterministic local implementation, and the UI states honestly which path produced the output —
"AI summary" versus "system summary".

## What works today

- **The full loop:** interview → plan generation → tick off work with actual time → drift detection →
  negotiated adjustment → write-back to the plan file.
- **Interview:** the model asks questions dynamically and stops when it has enough; every question
  carries a "why we're asking this".
- **Generation:** a real run produced 12 tasks covering 3 competency areas in 20–40 seconds, with
  zero validation errors, zero tasks on days the student declared unavailable, and zero tasks inside
  exam week.
- **Drift example:** one task estimated at 20 minutes took 120. The engine reported a 6× overrun plus
  downstream consequences and proposed three reordering options; the model explained, in plain
  language, why the whole chain shifts by a week rather than one task moving.
- **Tool use:** resources retrieved by the plan's own competency targets are attached to the matching
  tasks; live contest schedules are marked as live, and when fetching fails only official entry pages
  are shown — never a guessed deadline.
- **Quality gates:** 279 tests (`node:test`, zero test dependencies), full type checking across all
  6 packages, 4 LLM contracts each with a local fallback, an 8-route stateless server, and 4 mobile
  screens plus an onboarding interview flow in light and dark themes.

## Repository layout

```
packages/
  shared/         # Single source of truth, no platform dependencies (runs on Hermes)
    src/plan/     # schema / command layer / adaptive engine / io
    src/llm/      # 4 LLM contracts + local fallbacks + output validation
    src/tools/    # resource library + deterministic search (no network)
  llm-client/     # thin OpenAI-compatible client (needs fetch, hence separate)
  storage-node/   # atomic file writes (temp + rename)
  env-node/       # .env loading
apps/
  server/         # Fastify: holds the API key, the only place that really makes HTTP calls
  mobile/         # Expo (SDK 57), four screens + bottom navigation
tools/plan-cli.ts # command-line entry point
examples/demo.studyplan  # the living document for the format, also a test fixture
```

## Quick start

Requires Node ≥ 22.18 and pnpm ≥ 10.

```powershell
pnpm install
Copy-Item .env.example .env      # optional; fill in LLM_API_KEY to use a real model
pnpm test                        # expect 279 passed / 0 failed
```

No `.env` is required to experience the product end to end: every model-backed feature has a local
fallback, and the UI labels which path was taken.

| Entry point   | Command                                   | Notes                                                           |
| ------------- | ----------------------------------------- | --------------------------------------------------------------- |
| CLI           | `pnpm plan check examples/demo.studyplan` | Fastest way to exercise the format and the engine               |
| API           | `pnpm --filter @sp/server start`          | → http://127.0.0.1:8787                                         |
| App (browser) | `pnpm --filter @sp/mobile run web`        | → http://localhost:8081                                         |
| App (phone)   | `pnpm mobile`                             | Install Expo Go, same Wi-Fi; the script probes the server first |

```powershell
pnpm typecheck                                                # all 6 packages
pnpm plan review examples/demo.studyplan --today 2026-10-19   # run the engine
pnpm plan advise examples/demo.studyplan --engine-only        # force the offline path
```

## Status and known limits

- Native file persistence (`expo-file-system`) has not yet been exercised on a physical device; the
  web implementation is covered by the end-to-end script.
- Layout animation for reordering is native-only — `LayoutAnimation` is a no-op on
  `react-native-web`, so neither screenshots nor scripted flows can prove it.
- The version-history and rollback UI is not built yet (the commands and snapshots already are).
- Local notifications and Markdown/ICS export are pending.
- On-device BYOK (the user's own API key in the OS keychain) is deliberately deferred.
- The built-in resource library holds 19 entries and is a static snapshot.

## Documentation

The project documentation is written in Chinese:

| File                      | Contents                                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| `docs/技术方案.md`            | Architecture, format spec, command layer, engine, LLM contracts, tool use, UI spec, field notes |
| `docs/开发计划.md`            | Cost model, version matrix, environment pitfalls, priorities                                    |
| `docs/测试指南.md`            | Sectioned self-test checklist (A–F)                                                             |
| `examples/demo.studyplan` | The living document for the format, and a test fixture                                          |

---

*Built for the 2026 North China five-province undergraduate computer application competition,
Tianjin region, track 1: innovative design and development of AI in vertical application scenarios.*
