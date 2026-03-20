#!/usr/bin/env node

import fs from "node:fs/promises";
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const DEFAULT_MODEL = "glm-5-turbo";
const DEFAULT_WORKER_TIMEOUT_SECONDS = 30 * 60;
const DEFAULT_API_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
const DEFAULT_MAX_AGENTS = 1;
const MAX_TOOL_ROUNDS = 256;
const DEFAULT_EXCLUDED_PATHS = [
  ".git",
  "node_modules",
  "target",
  "build",
  "dist",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
];

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  "You are a SAGA workflow E2E test engineer for a Rust project built on the icanact-core actor framework with SAGA-based distributed transactions.",
  "Your job is to ensure every SAGA participant actor has comprehensive E2E tests that exercise ALL error cases, compensating actions, and the full workflow orchestration — using the project's shared_restapi and shared_ws mock/fixture frameworks.",
  "",
  "## Why this matters",
  "SAGA workflows are mission-critical distributed transactions. Each participant can succeed or fail independently, and the system MUST handle every possible error case with proper compensating actions (rollbacks). A missing error-case test is a potential data-loss or state-inconsistency bug in production. Existing tests often cover only the happy path — your job is to fill the gaps.",
  "",
  "## SAGA architecture in this codebase",
  "- Participants implement `SagaParticipantSupport<LmdbJournal, LmdbDedupe>`",
  "- SAGA state: `inflight_saga: Option<(u64, SagaAction)>`, `pending_saga_start`, `next_saga_id: u64`",
  "- Event durability via `LmdbJournal` (write-ahead log) and `LmdbDedupe` (exactly-once delivery)",
  "- State persistence via `DurableState` (snapshot/restore on restart)",
  "- SAGA-backed actors are spawned via `open_saga_lmdb_actor` by the startup supervisor",
  "- Compensating actions reverse partial work when a downstream participant fails",
  "- Saga events are asserted in tests via `actor.take_pending_saga_events()`",
  "",
  "## What you MUST do for each SAGA participant actor",
  "",
  "### Step 1: Map the SAGA choreography",
  "1. Read `docs/ACTOR_SCHEMA.md` first for authoritative SAGA definitions",
  "2. Read the actor's `saga.rs` file to identify:",
  "   a. All `SagaAction` variants (each is a step in the SAGA)",
  "   b. All compensating actions (the reverse operations for each step)",
  "   c. The `handle_saga_action` match arms — what does each action do?",
  "   d. The `handle_saga_compensate` match arms — what does each compensate do?",
  "   e. State transitions: how does the actor state change between actions?",
  "3. Read `business_logic.rs` to understand what external calls each action triggers",
  "4. Read `messaging.rs` to understand what messages trigger SAGA start/progress",
  "5. Identify the full participant set: which other actors participate in the same SAGA? Search for shared saga IDs, correlated messages, or orchestration patterns",
  "",
  "### Step 2: Enumerate ALL error cases per participant",
  "For EACH `SagaAction` variant, identify every failure mode:",
  "",
  "A. **External dependency failures** (REST API / WebSocket):",
  "   - The shared_restapi or shared_ws call returns an error fixture (rate limit 429, auth failure 401/403, invalid symbol 400, server error 500, timeout)",
  "   - The REST/WS response is malformed or missing expected fields",
  "   - The response has an empty body or zero-length array where data is expected",
  "",
  "B. **State conflict failures**:",
  "   - The actor state is inconsistent (e.g. position already closed when trying to close again)",
  "   - Duplicate saga event received (deduplication must handle gracefully)",
  "   - Saga ID collision or replay from journal recovery",
  "",
  "C. **Compensating action failures**:",
  "   - The compensate action's external call also fails (double-failure scenario)",
  "   - State cannot be fully rolled back (partial compensation)",
  "",
  "D. **Orchestration failures**:",
  "   - SAGA coordinator crashes mid-workflow (test recovery from LmdbJournal)",
  "   - Message ordering: a compensate arrives before the original action completes",
  "",
  "### Step 3: Create or enhance E2E tests",
  "For each identified error case, create an E2E test that:",
  "1. Sets up the SAGA participant actor with initial state via Tell/Ask",
  "2. Triggers the SAGA action through actor messaging (the same code path as production)",
  "3. Uses the shared_restapi/shared_ws fixture frameworks to mock the external endpoint responses:",
  "   - `RestRequest::with_fixture_contract(id)` + `RestFixtureRequirement` for REST mocks",
  "   - `WsRequest::with_fixture_contract(id)` + `WsFixtureRequirement` for WS mocks",
  "   - The `#[cfg(test)]` code path reads fixture files from disk instead of making real calls",
  "4. Asserts the correct outcome:",
  "   - For success: domain state is correctly updated, saga event emitted",
  "   - For error: compensating action fires, state is rolled back, error is propagated correctly",
  "   - For compensate failure: error is logged/handled, state reflects partial compensation",
  "5. Verifies saga event emission via `actor.take_pending_saga_events()` where applicable",
  "",
  "### Step 4: Test the full SAGA workflow end-to-end",
  "If multiple participant actors are in scope, create at least one integration test that:",
  "1. Spawns all participants",
  "2. Mocks all external endpoints (shared_restapi + shared_ws fixtures for ALL participants)",
  "3. Triggers the SAGA start from the coordinator/orchestrator",
  "4. Verifies the full happy path: all actions complete, all state transitions correct",
  "5. Tests at least one partial failure: one participant fails, verify compensating actions fire for earlier participants",
  "",
  "## Test structure",
  "Tests go in `tests/contracts/<actor_name>_saga_e2e.rs` (or `tests/live/` or `tests/execution/` if that matches the project convention). Follow the exact pattern of existing tests in the `tests/` directory.",
  "",
  "```rust",
  "// Happy path",
  "#[test]",
  "#[ignore = \"requires fixture files\"]",
  "fn saga_<action_name>_success_completes_and_updates_state() { ... }",
  "",
  "// External dependency failure — triggers compensating action",
  "#[test]",
  "#[ignore = \"requires fixture files\"]",
  "fn saga_<action_name>_rest_error_triggers_compensate() { ... }",
  "",
  "// WS error during subscription",
  "#[test]",
  "#[ignore = \"requires fixture files\"]",
  "fn saga_<action_name>_ws_error_triggers_compensate() { ... }",
  "",
  "// Compensating action also fails",
  "#[test]",
  "#[ignore = \"requires fixture files\"]",
  "fn saga_<action_name>_compensate_failure_handling() { ... }",
  "",
  "// Malformed response from external dependency",
  "#[test]",
  "#[ignore = \"requires fixture files\"]",
  "fn saga_<action_name>_malformed_response_error_handling() { ... }",
  "",
  "// State conflict / duplicate saga",
  "#[test]",
  "#[ignore = \"requires fixture files\"]",
  "fn saga_<action_name>_duplicate_event_deduplication() { ... }",
  "",
  "// Full workflow — all participants succeed",
  "#[test]",
  "#[ignore = \"requires fixture files\"]",
  "fn saga_full_workflow_happy_path() { ... }",
  "",
  "// Full workflow — partial failure with compensation",
  "#[test]",
  "#[ignore = \"requires fixture files\"]",
  "fn saga_full_workflow_partial_failure_compensates() { ... }",
  "```",
  "",
  "## How fixture mocking works for SAGA tests",
  "The project uses a `#[cfg(test)]` code path where `execute_live_query` reads fixture files from disk instead of making real HTTP/WS calls. This means:",
  "",
  "1. For REST-dependent saga actions: ensure a `RestFixtureRequirement { success_path, error_path }` is registered for the contract ID used in the saga action's business logic. The test path automatically reads the fixture.",
  "2. For WS-dependent saga actions: ensure a `WsFixtureRequirement { messages_path, error_path }` is registered. The WS fixture gate serves frames from the fixture file.",
  "3. If a saga action's business logic calls a REST endpoint that doesn't have a fixture registered, you may need to ADD the fixture registration and fixture files (same pattern as the fixture-alignment task).",
  "4. To test error paths: ensure the error fixture file exists and contains a realistic error response. The business logic should handle the error and trigger the compensating action.",
  "",
  "## Missing fixture handling",
  "If a saga action's external call lacks registered fixtures:",
  "1. Add `RestFixtureRequirement { success_path, error_path }` or `WsFixtureRequirement { messages_path, error_path }` to the contract registry",
  "2. Create the fixture JSON files under the actor's `test/fixtures/` directory",
  "3. Wire `with_fixture_contract(id)` into the request if it's missing",
  "4. Follow the exact same provenance envelope format as existing fixtures (`source: \"live_capture\"`, `captured_at_ms`, `capture_command`, `exchange_env`, etc.)",
  "",
  "## Manifest format",
  "Write via `write_manifest` with this structure:",
  "```json",
  "{",
  '  "saga_actions": [',
  "    {",
  '      "action_name": "<SagaAction variant>",',
  '      "participant": "<actor_name>",',
  '      "file": "src/actors/.../saga.rs",',
  '      "error_cases": [',
  "        {",
  '          "case": "rest_error_rate_limit",',
  '          "test_exists": true | false,',
  '          "test_created": true | false,',
  '          "test_function": "saga_<action>_rest_error...",',
  '          "fixture_contract_id": "<contract_id>"',
  "        },",
  "        {",
  '          "case": "compensate_failure",',
  '          "test_exists": true | false,',
  '          "test_created": true | false,',
  '          "test_function": "saga_<action>_compensate_failure...",',
  '          "fixture_contract_id": null',
  "        }",
  "      ],",
  '      "compensating_action": "<compensate variant>",',
  '      "compensate_error_cases_tested": true | false',
  "    }",
  "  ],",
  '  "workflow_tests": [',
  "    {",
  '      "test_name": "saga_full_workflow_happy_path",',
  '      "test_file": "tests/contracts/..._saga_e2e.rs",',
  '      "participants": ["<actor1>", "<actor2>"],',
  '      "outcome": "all_succeed"',
  "    }",
  "  ],",
  '  "fixtures_created": ["<fixture_path>", ...],',
  '  "contracts_registered": ["<contract_id>", ...],',
  '  "tests_created": ["<test_file>", ...]',
  "}",
  "```",
  "",
  "## Actor-adapter architecture (shared_restapi / shared_ws integration)",
  "shared_restapi and shared_ws are stateless IO adapters — the actor owns all domain logic, state, and messaging.",
  "",
  "**No code in an actor may ever create its own Tokio runtime.** The icanact-core runtime is the sole executor.",
  "",
  "**Actors with I/O-bound work (WS connections, REST calls, DB queries) MUST use `local::CustomRunnerActor` + `spawn_with_custom_runner`** instead of bridging from sync `Tell` with `block_in_place`.",
  "",
  "**No shared-state concurrency primitives (Mutex, RwLock, Cell, RefCell, AtomicCell, etc.) are allowed anywhere in actor code, including tests.** Tests must exercise actors through the same messaging paths as production (Tell/Ask/PubSub/Broadcast).",
  "",
  "- All cross-actor traffic goes through icanact-core traits (Tell/Ask/PubSub/Broadcast).",
  "- Parse REST/WS responses into concrete domain structs immediately and mutate actor state directly; don't stash raw JSON or spawn helper tasks.",
  "- All JSON parsing/deserialization MUST use `sonic_rs` — `serde_json` is forbidden in actor code.",
  "- WS actors must use lazy-decode: forward raw WS messages via Tell/PubSub to downstream consumers; the consumer does the `sonic_rs::from_str` decode.",
  "",
  "## Rules",
  "- This is a FIX task — create tests, add missing fixtures, wire missing `with_fixture_contract()` calls, register missing contracts",
  "- Do NOT modify production business logic — only add/enhance tests and test infrastructure (fixtures, contracts, mocks)",
  "- Do NOT modify `docs/ACTOR_SCHEMA.md`",
  "- Do NOT skip error cases — every SagaAction variant MUST have at least: success, external-error-triggers-compensate, compensate-failure tests",
  "- Do NOT create tests that only deserialize JSON — tests MUST exercise the full business logic through the SAGA action handler",
  "- Tests MUST use actor messaging (Tell/Ask/PubSub) — never shared state",
  "- Tests MUST be `#[ignore]` integration tests since they depend on fixture files",
  "- Fixture files MUST follow the same provenance envelope format as existing fixtures",
  "- After all tests and fixtures are written, run `cargo_check` to verify compilation",
  "- If cargo_check fails, fix the errors and run again until clean",
  "Use the provided file tools to inspect code and make edits.",
  "Do the work now. Do not ask follow-up questions.",
].join("\n");

function buildUserPrompt(actorDir, actorName) {
  return [
    `You are creating SAGA workflow E2E tests for the actor module: ${actorDir}`,
    `Actor name: ${actorName}`,
    "",
    "This actor is a SAGA participant. Your job is to:",
    "1. Map its SAGA actions and compensating actions",
    "2. Enumerate ALL possible error cases for each action",
    "3. Create comprehensive E2E tests using the shared_restapi/shared_ws fixture mock frameworks",
    "4. Ensure every error path has a test that exercises it through the full business logic",
    "",
    "Steps:",
    "1. Read docs/ACTOR_SCHEMA.md for authoritative SAGA definitions",
    "2. Read the actor's saga.rs to map all SagaAction variants and compensating actions",
    "3. Read business_logic.rs to understand external calls per action",
    "4. Check for existing registered fixtures (RestFixtureRequirement, WsFixtureRequirement)",
    "5. Check for existing tests under tests/ that exercise saga paths",
    "6. For each SagaAction, create tests for: success, external error (triggers compensate), compensate failure, malformed response",
    "7. If fixtures are missing for saga-related external calls, create them (with provenance envelopes)",
    "8. If contract registrations are missing, add them",
    "9. Create at least one full-workflow integration test if multiple participants are reachable",
    "10. Run cargo_check to verify compilation",
    "11. Call write_manifest with full coverage report",
    "",
    "Do the work now.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
  return [
    "Usage:",
    "  npm run saga:e2e -- --repo /absolute/path/to/repo",
    "    [--actors actor_dir_1,actor_dir_2]",
    "    [--max-agents N]",
    "    [--output /path/to/artifacts]",
    "    [--model glm-5]",
    "    [--worker-timeout-seconds N]",
    "    [--apply] [--dry-run]",
    "",
    "Defaults:",
    "  --actors auto-discovered (actors with SAGA participant support)",
    `  --max-agents ${DEFAULT_MAX_AGENTS}`,
    `  --model ${DEFAULT_MODEL}`,
    `  --worker-timeout-seconds ${DEFAULT_WORKER_TIMEOUT_SECONDS}`,
    "  --apply write sandbox tests back to the real repo after validation",
    "  --output ./artifacts/zai-saga-workflow-e2e/<repo-name>-<timestamp>",
    "  requires Z_AI_API_KEY in the environment",
    "",
    "This task creates SAGA workflow E2E tests that exercise ALL error cases,",
    "compensating actions, and the full workflow orchestration using the",
    "shared_restapi and shared_ws fixture/mock frameworks.",
  ].join("\n");
}

function parseArgs(argv) {
  const result = {
    actors: null,
    apply: false,
    dryRun: false,
    maxAgents: DEFAULT_MAX_AGENTS,
    model: DEFAULT_MODEL,
    output: null,
    repo: null,
    workerTimeoutSeconds: DEFAULT_WORKER_TIMEOUT_SECONDS,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }
    if (arg === "--apply") {
      result.apply = true;
      continue;
    }
    if (arg === "--dry-run") {
      result.dryRun = true;
      continue;
    }
    if (arg === "--repo") {
      result.repo = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--actors") {
      result.actors = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--max-agents") {
      result.maxAgents = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--model") {
      result.model = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--output") {
      result.output = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--worker-timeout-seconds") {
      result.workerTimeoutSeconds = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!result.help && !result.repo) {
    throw new Error("Missing required argument: --repo");
  }
  if (!Number.isFinite(result.workerTimeoutSeconds) || result.workerTimeoutSeconds <= 0) {
    throw new Error(`Invalid --worker-timeout-seconds: ${String(result.workerTimeoutSeconds)}`);
  }
  if (!Number.isInteger(result.maxAgents) || result.maxAgents < 1) {
    throw new Error(`Invalid --max-agents: ${String(result.maxAgents)} (must be an integer >= 1)`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function ensureDirectoryExists(directory, label) {
  let stats;
  try {
    stats = await fs.stat(directory);
  } catch {
    throw new Error(`${label} does not exist: ${directory}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`${label} is not a directory: ${directory}`);
  }
}

function execCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) { resolve({ stdout, stderr, code }); return; }
      reject(new Error(`${command} exited with code ${code}: ${stderr || stdout}`));
    });
  });
}

function repoNameFromPath(repoPath) {
  return path.basename(path.resolve(repoPath)).replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function timestamp() {
  return new Date().toISOString().replaceAll(":", "").replaceAll(".", "").replace("T", "-").replace("Z", "");
}

const ANSI = { reset: "\u001b[0m", yellow: "\u001b[33m", red: "\u001b[31m", green: "\u001b[32m", cyan: "\u001b[36m", magenta: "\u001b[35m", blue: "\u001b[34m" };

const WORKER_COLORS = [ANSI.cyan, ANSI.magenta, ANSI.green, ANSI.blue, ANSI.yellow];
const workerColorMap = new Map();
let workerColorIndex = 0;

function getWorkerColor(workerLabel) {
  if (!workerLabel) return "";
  if (!workerColorMap.has(workerLabel)) {
    workerColorMap.set(workerLabel, WORKER_COLORS[workerColorIndex % WORKER_COLORS.length]);
    workerColorIndex += 1;
  }
  return workerColorMap.get(workerLabel);
}

function colorize(message, color) {
  return `${color}${message}${ANSI.reset}`;
}

function formatTimestampLabel() {
  return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

function formatLogPrefix(workerLabel) {
  const ts = `[${formatTimestampLabel()}]`;
  if (workerLabel) {
    const labelColor = getWorkerColor(workerLabel);
    return `${ts} ${colorize(`[${workerLabel}]`, labelColor)} `;
  }
  return `${ts} `;
}

function logProgress(message, workerLabel) {
  process.stdout.write(`${formatLogPrefix(workerLabel)}${message}\n`);
}

function logWarning(message, workerLabel) {
  process.stdout.write(colorize(`${formatLogPrefix(workerLabel)}${message}\n`, ANSI.yellow));
}

function logError(message, workerLabel) {
  process.stderr.write(colorize(`${formatLogPrefix(workerLabel)}${message}\n`, ANSI.red));
}

function normalizeRelativePath(value) {
  return value.replaceAll("\\", "/").replace(/\/+$/, "");
}

function summarizeText(text, maxLength = 160) {
  const flattened = String(text).replace(/\s+/g, " ").trim();
  if (!flattened) return "no text";
  if (flattened.length <= maxLength) return flattened;
  return `${flattened.slice(0, maxLength - 1)}...`;
}

function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          if (typeof part.text === "string") return part.text;
          if (typeof part.content === "string") return part.content;
        }
        return "";
      })
      .join("\n");
  }
  return content == null ? "" : String(content);
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// Sandbox & file listing
// ---------------------------------------------------------------------------

async function listFilesRecursive(rootDirectory, ignoredRelativePrefixes = []) {
  const files = [];
  const normalizedIgnoredPrefixes = ignoredRelativePrefixes.map(normalizeRelativePath);

  async function walk(currentDirectory) {
    let entries;
    try {
      entries = await fs.readdir(currentDirectory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolutePath = path.join(currentDirectory, entry.name);
      const relativePath = path.relative(rootDirectory, absolutePath).replaceAll("\\", "/");
      if (normalizedIgnoredPrefixes.some((prefix) => relativePath === prefix || relativePath.startsWith(`${prefix}/`))) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  }

  await walk(rootDirectory);
  files.sort();
  return files;
}

function shouldIgnoreRelativePath(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  return DEFAULT_EXCLUDED_PATHS.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

async function stripMissingWorkspaceMembers(sandboxRepoPath) {
  const tomlPath = path.join(sandboxRepoPath, "Cargo.toml");
  if (!(await pathExists(tomlPath))) return;
  let toml = await fs.readFile(tomlPath, "utf8");

  toml = toml.replace(/\[patch[^\]]*\][^\[]*/g, "");

  const memberMatches = toml.match(/members\s*=\s*\[((?:[^\[\]]|\[(?:[^\[\]]|\[[^\[\]]*\])*\])*)\]/s);
  if (memberMatches) {
    const rawMembers = memberMatches[1];
    const members = rawMembers
      .split(",")
      .map(m => m.trim().replace(/^["']|["']$/g, "").replace(/\s+/g, " "))
      .filter(Boolean);

    const validMembers = [];
    for (const m of members) {
      if (await pathExists(path.join(sandboxRepoPath, m))) {
        validMembers.push(m);
      }
    }
    if (validMembers.length !== members.length) {
      if (validMembers.length === 0) {
        toml = toml.replace(/members\s*=\s*\[[^\]]*(?:\[[^\]]*\][^\]]*)*\]\s*/s, "");
      } else {
        const newBlock = `members = [\n${validMembers.map(m => `    "${m}"`).join(",\n")},\n]`;
        toml = toml.replace(/members\s*=\s*\[[^\]]*(?:\[[^\]]*\][^\]]*)*\]\s*/s, `${newBlock}\n`);
      }
    }
  }

  if (toml.includes("exclude =")) {
    toml = toml.replace(/exclude\s*=\s*\[[^\]]*(?:\[[^\]]*\][^\]]*)*\]\s*/s, "");
  }

  toml = toml.replace(/\n{3,}/g, "\n\n");

  await fs.writeFile(tomlPath, toml, "utf8");
}

async function createSandbox(repoPath, outputDirectory) {
  const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "zai-saga-workflow-e2e-sandbox-"));
  const sandboxPath = path.join(sandboxRoot, repoNameFromPath(repoPath));
  await fs.mkdir(sandboxPath, { recursive: true });

  for (const root of ["src/actors", "src", "tests", "vendor"]) {
    const sourcePath = path.join(repoPath, root);
    if (!(await pathExists(sourcePath))) continue;
    const destPath = path.join(sandboxPath, root);
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.cp(sourcePath, destPath, {
      recursive: true,
      verbatimSymlinks: true,
      filter(source) {
        if (statSync(source).isSymbolicLink()) return false;
        const relative = path.relative(sourcePath, source);
        if (!relative) return true;
        return !shouldIgnoreRelativePath(relative);
      },
    });
  }

  const cargoToml = path.join(repoPath, "Cargo.toml");
  if (await pathExists(cargoToml)) {
    await fs.copyFile(cargoToml, path.join(sandboxPath, "Cargo.toml"));
    await stripMissingWorkspaceMembers(sandboxPath);
  }

  const cargoLock = path.join(repoPath, "Cargo.lock");
  if (await pathExists(cargoLock)) {
    await fs.copyFile(cargoLock, path.join(sandboxPath, "Cargo.lock"));
  }

  const docsDir = path.join(repoPath, "docs");
  if (await pathExists(docsDir)) {
    await fs.cp(docsDir, path.join(sandboxPath, "docs"), {
      recursive: true,
      verbatimSymlinks: true,
      filter(source) {
        if (statSync(source).isSymbolicLink()) return false;
        return !shouldIgnoreRelativePath(path.relative(docsDir, source));
      },
    });
  }

  const buildRs = path.join(repoPath, "build.rs");
  if (await pathExists(buildRs)) {
    await fs.copyFile(buildRs, path.join(sandboxPath, "build.rs"));
  }

  const cargoConfigDir = path.join(repoPath, ".cargo");
  if (await pathExists(cargoConfigDir)) {
    await fs.cp(cargoConfigDir, path.join(sandboxPath, ".cargo"), {
      recursive: true,
      verbatimSymlinks: true,
    });
  }

  await fs.writeFile(path.join(outputDirectory, "sandbox-path.txt"), `${sandboxPath}\n`, "utf8");
  return { sandboxRoot, sandboxPath };
}

async function buildOutputDirectory(repoPath, explicitOutput) {
  const baseDirectory = explicitOutput
    ? path.resolve(explicitOutput)
    : path.resolve("artifacts", "zai-saga-workflow-e2e", `${repoNameFromPath(repoPath)}-${timestamp()}`);
  await fs.mkdir(baseDirectory, { recursive: true });
  return baseDirectory;
}

// ---------------------------------------------------------------------------
// Actor discovery
// ---------------------------------------------------------------------------

async function execRg(args, cwd) {
  try {
    return await execCapture("rg", args, { cwd });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("code 1") || message.includes("code 2")) return { stdout: "", stderr: "", code: 0 };
    throw error;
  }
}

async function discoverActors(repoPath) {
  const srcActorsDir = path.join(repoPath, "src", "actors");
  if (!(await pathExists(srcActorsDir))) {
    throw new Error("src/actors/ directory does not exist in the repository");
  }

  const patterns = [
    "SagaParticipantSupport",
    "handle_saga_action",
    "handle_saga_compensate",
  ];
  const actorFiles = new Set();

  for (const pattern of patterns) {
    const result = await execRg(["-l", "-g", "*.rs", pattern, srcActorsDir], repoPath);
    if (result.stdout.trim()) {
      for (const line of result.stdout.trim().split("\n")) {
        actorFiles.add(line);
      }
    }
  }

  const actorDirs = new Set();
  for (const filePath of actorFiles) {
    const absolutePath = path.resolve(filePath);

    let candidate = absolutePath;
    while (candidate.length > srcActorsDir.length) {
      const modRs = path.join(candidate, "mod.rs");
      const sagaRs = path.join(candidate, "saga.rs");
      if (await pathExists(modRs) && await pathExists(sagaRs)) {
        const rel = normalizeRelativePath(path.relative(repoPath, candidate));
        actorDirs.add(rel);
        break;
      }
      candidate = path.dirname(candidate);
    }
  }

  return [...actorDirs].sort();
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function buildTools() {
  return [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a UTF-8 text file.",
        parameters: {
          type: "object",
          properties: {
            file_path: { type: "string", description: "Relative file path to read." },
          },
          required: ["file_path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_files",
        description: "List files under a relative directory.",
        parameters: {
          type: "object",
          properties: {
            directory_path: { type: "string", description: "Relative directory path to inspect." },
          },
          required: ["directory_path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search_files",
        description: "Search file contents with ripgrep under an allowed relative path.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Regular expression or literal text to search for." },
            directory_path: { type: "string", description: "Relative directory path to search under." },
          },
          required: ["query", "directory_path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description: "Overwrite a file with updated content. Use for creating test files in tests/contracts/, tests/live/, tests/execution/, or for creating fixture files under actor test/fixtures/ directories.",
        parameters: {
          type: "object",
          properties: {
            file_path: { type: "string", description: "Relative file path to write." },
            content: { type: "string", description: "Full replacement file content." },
          },
          required: ["file_path", "content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "create_directory",
        description: "Create a directory (including parents) if it does not exist.",
        parameters: {
          type: "object",
          properties: {
            directory_path: { type: "string", description: "Relative directory path to create." },
          },
          required: ["directory_path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "cargo_check",
        description: "Run `cargo check` in the sandbox to verify the code compiles. Call this as your FINAL step after all tests and fixtures are written. If it reports errors, fix them and run again until clean.",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    },
    {
      type: "function",
      function: {
        name: "write_manifest",
        description: "Write the SAGA coverage manifest. The file is written automatically to your output directory. Call this at the END of your work.",
        parameters: {
          type: "object",
          properties: {
            saga_actions: {
              type: "array",
              description: "List of SAGA action coverage entries.",
              items: {
                type: "object",
                properties: {
                  action_name: { type: "string" },
                  participant: { type: "string" },
                  file: { type: "string" },
                  compensating_action: { type: "string" },
                  compensate_error_cases_tested: { type: "boolean" },
                  error_cases: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        case: { type: "string" },
                        test_exists: { type: "boolean" },
                        test_created: { type: "boolean" },
                        test_function: { type: "string" },
                        fixture_contract_id: { type: "string" },
                      },
                      required: ["case", "test_exists", "test_created"],
                    },
                  },
                },
                required: ["action_name", "participant", "file", "error_cases"],
              },
            },
            workflow_tests: {
              type: "array",
              description: "List of full-workflow integration tests.",
              items: {
                type: "object",
                properties: {
                  test_name: { type: "string" },
                  test_file: { type: "string" },
                  participants: { type: "array", items: { type: "string" } },
                  outcome: { type: "string" },
                },
                required: ["test_name", "test_file"],
              },
            },
            fixtures_created: {
              type: "array",
              description: "List of fixture files created.",
              items: { type: "string" },
            },
            contracts_registered: {
              type: "array",
              description: "List of contract IDs registered.",
              items: { type: "string" },
            },
            tests_created: {
              type: "array",
              description: "List of test files created.",
              items: { type: "string" },
            },
          },
          required: ["saga_actions"],
        },
      },
    },
  ];
}

function toAbsoluteSandboxPath(sandboxRepoPath, relativePath) {
  return path.resolve(sandboxRepoPath, normalizeRelativePath(relativePath));
}

function ensureAllowedPath(relativePath) {
  let normalized = normalizeRelativePath(relativePath);

  if (normalized === "." || normalized === "./" || normalized === "") {
    normalized = "src";
  }

  if (
    normalized.startsWith("src/") ||
    normalized === "src" ||
    normalized.startsWith("docs/") ||
    normalized === "docs" ||
    normalized.startsWith("tests/") ||
    normalized === "tests" ||
    normalized === "Cargo.toml" ||
    normalized === "build.rs"
  ) {
    return normalized;
  }

  throw new Error(`Access denied for ${relativePath} (outside allowed scope: src/, docs/, tests/, Cargo.toml, build.rs)`);
}

async function executeToolCall(toolCall, context) {
  const { sandboxRepoPath, actorDir, workerOutputDir, workerLabel } = context;
  const name = toolCall.function.name;
  const args = JSON.parse(toolCall.function.arguments || "{}");

  if (name === "read_file") {
    const relativePath = ensureAllowedPath(args.file_path);
    const absolutePath = toAbsoluteSandboxPath(sandboxRepoPath, relativePath);
    const content = await fs.readFile(absolutePath, "utf8");
    logProgress(`tool:read_file ${relativePath}`, workerLabel);
    return { ok: true, file_path: relativePath, content };
  }

  if (name === "list_files") {
    const relativePath = ensureAllowedPath(args.directory_path);
    const absolutePath = toAbsoluteSandboxPath(sandboxRepoPath, relativePath);
    const entries = await listFilesRecursive(absolutePath, DEFAULT_EXCLUDED_PATHS);
    logProgress(`tool:list_files ${relativePath}`, workerLabel);
    return { ok: true, directory_path: relativePath, files: entries };
  }

  if (name === "search_files") {
    const relativePath = ensureAllowedPath(args.directory_path);
    const absolutePath = toAbsoluteSandboxPath(sandboxRepoPath, relativePath);
    const result = await execRg(["-n", "--hidden", "--no-follow", args.query, absolutePath], sandboxRepoPath);
    logProgress(`tool:search_files ${relativePath} query=${JSON.stringify(args.query)}`, workerLabel);
    return {
      ok: true,
      directory_path: relativePath,
      matches: result.stdout.trim() ? result.stdout.trim().split("\n") : [],
    };
  }

  if (name === "write_file") {
    const normalized = normalizeRelativePath(args.file_path);
    const actorNorm = normalizeRelativePath(actorDir);
    const isActorDir = normalized === actorNorm || normalized.startsWith(`${actorNorm}/`);
    const isTestsContracts = normalized.startsWith("tests/contracts/") || normalized === "tests/contracts";
    const isTestsLive = normalized.startsWith("tests/live/") || normalized === "tests/live";
    const isTestsExecution = normalized.startsWith("tests/execution/") || normalized === "tests/execution";
    const isTestsE2e = normalized.startsWith("tests/e2e/") || normalized === "tests/e2e";
    const isTestFixture = normalized.includes("test/fixtures/");
    if (!isActorDir && !isTestsContracts && !isTestsLive && !isTestsExecution && !isTestsE2e && !isTestFixture) {
      throw new Error(`Write access denied for ${args.file_path} (must be under ${actorDir}, tests/contracts/, tests/live/, tests/execution/, tests/e2e/, or a test/fixtures/ directory)`);
    }
    const absolutePath = toAbsoluteSandboxPath(sandboxRepoPath, normalized);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    const before = (await pathExists(absolutePath)) ? await fs.readFile(absolutePath, "utf8") : "";
    await fs.writeFile(absolutePath, args.content, "utf8");
    logWarning(`tool:write_file ${normalized}`, workerLabel);
    return { ok: true, file_path: normalized, changed: before !== args.content, created: !before };
  }

  if (name === "create_directory") {
    const normalized = normalizeRelativePath(args.directory_path);
    const actorNorm = normalizeRelativePath(actorDir);
    const isActorDir = normalized === actorNorm || normalized.startsWith(`${actorNorm}/`);
    const isTestsContracts = normalized.startsWith("tests/contracts/") || normalized === "tests/contracts";
    const isTestsLive = normalized.startsWith("tests/live/") || normalized === "tests/live";
    const isTestsExecution = normalized.startsWith("tests/execution/") || normalized === "tests/execution";
    const isTestsE2e = normalized.startsWith("tests/e2e/") || normalized === "tests/e2e";
    if (!isActorDir && !isTestsContracts && !isTestsLive && !isTestsExecution && !isTestsE2e) {
      throw new Error(`Write access denied for ${args.directory_path} (must be under ${actorDir}, tests/contracts/, tests/live/, tests/execution/, or tests/e2e/)`);
    }
    const absolutePath = toAbsoluteSandboxPath(sandboxRepoPath, normalized);
    await fs.mkdir(absolutePath, { recursive: true });
    logProgress(`tool:create_directory ${normalized}`, workerLabel);
    return { ok: true, directory_path: normalized };
  }

  if (name === "cargo_check") {
    logProgress(`tool:cargo_check`, workerLabel);
    const result = await execCapture("cargo", ["check", "--message-format=short"], { cwd: sandboxRepoPath });
    logProgress(`tool:cargo_check ${result.code === 0 ? "passed" : "errors found"}`, workerLabel);
    return { ok: result.code === 0, stderr: result.stderr, stdout: result.stdout, code: result.code };
  }

  if (name === "write_manifest") {
    const manifestPath = path.join(workerOutputDir, "manifest.json");
    await fs.mkdir(workerOutputDir, { recursive: true });
    await writeJson(manifestPath, {
      actor_dir: actorDir,
      saga_actions: args.saga_actions ?? [],
      workflow_tests: args.workflow_tests ?? [],
      fixtures_created: args.fixtures_created ?? [],
      contracts_registered: args.contracts_registered ?? [],
      tests_created: args.tests_created ?? [],
    });
    const actions = args.saga_actions ?? [];
    const allCases = actions.reduce((sum, a) => sum + (a.error_cases?.length ?? 0), 0);
    const created = actions.reduce((sum, a) => sum + (a.error_cases?.filter((c) => c.test_created).length ?? 0), 0);
    if (allCases > 0) {
      logWarning(`SAGA ACTIONS: ${actions.length} action(s), ${created}/${allCases} error cases tested`, workerLabel);
    } else {
      logProgress(`no SAGA actions found in ${actorDir}`, workerLabel);
    }
    return { ok: true, manifest_path: manifestPath };
  }

  throw new Error(`Unsupported tool call: ${name}`);
}

// ---------------------------------------------------------------------------
// API communication
// ---------------------------------------------------------------------------

async function callZaiChat({ apiKey, model, messages, tools, timeoutMs, outputDirectory, round }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${DEFAULT_API_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Accept-Language": "en-US,en",
      },
      body: JSON.stringify({
        model,
        messages,
        tools,
        tool_choice: "auto",
        parallel_tool_calls: false,
        temperature: 0.1,
        stream: false,
      }),
      signal: controller.signal,
    });

    const text = await response.text();
    await fs.writeFile(path.join(outputDirectory, `zai-round-${String(round).padStart(2, "0")}.json`), `${text}\n`, "utf8");
    if (!response.ok) {
      throw new Error(`Z.AI request failed with ${response.status}: ${text}`);
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveApiKey() {
  if (process.env.Z_AI_API_KEY) return process.env.Z_AI_API_KEY.trim();
  const shell = process.env.SHELL || "/bin/zsh";
  try {
    const result = await execCapture(shell, ["-lic", "printenv Z_AI_API_KEY"]);
    const value = result.stdout.trim();
    if (value) return value;
  } catch { /* fall through */ }
  throw new Error("Missing Z_AI_API_KEY. Export it in the current shell or configure it in your shell startup that defines the opencode token.");
}

function maskSecret(secret) {
  const value = String(secret || "").trim();
  if (value.length <= 8) return "*".repeat(value.length);
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

async function runWorker(context) {
  const { apiKey, model, outputDirectory, sandboxRepoPath, actorDir, actorName, workerTimeoutMs, workerLabel } = context;
  const tools = buildTools();
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildUserPrompt(actorDir, actorName) },
  ];

  const startedAt = Date.now();
  for (let round = 1; round <= MAX_TOOL_ROUNDS; round += 1) {
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= workerTimeoutMs) {
      throw new Error(`Timed out waiting for worker after ${Math.round(workerTimeoutMs / 1000)}s.`);
    }

    logProgress(`model round ${round}`, workerLabel);
    const response = await callZaiChat({
      apiKey,
      model,
      messages,
      tools,
      timeoutMs: Math.max(30000, workerTimeoutMs - elapsedMs),
      outputDirectory,
      round,
    });

    const choice = response.choices?.[0];
    const message = choice?.message;
    if (!message) {
      throw new Error(`Z.AI response did not contain a message in round ${round}.`);
    }

    messages.push({
      role: "assistant",
      content: message.content ?? "",
      tool_calls: message.tool_calls,
    });

    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      for (const toolCall of message.tool_calls) {
        const result = await executeToolCall(toolCall, { sandboxRepoPath, actorDir, workerOutputDir: outputDirectory, workerLabel });
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        });
      }
      continue;
    }

    const finalText = normalizeContent(message.content);
    logProgress(`completed in ${Math.round((Date.now() - startedAt) / 1000)}s`, workerLabel);
    return finalText;
  }

  throw new Error(`Worker exceeded ${MAX_TOOL_ROUNDS} model rounds without finishing.`);
}

// ---------------------------------------------------------------------------
// Concurrency pool
// ---------------------------------------------------------------------------

function slotSummary(inFlight, pending, maxAgents) {
  return `(slots ${inFlight.size}/${maxAgents} active, ${pending.length} pending)`;
}

async function runAllWorkers({ actors, apiKey, model, sandboxRepoPath, outputDirectory, workerTimeoutMs, maxAgents }) {
  const workersDir = path.join(outputDirectory, "workers");
  await fs.mkdir(workersDir, { recursive: true });
  const results = [];
  const pending = [...actors];
  const inFlight = new Map();

  while (pending.length > 0 || inFlight.size > 0) {
    while (pending.length > 0 && inFlight.size < maxAgents) {
      const actorDir = pending.shift();
      const actorName = path.basename(actorDir);
      const workerLabel = actorName;
      const workerDir = path.join(workersDir, actorName);
      await fs.mkdir(workerDir, { recursive: true });

      inFlight.set(actorDir, null);
      logProgress(`started for ${actorDir} ${slotSummary(inFlight, pending, maxAgents)}`, workerLabel);

      const promise = runWorker({
        apiKey,
        model,
        outputDirectory: workerDir,
        sandboxRepoPath,
        actorDir,
        actorName,
        workerTimeoutMs,
        workerLabel,
      })
        .then((summary) => {
          logProgress(`finished ${slotSummary(inFlight, pending, maxAgents)}`, workerLabel);
          return { actorDir, actorName, workerLabel, status: "fulfilled", summary };
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          logError(`failed: ${message} ${slotSummary(inFlight, pending, maxAgents)}`, workerLabel);
          return { actorDir, actorName, workerLabel, status: "rejected", error: message };
        });

      inFlight.set(actorDir, promise);
    }

    if (inFlight.size > 0) {
      const settled = await Promise.race(inFlight.values());
      inFlight.delete(settled.actorDir);
      results.push(settled);

      if (settled.status === "fulfilled") {
        const workerDir = path.join(workersDir, settled.workerLabel);
        await fs.writeFile(path.join(workerDir, "worker-output.txt"), `${settled.summary}\n`, "utf8");
        process.stdout.write(`\n${colorize(`[${settled.workerLabel}]`, ANSI.green)} ${settled.summary.trim()}\n\n`);
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Manifests & report
// ---------------------------------------------------------------------------

async function loadManifests(outputDirectory, workerResults) {
  const manifests = [];
  const workersDir = path.join(outputDirectory, "workers");

  for (const result of workerResults) {
    if (result.status !== "fulfilled") continue;
    const manifestPath = path.join(workersDir, result.actorName, "manifest.json");
    if (await pathExists(manifestPath)) {
      const content = await fs.readFile(manifestPath, "utf8");
      try {
        manifests.push(JSON.parse(content));
      } catch {
        logWarning(`malformed manifest for ${result.actorName}`, result.workerLabel);
      }
    } else {
      logWarning(`no manifest.json produced for ${result.actorName}`, result.workerLabel);
    }
  }

  return manifests;
}

async function diffDirectories(originalRoot, sandboxRoot, scopeDirs) {
  const diffs = [];

  for (const scopeDir of scopeDirs) {
    const originalScope = path.join(originalRoot, scopeDir);
    const sandboxScope = path.join(sandboxRoot, scopeDir);

    if (!(await pathExists(originalScope)) && !(await pathExists(sandboxScope))) continue;

    let originalFiles = [];
    let sandboxFiles = [];
    try { originalFiles = (await pathExists(originalScope)) ? await listFilesRecursive(originalScope, DEFAULT_EXCLUDED_PATHS) : []; } catch { /* skip */ }
    try { sandboxFiles = (await pathExists(sandboxScope)) ? await listFilesRecursive(sandboxScope, DEFAULT_EXCLUDED_PATHS) : []; } catch { /* skip */ }

    const allFiles = new Set([...originalFiles, ...sandboxFiles]);
    for (const relativeFile of [...allFiles].sort()) {
      const originalPath = path.join(originalScope, relativeFile);
      const sandboxPath = path.join(sandboxScope, relativeFile);
      const [originalExists, sandboxExists] = await Promise.all([pathExists(originalPath), pathExists(sandboxPath)]);

      let before = "";
      let after = "";
      try { if (originalExists) before = await fs.readFile(originalPath, "utf8"); } catch { /* skip */ }
      try { if (sandboxExists) after = await fs.readFile(sandboxPath, "utf8"); } catch { /* skip */ }
      if (before === after) continue;

      const fullPath = `${scopeDir}/${relativeFile}`;
      diffs.push({ file: fullPath, before, after });
    }
  }

  return diffs;
}

function buildAggregatedReport({ repoPath, model, workerTimeoutSeconds, maxAgents, actorDirs, workerResults, manifests, finalDiff }) {
  const ok = workerResults.filter((r) => r.status === "fulfilled");
  const failed = workerResults.filter((r) => r.status === "rejected");
  const allActions = manifests.reduce((sum, m) => sum + (m.saga_actions?.length ?? 0), 0);
  const allErrorCases = manifests.reduce((sum, m) => sum + (m.saga_actions?.reduce((s, a) => s + (a.error_cases?.length ?? 0), 0) ?? 0), 0);
  const testedCases = manifests.reduce((sum, m) => sum + (m.saga_actions?.reduce((s, a) => s + (a.error_cases?.filter((c) => c.test_created || c.test_exists).length ?? 0), 0) ?? 0), 0);
  const createdCases = manifests.reduce((sum, m) => sum + (m.saga_actions?.reduce((s, a) => s + (a.error_cases?.filter((c) => c.test_created).length ?? 0), 0) ?? 0), 0);
  const testsCreated = manifests.reduce((sum, m) => sum + (m.tests_created?.length ?? 0), 0);
  const fixturesCreated = manifests.reduce((sum, m) => sum + (m.fixtures_created?.length ?? 0), 0);

  return {
    repoPath,
    model,
    workerTimeoutSeconds,
    maxAgents,
    totalActors: workerResults.length,
    succeeded: ok.length,
    failed: failed.length,
    actors: actorDirs,
    allActions,
    allErrorCases,
    testedCases,
    createdCases,
    untestedCases: allErrorCases - testedCases,
    testsCreated,
    fixturesCreated,
    workers: workerResults.map((r) => ({
      actor_dir: r.actorDir,
      status: r.status,
      summary: r.status === "fulfilled" ? summarizeText(r.summary, 512) : undefined,
      error: r.status === "rejected" ? r.error : undefined,
    })),
    manifests,
    changedFiles: finalDiff.map((d) => ({ file: d.file })),
  };
}

function buildAggregatedMarkdown(report) {
  const lines = [
    "# Z.AI SAGA Workflow E2E Coverage",
    "",
    "## Scope",
    `- SAGA participants: ${report.actors.join(", ")}`,
    `- Model: ${report.model}`,
    `- Max agents: ${report.maxAgents}`,
    "",
    "## Results",
    `| Participant | Status | SAGA Actions | Error Cases | Tested | Tests Created | Summary |`,
    `|-------------|--------|-------------|-------------|--------|-------------|---------|`,
  ];

  for (const worker of report.workers) {
    const name = path.basename(worker.actor_dir);
    const manifest = report.manifests.find((m) => {
      const actorDir = normalizeRelativePath(worker.actor_dir);
      const manifestDir = normalizeRelativePath(m.actor_dir ?? "");
      return actorDir === manifestDir;
    });
    const actionCount = manifest?.saga_actions?.length ?? 0;
    const totalCases = manifest?.saga_actions?.reduce((s, a) => s + (a.error_cases?.length ?? 0), 0) ?? 0;
    const coveredCases = manifest?.saga_actions?.reduce((s, a) => s + (a.error_cases?.filter((c) => c.test_created || c.test_exists).length ?? 0), 0) ?? 0;
    if (worker.status === "fulfilled") {
      const covStr = totalCases === 0 ? "no actions" : `${colorize(`${coveredCases}/${totalCases}`, coveredCases === totalCases ? ANSI.green : ANSI.yellow)}`;
      lines.push(`| ${name} | ok | ${actionCount} | ${totalCases} | ${covStr} | ${(manifest?.tests_created?.length ?? 0)} | ${worker.summary ?? ""} |`);
    } else {
      lines.push(`| ${name} | **failed** | — | — | — | — | ${worker.error ?? "unknown"} |`);
    }
  }

  lines.push("");
  lines.push(`Total: ${report.totalActors} participants, ${report.allActions} SAGA actions, ${report.allErrorCases} error cases, ${report.testedCases} tested, ${report.untestedCases} untested`);
  lines.push(`Tests created: ${report.testsCreated}, Fixtures created: ${report.fixturesCreated}`);
  lines.push("");

  if (report.untestedCases > 0) {
    lines.push("## Untested error cases");
    for (const manifest of report.manifests) {
      const actorName = path.basename(manifest.actor_dir ?? "unknown");
      const untestedActions = (manifest.saga_actions ?? []).filter((a) => (a.error_cases ?? []).some((c) => !c.test_exists && !c.test_created));
      if (untestedActions.length === 0) continue;
      lines.push(`### ${actorName}`);
      for (const action of untestedActions) {
        const untested = (action.error_cases ?? []).filter((c) => !c.test_exists && !c.test_created);
        for (const c of untested) {
          lines.push(`- [${action.action_name}] ${c.case}`);
        }
      }
      lines.push("");
    }
  }

  lines.push("## Workflow integration tests");
  let hasWorkflowTests = false;
  for (const manifest of report.manifests) {
    if (!manifest.workflow_tests || manifest.workflow_tests.length === 0) continue;
    hasWorkflowTests = true;
    const actorName = path.basename(manifest.actor_dir ?? "unknown");
    for (const wt of manifest.workflow_tests) {
      lines.push(`- [${actorName}] \`${wt.test_name}\` in \`${wt.test_file}\` — ${wt.outcome}`);
    }
  }
  if (!hasWorkflowTests) {
    lines.push("- none");
  }
  lines.push("");

  lines.push("## Changed files");
  if (report.changedFiles && report.changedFiles.length > 0) {
    for (const entry of report.changedFiles) {
      lines.push(`- ${entry.file}`);
    }
  } else {
    lines.push("- none");
  }
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const repoPath = path.resolve(args.repo);
  const srcPath = path.join(repoPath, "src");
  const outputDirectory = await buildOutputDirectory(repoPath, args.output);
  const apiKey = await resolveApiKey();

  logProgress(`starting saga workflow e2e for ${repoPath}`);
  logProgress(`artifacts will be written to ${outputDirectory}`);
  logProgress(`model ${args.model}`);
  logWarning(`using Z_AI_API_KEY ${maskSecret(apiKey)}`);
  logProgress(`max agents: ${args.maxAgents}`);
  logProgress(`worker timeout: ${args.workerTimeoutSeconds}s`);

  await ensureDirectoryExists(repoPath, "Repository path");
  await ensureDirectoryExists(srcPath, "src directory");

  let actorDirs;
  if (args.actors) {
    actorDirs = args.actors.split(",").map(normalizeRelativePath).filter(Boolean);
    logProgress(`using explicit actors: ${actorDirs.join(", ")}`);
  } else {
    actorDirs = await discoverActors(repoPath);
    logProgress(`discovered ${actorDirs.length} SAGA participant actor(s)`);
  }

  if (actorDirs.length === 0) {
    throw new Error("No SAGA participant actors found. Use --actors to specify explicitly.");
  }

  for (const dir of actorDirs) {
    const fullPath = path.join(repoPath, dir);
    if (!(await pathExists(fullPath))) {
      throw new Error(`Actor directory does not exist: ${dir}`);
    }
    logProgress(`  ${dir}`);
  }

  const { sandboxRoot, sandboxPath: sandboxRepoPath } = await createSandbox(repoPath, outputDirectory);

  await writeJson(path.join(outputDirectory, "run-config.json"), {
    repoPath,
    sandboxRepoPath,
    outputDirectory,
    apiBaseUrl: DEFAULT_API_BASE_URL,
    model: args.model,
    maxAgents: args.maxAgents,
    apply: args.apply,
    workerTimeoutSeconds: args.workerTimeoutSeconds,
    flow: ["zai-saga-workflow-e2e"],
    actorDirs,
  });

  if (args.dryRun) {
    logProgress("dry run complete");
    process.stdout.write([
      `Dry run ready.`,
      `Repo: ${repoPath}`,
      `Output: ${outputDirectory}`,
      `Model: ${args.model}`,
      `Max agents: ${args.maxAgents}`,
      `SAGA participants (${actorDirs.length}):`,
      ...actorDirs.map((d) => `  ${d}`),
    ].join("\n") + "\n");
    await fs.rm(sandboxRoot, { recursive: true, force: true, maxRetries: 3 });
    return;
  }

  logProgress(`sandbox ready at ${sandboxRepoPath}`);
  logProgress(`launching ${actorDirs.length} worker(s) with concurrency ${args.maxAgents}`);

  const workerResults = await runAllWorkers({
    actors: actorDirs,
    apiKey,
    model: args.model,
    sandboxRepoPath,
    outputDirectory,
    workerTimeoutMs: args.workerTimeoutSeconds * 1000,
    maxAgents: args.maxAgents,
  });

  const succeeded = workerResults.filter((r) => r.status === "fulfilled");
  const failed = workerResults.filter((r) => r.status === "rejected");
  logProgress(`all workers settled: ${succeeded.length} succeeded, ${failed.length} failed`);

  logProgress("loading manifests");
  const manifests = await loadManifests(outputDirectory, workerResults);
  const allActions = manifests.reduce((sum, m) => sum + (m.saga_actions?.length ?? 0), 0);
  const allErrorCases = manifests.reduce((sum, m) => sum + (m.saga_actions?.reduce((s, a) => s + (a.error_cases?.length ?? 0), 0) ?? 0), 0);
  const testedCases = manifests.reduce((sum, m) => sum + (m.saga_actions?.reduce((s, a) => s + (a.error_cases?.filter((c) => c.test_created || c.test_exists).length ?? 0), 0) ?? 0), 0);
  logProgress(`manifests loaded: ${manifests.length} valid, ${allActions} SAGA actions, ${testedCases}/${allErrorCases} error cases tested`);

  logProgress("validating final diff");
  const diffScopeDirs = [...actorDirs, "tests/contracts", "tests/live", "tests/execution", "tests/e2e"];
  const finalDiff = await diffDirectories(repoPath, sandboxRepoPath, diffScopeDirs);

  const allowedPrefixes = diffScopeDirs.map(normalizeRelativePath);
  const unauthorizedFiles = finalDiff.map((d) => d.file).filter((file) => {
    const normalized = normalizeRelativePath(file);
    for (const dir of allowedPrefixes) {
      if (normalized === dir || normalized.startsWith(`${dir}/`)) return false;
    }
    return true;
  });

  if (unauthorizedFiles.length > 0) {
    throw new Error(`Unauthorized file modifications detected: ${unauthorizedFiles.join(", ")}`);
  }

  logProgress(`diff validated: ${finalDiff.length} file(s) changed`);

  if (args.apply && finalDiff.length > 0) {
    for (const entry of finalDiff) {
      const sandboxPath = path.join(sandboxRepoPath, entry.file);
      const repoFilePath = path.join(repoPath, entry.file);
      await fs.mkdir(path.dirname(repoFilePath), { recursive: true });
      await fs.copyFile(sandboxPath, repoFilePath);
      logWarning(`applied: ${entry.file}`);
    }
    logProgress(`applied ${finalDiff.length} file(s) to ${repoPath}`);
  }

  await writeJson(path.join(outputDirectory, "final-diff.json"), finalDiff.map((d) => ({ file: d.file })));
  await writeJson(path.join(outputDirectory, "manifests.json"), manifests);

  const report = buildAggregatedReport({
    repoPath,
    model: args.model,
    workerTimeoutSeconds: args.workerTimeoutSeconds,
    maxAgents: args.maxAgents,
    actorDirs,
    workerResults,
    manifests,
    finalDiff,
  });
  await writeJson(path.join(outputDirectory, "report.json"), report);
  await fs.writeFile(path.join(outputDirectory, "report.md"), buildAggregatedMarkdown(report), "utf8");
  logProgress("artifacts written");

  process.stdout.write([
    `SAGA workflow E2E coverage complete for ${repoPath}`,
    `Participants: ${actorDirs.join(", ")}`,
    `Model: ${args.model}`,
    `Max agents: ${args.maxAgents}`,
    `Results: ${succeeded.length} succeeded, ${failed.length} failed`,
    `SAGA actions: ${allActions}, Error cases: ${testedCases}/${allErrorCases} tested`,
    `Tests created: ${report.testsCreated}, Fixtures created: ${report.fixturesCreated}`,
    `Artifacts: ${outputDirectory}`,
    `Changed files: ${finalDiff.length}`,
  ].join("\n") + "\n");

  if (failed.length > 0) {
    logWarning(`${failed.length} worker(s) failed: ${failed.map((r) => r.actorName).join(", ")}`);
  }

  if (report.untestedCases > 0) {
    process.stdout.write(colorize(`\n[!] ${report.untestedCases} SAGA error case(s) have no test coverage — see report.md for details.\n`, ANSI.yellow));
  } else if (allErrorCases > 0) {
    process.stdout.write(colorize("\n[ok] All SAGA error cases have E2E test coverage.\n", ANSI.green));
  }

  try {
    await fs.rm(sandboxRoot, { recursive: true, force: true, maxRetries: 3 });
    logProgress("sandbox cleaned up");
  } catch (error) {
    logWarning(`sandbox cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

run().catch(async (error) => {
  logError(error instanceof Error ? error.message : String(error));
  try {
    const artifactsDir = process.argv.includes("--output")
      ? path.resolve(process.argv[process.argv.indexOf("--output") + 1])
      : undefined;
    if (artifactsDir) {
      const sandboxPathFile = path.join(artifactsDir, "sandbox-path.txt");
      if (await pathExists(sandboxPathFile)) {
        const sandboxPath = (await fs.readFile(sandboxPathFile, "utf8")).trim();
        const sandboxRoot = path.dirname(sandboxPath);
        await fs.rm(sandboxRoot, { recursive: true, force: true, maxRetries: 3 });
        logProgress("sandbox cleaned up after error");
      }
    }
  } catch { /* best effort */ }
  process.exitCode = 1;
});
