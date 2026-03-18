# zai-agentic-qa

Parallel alignment tasks powered by Z.AI chat-completions. Each task targets a specific codebase concern, discovers work units, partitions them across concurrent agents, and validates + applies changes safely via sandboxes.

## Prerequisites

```bash
export Z_AI_API_KEY=...
```

Node.js 18+ (no runtime dependencies — pure stdlib). Requires `rg` (ripgrep) on PATH for agent search tools.

## Task Summary

| Task | Command | Scope | Fix? |
|------|---------|-------|------|
| docs-alignment | `npm run docs:alignment` | Docs vs source | No (docs only) |
| fixture-alignment | `npm run fixture:alignment` | REST fixture files | Yes |
| shared-ws-alignment | `npm run shared-ws:alignment` | WS fixture files | Yes |
| actor-messaging-conformance | `npm run actor-messaging:conformance` | No ad-hoc channels/runtimes | Yes |
| actor-schema-conformance | `npm run actor-schema:conformance` | ACTOR_SCHEMA.md rules | Yes |
| fixture-e2e-coverage | `npm run fixture-e2e:coverage` | Fixture E2E tests | Yes (tests) |
| test-green | `npm run test:green` | All tests with all feature flags | Yes (tests) |

### Run Scripts

| Script | Runs |
|--------|------|
| `scripts/rust_bot_v2_full.sh` | All tasks above against `rust_bot_v2` |

## Alignment Tasks

### docs-alignment — Align architecture docs against source code

Ensures Markdown docs under configured folders accurately reflect the current `src/` and `tests/` implementation.

```bash
npm run docs:alignment -- \
    --repo /path/to/repo \
    --docs-folders docs/architecture,docs/guides \
    --max-agents 3 \
    --apply
```

| Flag | Default | Description |
|------|---------|-------------|
| `--repo` | (required) | Absolute path to the target repository |
| `--docs-folders` | `docs/architecture` | Comma-separated list of folders to scan recursively for `*.md` files |
| `--max-agents` | `1` | Concurrent workers. Each doc gets its own agent |
| `--model` | `glm-5-turbo` | Z.AI model |
| `--worker-timeout-seconds` | `900` | Per-worker timeout |
| `--apply` | off | Write sandboxed docs back to the real repo after validation |
| `--dry-run` | off | Discover docs and validate setup without running agents |
| `--output` | `./artifacts/zai-docs-alignment/...` | Artifact output directory |

**Concurrency model:** Each discovered `.md` file is an independent work unit. `--max-agents 3` runs 3 docs simultaneously, rolling through the full queue until all are done. Failed workers don't block others.

**Sandbox scope:** `docs/`, `src/`, `tests/`

**Write scope:** One doc per agent (strictly the assigned file)

---

### fixture-alignment — Ensure all outbound HTTP calls have live-captured fixtures

Validates and fixes fixture coverage for actors that use `shared_restapi::Client`. Creates missing fixture files, wires `with_fixture_contract()` into untagged requests, registers contracts, and generates capture tests.

```bash
npm run fixture:alignment -- \
    --repo /path/to/repo \
    --actors src/actors/market_data/binance/binance_rest_api_actor,src/actors/market_data/binance/binance_s3_candle_actor \
    --max-agents 2 \
    --apply
```

| Flag | Default | Description |
|------|---------|-------------|
| `--repo` | (required) | Absolute path to the target repository |
| `--actors` | auto-discovered | Comma-separated list of actor directory paths. Auto-discovers actors using `shared_restapi` if omitted |
| `--max-agents` | `1` | Concurrent workers. Each actor gets its own agent |
| `--model` | `glm-5-turbo` | Z.AI model |
| `--worker-timeout-seconds` | `900` | Per-worker timeout |
| `--apply` | off | Write sandboxed changes back to the real repo after validation |
| `--dry-run` | off | Discover actors and validate setup without running agents |
| `--output` | `./artifacts/zai-fixture-alignment/...` | Artifact output directory |

**Concurrency model:** Each actor directory is an independent work unit. `--max-agents 2` runs 2 actors simultaneously, rolling through the full queue. Failed workers don't block others.

**Sandbox scope:** `src/actors/`, `tests/`, `Cargo.toml`, `build.rs`

**Write scope:** Assigned actor directory + `tests/contracts/`, `tests/live/`, `tests/execution/` (for capture test creation)

**Post-merge step:** Each agent writes a `manifest.json` listing new/modified contracts. After all agents finish, a `[post-merge]` reminder prints if `build.rs` needs updating with new contract registrations.

---

### shared-ws-alignment — Ensure all WebSocket subscriptions have live-captured fixtures

Validates and fixes fixture coverage for actors that use `shared_ws::Client`. Creates missing fixture files, wires `with_fixture_contract()` into untagged subscriptions, registers contracts, and generates capture tests. Point `--repo` at the consuming project (e.g. `rust_bot_v2`); actors are auto-discovered from `src/actors/`.

```bash
npm run shared-ws:alignment -- \
    --repo ~/Dev/git/rust_bot_v2 \
    --max-agents 3 \
    --apply
```

| Flag | Default | Description |
|------|---------|-------------|
| `--repo` | (required) | Absolute path to the target repository |
| `--actors` | auto-discovered | Comma-separated list of actor directory paths. Auto-discovers actors using `shared_ws` if omitted |
| `--max-agents` | `1` | Concurrent workers. Each actor gets its own agent |
| `--model` | `glm-5-turbo` | Z.AI model |
| `--worker-timeout-seconds` | `900` | Per-worker timeout |
| `--apply` | off | Write sandboxed changes back to the real repo after validation |
| `--dry-run` | off | Discover actors and validate setup without running agents |
| `--output` | `./artifacts/zai-shared-ws-alignment/...` | Artifact output directory |

**Concurrency model:** Each actor directory is an independent work unit. `--max-agents 2` runs 2 actors simultaneously, rolling through the full queue. Failed workers don't block others.

**Sandbox scope:** `src/actors/`, `tests/`, `Cargo.toml`, `build.rs`

**Write scope:** Assigned actor directory + `tests/contracts/`, `tests/live/`, `tests/execution/` (for capture test creation)

**Fixture format:** WS message fixtures (`_messages.json`) with an array of representative subscription messages, and error fixtures (`_error.json`) with exchange WS error payloads. Both use the same live-capture provenance envelope as REST fixtures.

**Post-merge step:** Each agent writes a `manifest.json` listing new/modified contracts. After all agents finish, a `[post-merge]` reminder prints if `build.rs` needs updating with new contract registrations.

---

### actor-messaging-conformance — Enforce icanact-core messaging rules

Finds and fixes violations where actors use ad-hoc channels (tokio mpsc, oneshot, watch, broadcast, etc.) or spawn separate runtimes instead of communicating through icanact-core traits (Tell/Ask/PubSub/Broadcast).

```bash
npm run actor-messaging:conformance -- \
    --repo ~/Dev/git/rust_bot_v2 \
    --max-agents 3 \
    --apply
```

| Flag | Default | Description |
|------|---------|-------------|
| `--repo` | (required) | Absolute path to the target repository |
| `--actors` | auto-discovered | Comma-separated list of actor directory paths. Auto-discovers all actors under `src/actors/` if omitted |
| `--max-agents` | `3` | Concurrent workers. Each actor gets its own agent |
| `--model` | `glm-5-turbo` | Z.AI model |
| `--worker-timeout-seconds` | `600` | Per-worker timeout |
| `--apply` | off | Write sandboxed fixes back to the real repo after validation |
| `--dry-run` | off | Discover actors and validate setup without running agents |
| `--output` | `./artifacts/zai-actor-messaging-conformance/...` | Artifact output directory |

**Concurrency model:** Each actor directory is an independent work unit. `--max-agents 3` runs 3 actors simultaneously, rolling through the full queue. Failed workers don't block others.

**Sandbox scope:** `src/actors/`, `src/`, `docs/`, `tests/`, `Cargo.toml`

**Write scope:** Assigned actor directory only (writes are scoped to prevent cross-actor edits)

**What it checks:**
- Ad-hoc channels: `tokio::sync::mpsc`, `tokio::sync::watch`, `tokio::sync::oneshot`, `tokio::sync::broadcast`, `std::sync::mpsc`, `crossbeam_channel`, `flume`
- Shared-state concurrency: `std::sync::Mutex`, `std::sync::RwLock`, `Arc<Mutex<...>>`, `parking_lot::Mutex`, `AtomicCell` — **no locks anywhere, including tests**
- Separate runtimes: `tokio::runtime::Builder`, `tokio::runtime::Runtime::new`, `std::thread::spawn`, `std::thread::Builder`
- `tokio::spawn` used for actor business logic (allowed only for IO-bound helpers like WS connections or REST requests)

**Allowed exceptions** (never flagged): shared crate internals (`shared_ws`, `shared_restapi`). Tests and mocks are NOT exempt — violations there must be fixed too.

**Runtime model:** Actors with I/O-bound work (WS, REST, DB) must use `local::CustomRunnerActor` + `spawn_with_custom_runner` for a native async inbox loop. The `block_in_place` bridge pattern (`Handle::try_current()` + `block_on`) in sync `Tell` handlers is forbidden — existing uses are technical debt to be migrated.

---

### actor-schema-conformance — Ensure all actors follow ACTOR_SCHEMA.md

Validates and fixes each actor's file structure, module organization, code patterns, and naming conventions against the canonical definition in `docs/ACTOR_SCHEMA.md`.

```bash
npm run actor-schema:conformance -- \
    --repo ~/Dev/git/rust_bot_v2 \
    --max-agents 3 \
    --apply
```

| Flag | Default | Description |
|------|---------|-------------|
| `--repo` | (required) | Absolute path to the target repository |
| `--actors` | auto-discovered | Comma-separated list of actor directory paths. Auto-discovers all actors under `src/actors/` if omitted |
| `--max-agents` | `3` | Concurrent workers. Each actor gets its own agent |
| `--model` | `glm-5-turbo` | Z.AI model |
| `--worker-timeout-seconds` | `600` | Per-worker timeout |
| `--apply` | off | Write sandboxed fixes back to the real repo after validation |
| `--dry-run` | off | Discover actors and validate setup without running agents |
| `--output` | `./artifacts/zai-actor-schema-conformance/...` | Artifact output directory |

**Concurrency model:** Each actor directory is an independent work unit. `--max-agents 3` runs 3 actors simultaneously, rolling through the full queue. Failed workers don't block others.

**Sandbox scope:** `src/actors/`, `src/`, `docs/`, `tests/`, `Cargo.toml`

**Write scope:** Assigned actor directory only

**What it checks:** File structure (required files, naming), module organization (mod.rs exports, hierarchy), code patterns (actor lifecycle, messaging, business logic separation), and naming conventions — all against `docs/ACTOR_SCHEMA.md`.

---

### fixture-e2e-coverage — Ensure every fixture is exercised by an E2E test

Discovers all registered fixtures (success + error) for each actor and verifies that an end-to-end test exists which exercises the full business logic flow through that fixture. Creates missing tests for uncovered fixtures, including error handling and edge cases.

```bash
npm run fixture-e2e:coverage -- \
    --repo ~/Dev/git/rust_bot_v2 \
    --max-agents 2 \
    --apply
```

| Flag | Default | Description |
|------|---------|-------------|
| `--repo` | (required) | Absolute path to the target repository |
| `--actors` | auto-discovered | Comma-separated list of actor directory paths. Auto-discovers actors using `shared_restapi` or `shared_ws` if omitted |
| `--max-agents` | `2` | Concurrent workers. Each actor gets its own agent |
| `--model` | `glm-5-turbo` | Z.AI model |
| `--worker-timeout-seconds` | `1200` | Per-worker timeout (longer due to test creation + cargo check) |
| `--apply` | off | Write sandboxed tests back to the real repo after validation |
| `--dry-run` | off | Discover actors and validate setup without running agents |
| `--output` | `./artifacts/zai-fixture-e2e-coverage/...` | Artifact output directory |

**Concurrency model:** Each actor directory is an independent work unit. `--max-agents 2` runs 2 actors simultaneously, rolling through the full queue. Failed workers don't block others.

**Sandbox scope:** `src/actors/`, `src/`, `tests/`, `Cargo.toml`

**Write scope:** Assigned actor directory + `tests/e2e/` (for test creation only)

**What it checks:** For each registered fixture (success AND error), whether an existing test exercises the full business logic path through it. A test that only reads the JSON file directly does NOT count — it must go through the same code path as production.

**Test requirements:**
- `#[ignore]` integration tests (depends on fixture files)
- Tests go through the actual business logic (not just deserialize the JSON)
- Both success fixtures (correct domain state) and error fixtures (proper error handling) covered
- Edge cases: empty body, malformed JSON, missing fields
- No shared state (`Mutex`, `Cell`, `RefCell`, channels) — tests use actor messaging
- `cargo_check` must pass

---

### test-green — Ensure all tests pass with all feature flags

Runs the full test suite with all feature flags enabled (`cargo test --all-features`), excluding `#[ignore]` tests and live tests. For each failing test, identifies the root cause and applies a proper fix in source or test code. Never suppresses, skips, or weakens failing tests — fixes the underlying issue.

```bash
npm run test:green -- \
    --repo ~/Dev/git/rust_bot_v2 \
    --max-agents 2 \
    --apply
```

| Flag | Default | Description |
|------|---------|-------------|
| `--repo` | (required) | Absolute path to the target repository |
| `--actors` | auto-discovered | Comma-separated list of actor directory paths. Auto-discovers all actors under `src/actors/` if omitted |
| `--max-agents` | `2` | Concurrent workers. Each actor gets its own agent |
| `--model` | `glm-5-turbo` | Z.AI model |
| `--worker-timeout-seconds` | `1800` | Per-worker timeout (longer due to test compilation + execution cycles) |
| `--apply` | off | Write sandboxed fixes back to the real repo after validation |
| `--dry-run` | off | Discover actors and validate setup without running agents |
| `--output` | `./artifacts/zai-test-green/...` | Artifact output directory |

**What it runs:** `cargo test --all-features` with `#[ignore]` and live tests excluded.

**Concurrency model:** Each actor directory is an independent work unit. `--max-agents 2` runs 2 actors simultaneously, rolling through the full queue. Failed workers don't block others.

**Sandbox scope:** `src/`, `tests/` (excluding `tests/live/`), `Cargo.toml`, `Cargo.lock`, `build.rs`

**Write scope:** Assigned actor directory + `tests/` (for fixing both source bugs and test code)

**Fix rules:**
- Fix the root cause, never suppress or skip the failing test
- Never add `#[ignore]` to a failing test
- Never weaken assertions, remove expected values, or comment out test bodies
- If the root cause is in shared code outside the write scope, document it in the manifest

---

## Common Flags (all tasks)

| Flag | Description |
|------|-------------|
| `--help` | Show usage |
| `--dry-run` | Validate discovery + setup without calling the API |
| `--apply` | Write validated sandbox changes back to the real repo |
| `--max-agents N` | Concurrent agents (default `1`) |
| `--model` | Z.AI model identifier |
| `--worker-timeout-seconds N` | Per-worker kill timeout |
| `--output /path` | Custom artifact directory |

## Artifact Structure (all tasks)

```
artifacts/zai-<task>-alignment/<repo-name>-<timestamp>/
  run-config.json          # CLI args + discovery results
  sandbox-path.txt          # Sandbox location (cleaned up after run)
  report.json               # Machine-readable results
  report.md                 # Human-readable summary
  final-diff.json           # All changed files
  workers/
    <work-unit-name>/
      zai-round-01.json     # Raw API round-trip
      zai-round-02.json
      worker-output.txt     # Agent's summary
      diff.json             # Changes for this unit
      manifest.json         # (fixture-alignment) Contract inventory
```

## Architecture

```
zai-agentic-qa/
  docs-alignment/           # Docs vs source alignment
    cli.mjs
  fixture-alignment/        # REST fixture coverage alignment
    cli.mjs
  shared-ws-alignment/     # WebSocket fixture coverage alignment
    cli.mjs
  actor-messaging-conformance/  # icanact-core messaging rule enforcement
    cli.mjs
  actor-schema-conformance/    # ACTOR_SCHEMA.md conformance
    cli.mjs
  fixture-e2e-coverage/       # Fixture E2E test coverage
    cli.mjs
  test-green/                # Ensure all tests pass with all feature flags
    cli.mjs
  shared/
    plugins/                # Shared opencode plugins
  package.json
```

Each task is a standalone CLI under `<task>-alignment/cli.mjs` with its own:
- Prompt (system + user per work unit)
- Tools (file read/write/search exposed to the agent)
- Discovery logic (how work units are found)
- Concurrency pool (Promise.race-based rolling queue)
- Sandbox (isolated temp copy with scoped reads/writes)
- Validation (post-run diff authorization)
- Cleanup (sandbox deleted after run, even on error)
