#!/usr/bin/env node

import fs from "node:fs/promises";
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const DEFAULT_MODEL = "glm-5";
const DEFAULT_WORKER_TIMEOUT_SECONDS = 15 * 60;
const DEFAULT_API_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
const DEFAULT_MAX_AGENTS = 1;
const MAX_TOOL_ROUNDS = 512;
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
  "You are a fixture alignment worker for a Rust project that uses shared_ws.",
  "Your task is to ensure every WebSocket subscription in your assigned actor module has live-captured contract fixtures.",
  "Fix all gaps in-place — create missing fixture files, register missing contracts, and wire `with_fixture_contract()` into any untagged subscriptions.",
  "",
  "## Fixture system overview",
  "Outbound WebSocket traffic via `shared_ws::Client` is gated by `fixture_policy`. Before any real WS connection or subscription executes, the transport layer requires:",
  "1. The subscription carries a `fixture_contract` ID (set via `WsRequest::with_fixture_contract(id)` or equivalent)",
  "2. A `WsFixtureRequirement` for that ID is registered in the contract registry",
  "3. BOTH `messages_path` and `error_path` JSON files exist on disk",
  "4. Both files pass provenance validation: `source == \"live_capture\"` with non-empty `captured_at_ms`, `capture_command`, and `exchange_env`",
  "",
  "## Fixture file format (required envelope)",
  '```json',
  '{',
  '  "source": "live_capture",',
  '  "captured_at_ms": 1710000000000,',
  '  "capture_command": "cargo test --test <capture_test> ...",',
  '  "exchange_env": "<exchange_env>",',
  '  "url": "wss://...",',
  '  "subscription": "<channel_or_topic>",',
  '  "messages": [',
  '    { "type": "<message_type>", "data": { ... } }',
  '  ]',
  '}',
  '```',
  "",
  "## Error fixture file format",
  '```json',
  '{',
  '  "source": "live_capture",',
  '  "captured_at_ms": 1710000000000,',
  '  "capture_command": "cargo test --test <capture_test> ...",',
  '  "exchange_env": "<exchange_env>",',
  '  "url": "wss://...",',
  '  "subscription": "<channel_or_topic>",',
  '  "error_code": <number_or_string>,',
  '  "error_message": "<exchange error text>"',
  '}',
  '```',
  "",
  "## What to do",
  "1. Find ALL WebSocket subscriptions and connections via `shared_ws::Client` (search for `subscribe`, `connect`, `send`, `WsClient`, `WsTransport`, `shared_ws`, `with_fixture_contract`)",
  "2. For each subscription, check that the request has `with_fixture_contract(id)` set — if not, add it",
  "3. Check that a corresponding `WsFixtureRequirement { messages_path, error_path }` is registered — if not, add it to the contract registry",
  "4. Check that BOTH fixture JSON files exist at the registered paths — if not, create them",
  "5. **READ every existing fixture file** and validate its content:",
  "   a. Verify the provenance envelope is complete (`source`, `captured_at_ms`, `capture_command`, `exchange_env` all present and non-empty)",
  "   b. Verify the `messages` array is NOT empty, NOT `[]`, NOT stub data — it must contain realistic WS messages",
  "   c. For **error fixtures specifically**: verify the fixture contains a real exchange WS error (error code, error message), NOT a success fixture with a fake error field. The error must be an actual error payload the exchange would return on the WS connection.",
  "   d. For **message fixtures**: verify the messages match the exchange's documented WS message schema with realistic values",
  "   e. If any fixture fails validation, REWRITE it with correct content",
  "6. For each subscription, ensure there is AT LEAST ONE error fixture covering a plausible failure mode. If only a messages fixture exists, create the missing error fixture.",
  "   Common failure modes to ensure coverage for:",
  "   - Invalid symbol / subscription rejected (the most common edge case for market data WS)",
  "   - Connection limit exceeded",
  "   - Authentication failure on connect",
  "   - Subscription timeout / no messages received",
  "   If a contract only has one error fixture, that is acceptable — but it MUST contain a realistic error body.",
  "7. **Check for live capture infrastructure**:",
  "   a. Search `tests/` for a capture test matching this actor (e.g. `tests/contracts/<actor_name>_ws_fixture_capture.rs` or `tests/live/<actor_name>_ws_fixture_capture.rs`)",
  "   b. If a capture test EXISTS — verify it covers all contracts. If it is missing contracts, note this in the manifest.",
  "   c. If NO capture test exists — create one. The capture test must:",
  "      - Be an `#[ignore]` integration test (marked `#[ignore]` so it only runs with `--ignored --nocapture`)",
  "      - Set `SHARED_WS_FIXTURE_CAPTURE_MODE=1` env var to bypass the fixture gate",
  "      - Make real WS connections against the exchange (testnet if available, otherwise mainnet with read-only subscriptions)",
  "      - Subscribe to channels, collect real messages, and write them as fixture JSON files to the actor's `test/fixtures/` directory",
  "      - Write both message AND error cases (trigger errors by using invalid symbols, expired tokens, etc.)",
  "      - Follow the exact same pattern as existing WS capture tests in the codebase",
  "   d. Prefer LIVE captured fixtures over synthetic ones. Synthetic fixtures are a stopgap — live capture is the source of truth.",
  "8. Write a manifest.json in your worker output directory listing all contracts you created or modified, plus whether a capture test was created or already exists",
  "",
  "## Fixture body content",
  "Each contract requires TWO fixtures:",
  "",
  "**Messages fixture** (`_messages.json`):",
  "- Must contain a realistic array of representative WS messages for the specific subscription channel",
  "- Match the actual exchange's documented WS message schema exactly (correct field names, types, nesting)",
  "- Include plausible realistic values (real symbol names, valid timestamps, numeric magnitudes that match production ranges)",
  "- For streaming data (trades, order book updates, klines), include enough messages to exercise parsing logic (typically 3-10 messages)",
  "- Each message should represent a realistic state transition or update",
  "",
  "**Error fixture** (`_error.json`):",
  "- Must contain a realistic error response that the exchange would actually return for that WS subscription",
  "- Use the exchange's real WS error format (e.g. Binance WS uses `{\"code\": -1121, \"msg\": \"Invalid symbol.\"}`)",
  "- Match the error type to the failure scenario (e.g. invalid symbol, connection limit, auth failure)",
  "- Choose an error scenario that is plausible for the specific subscription (not a generic error)",
  "- Common Binance WS error codes: -1121 (invalid symbol), -1000 (internal error), -1003 (too many connections), -1014 (disconnect)",
  "- The error must be deserializable by the same type the success messages use (if Rust code parses both with the same struct, the error JSON must at minimum have overlapping fields or a compatible shape)",
  "",
  "**Per-subscription error examples to consider**:",
  "- Market data subscriptions: invalid symbol/not found, rate limited, maintenance disconnect",
  "- Private channels: expired/invalid listen key, auth failure",
  "- Order book streams: invalid interval, unsupported pair",
  "- If the existing codebase already has error fixtures for similar subscriptions, follow the same error format/shape for consistency",
  "",
  "## Manifest format",
  "Write this file as `<worker_output_dir>/manifest.json`:",
  "```json",
  "{",
  '  "contracts": [',
  "    {",
  '      "contract_id": "...",',
  '      "messages_path": "...",',
  '      "error_path": "...",',
  '      "action": "created" | "modified"',
  "    }",
  "  ],",
  '  "with_fixture_contract_added": ["<file_path>:<line_description>", ...]',
  "}",
  "```",
  "",
  "## Actor-adapter architecture (shared_ws integration)",
  "shared_ws is a stateless IO adapter — the actor owns all domain logic, state, and messaging.",
  "",
  "**No code in an actor may ever create its own Tokio runtime.** The icanact-core runtime is the sole executor.",
  "",
  "**Actors with I/O-bound work (WS connections) MUST use `local::CustomRunnerActor` + `spawn_with_custom_runner`** instead of bridging from sync `Tell` with `block_in_place`. The `CustomRunnerActor` trait provides a `run_with_inbox` method that gives the actor a native async inbox loop. See `icanact_core::local_async::CustomRunnerActor`.",
  "",
  "**The old `block_in_place` bridge pattern (`Handle::try_current()` + `tokio::task::block_in_place` in sync `Tell` handlers) is FORBIDDEN for new code.** Existing actors using this pattern are technical debt that should be migrated to `CustomRunnerActor`.",
  "",
  "- All cross-actor traffic goes through icanact-core traits (Tell/Ask/PubSub/Broadcast). shared_ws is called from the actor's business_logic layer and never owns or exposes transports directly.",
  "- The actor receives a message via its inbox, processes it async in `run_with_inbox`, issues the WS call, and routes the result back through the actor messaging API.",
  "- shared_ws must stay a stateless client. The actor configures it and consumes its callbacks/results. Never wrap shared_ws with new queues, mpsc channels, or runtime mediators.",
  "- Parse WS frames into concrete domain structs immediately and mutate actor state directly; don't stash raw JSON or spawn helper tasks. If another component needs the data, publish it through an actor message defined in messaging.rs.",
  "- All JSON parsing/deserialization MUST use `sonic_rs` — `serde_json` is forbidden in actor code.",
  "- WS actors must use lazy-decode: forward raw WS messages via Tell/PubSub to downstream consumers; the consumer does the `sonic_rs::from_str` decode. WS actors are thin routing layers, not parsing layers.",
  "- For long-lived WS subscriptions, the actor's `run_with_inbox` loop should integrate WS message delivery directly into its inbox processing — no side-channel pipes, no detached `tokio::spawn` loops.",
  "",
  "## Rules",
  "- You MUST READ every fixture file you find — do not assume existing fixtures are correct just because they exist on disk",
  "- **Live capture is the source of truth. Synthetic fixtures are a stopgap.** Always check if a capture test exists first.",
  "- If no capture test exists for the actor, you MUST create one in `tests/contracts/<actor_name>_ws_fixture_capture.rs` (or `tests/live/` if that's the project convention). Follow the exact pattern of existing capture tests.",
  "- The capture test must cover ALL contracts (both messages and error cases). Error cases are captured by subscribing with bad params (invalid symbol, expired token, etc.) and recording the exchange's real error response.",
  "- Use realistic representative JSON matching the actual exchange WS message schema for synthetic fixture bodies — NOT stubs, NOT `{}`, NOT placeholder text",
  "- Error fixtures MUST contain a real exchange error payload — NOT a success message, NOT an empty object, NOT `{\"error\": \"error\"}`",
  "- Every subscription MUST have both a messages AND an error fixture — if an error fixture is missing, create one",
  "- If you find an error fixture whose content is just a copy of the messages fixture with `error_code` added, that is WRONG — rewrite it with an actual error payload",
  "- `source` must always be `\"live_capture\"` for WS fixtures — never `\"synthesized\"`",
  "- If the messages and errors are deserialized by different Rust types, ensure each fixture matches its corresponding type's schema",
  "- Follow existing naming conventions: `{channel}_{outcome}.json` in domain subdirectories (`market_data/`, etc.)",
  "- Contract IDs: lowercase snake_case, matching existing patterns in the codebase",
  "- `exchange_env`: use the appropriate exchange env (e.g. `\"binance_mainnet_ws\"` for Binance WS, `\"deribit_testnet_ws\"` for Deribit WS)",
  "- `capture_command`: use `\"cargo test --test <actor_name>_ws_fixture_capture ...\"` as the provenance record",
  "- Keep `source` as `\"live_capture\"` for all new fixtures",
  "- Do NOT create capture test scripts — only fixture files, contract registrations, and `with_fixture_contract()` wiring",
  "- Do NOT modify code outside your assigned actor module directory",
  "- If all fixtures are already complete for your actor, say so briefly and write an empty contracts array in the manifest",
  "- When calling write_manifest, ONLY pass the contracts array — do NOT pass a file path, the path is automatic",
  "**After all fixes, run `cargo_check` to verify the code compiles.** If there are compilation errors, fix them and run `cargo_check` again. Repeat until it passes. Do NOT skip this step.",
  "Use the provided file tools to inspect code and make edits.",
  "Do the work now. Do not ask follow-up questions.",
].join("\n");

function buildUserPrompt(actorDir, actorName) {
  return [
    `You are assigned the actor module: ${actorDir}`,
    `Actor name: ${actorName}`,
    "",
    "Scope: inspect all source and test files under this actor directory for WebSocket subscriptions and connections via shared_ws::Client.",
    "Also check the corresponding test/support files and build.rs registrations if they reference this actor.",
    "",
    "Steps:",
    "1. Read docs/ACTOR_SCHEMA.md first — it defines fixture naming conventions, file roles, and structure that override any assumptions",
    "2. Read the actor's source files (mod.rs, business_logic.rs, ws_client.rs, etc.) to find all WS subscriptions",
    "3. Check if each subscription has with_fixture_contract() — add if missing",
    "4. Find the contract registry (search for WsFixtureRequirement) and verify coverage",
    "5. Check test/fixtures/ subdirectories for existing fixture JSON files",
    "6. Create any missing fixture files — follow the naming conventions from ACTOR_SCHEMA.md",
    "7. Write manifest.json to your worker output directory",
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
    "  npm run shared-ws:alignment -- --repo /absolute/path/to/repo",
    "    [--actors actor_dir_1,actor_dir_2]",
    "    [--max-agents N]",
    "    [--output /path/to/artifacts]",
    "    [--model glm-5]",
    "    [--worker-timeout-seconds N]",
    "    [--apply] [--dry-run]",
    "",
    "Defaults:",
    "  --actors auto-discovered (actors using shared_ws::Client)",
    `  --max-agents ${DEFAULT_MAX_AGENTS}`,
    `  --model ${DEFAULT_MODEL}`,
    `  --worker-timeout-seconds ${DEFAULT_WORKER_TIMEOUT_SECONDS}`,
    "  --apply write sandbox edits back to the real repo after validation",
    "  --output ./artifacts/zai-shared-ws-alignment/<repo-name>-<timestamp>",
    "  requires Z_AI_API_KEY in the environment",
    "",
    "Actors are discovered by scanning src/ for directories containing Rust files",
    "that reference `shared_ws::Client` or `WsTransport`. Provide",
    "--actors to override with an explicit comma-separated list of relative",
    "directory paths (e.g. src/actors/market_data/binance/binance_ws_actor).",
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
    if (arg === "--dry-run") {
      result.dryRun = true;
      continue;
    }
    if (arg === "--apply") {
      result.apply = true;
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
  const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "zai-shared-ws-alignment-sandbox-"));
  const sandboxPath = path.join(sandboxRoot, repoNameFromPath(repoPath));
  await fs.mkdir(sandboxPath, { recursive: true });

  for (const root of ["src/actors", "tests"]) {
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

  await fs.writeFile(path.join(outputDirectory, "sandbox-path.txt"), `${sandboxPath}\n`, "utf8");
  return { sandboxRoot, sandboxPath };
}

async function buildOutputDirectory(repoPath, explicitOutput) {
  const baseDirectory = explicitOutput
    ? path.resolve(explicitOutput)
    : path.resolve("artifacts", "zai-shared-ws-alignment", `${repoNameFromPath(repoPath)}-${timestamp()}`);
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

  const patterns = ["shared_ws::Client", "WsTransport", "WsClient", "shared_ws::", "with_ws_fixture_contract"];
  const actorFiles = new Set();

  for (const pattern of patterns) {
    const result = await execRg(
      ["-l", "-g", "*.rs", pattern, srcActorsDir],
      repoPath,
    );
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
      if (await pathExists(modRs)) {
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
        description: "Overwrite a file with updated content. Use for creating fixture JSON files or editing source files within the assigned actor directory.",
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
        name: "write_manifest",
        description: "Write the manifest.json for this worker. The file is written automatically to your output directory — do NOT specify a file path. Call this at the END of your work.",
        parameters: {
          type: "object",
          properties: {
            contracts: {
              type: "array",
              description: "List of contract entries.",
              items: {
                type: "object",
                properties: {
                  contract_id: { type: "string" },
                  messages_path: { type: "string" },
                  error_path: { type: "string" },
                  action: { type: "string", enum: ["created", "modified"] },
                },
                required: ["contract_id", "messages_path", "error_path", "action"],
              },
            },
            with_fixture_contract_added: {
              type: "array",
              description: "List of files where with_fixture_contract() was added.",
              items: { type: "string" },
            },
          },
          required: ["contracts"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "cargo_check",
        description: "Run `cargo check` in the sandbox to verify the code compiles. Call this as your FINAL step after all fixes. If it reports errors, fix the code and run again until clean.",
        parameters: {
          type: "object",
          properties: {},
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
    normalized.startsWith("tests/") ||
    normalized === "tests" ||
    normalized === "Cargo.toml" ||
    normalized === "build.rs"
  ) {
    return normalized;
  }

  throw new Error(`Access denied for ${relativePath} (outside allowed scope: src/, tests/, Cargo.toml, build.rs)`);
}

function ensureAllowedWritePath(relativePath, actorDir, workerOutputDir) {
  const normalized = normalizeRelativePath(relativePath);
  const actorNorm = normalizeRelativePath(actorDir);

  if (normalized === actorNorm || normalized.startsWith(`${actorNorm}/`)) {
    return normalized;
  }

  if (
    normalized.startsWith("tests/contracts/") ||
    normalized.startsWith("tests/live/") ||
    normalized.startsWith("tests/execution/")
  ) {
    return normalized;
  }

  if (normalized.startsWith(`${workerOutputDir}/`) || normalized === workerOutputDir) {
    return normalized;
  }

  throw new Error(`Write access denied for ${relativePath} (must be under ${actorDir}, tests/contracts/, tests/live/, or ${workerOutputDir})`);
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
    const relativePath = ensureAllowedWritePath(args.file_path, actorDir, workerOutputDir);
    const absolutePath = toAbsoluteSandboxPath(sandboxRepoPath, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    const before = (await pathExists(absolutePath)) ? await fs.readFile(absolutePath, "utf8") : "";
    await fs.writeFile(absolutePath, args.content, "utf8");
    logWarning(`tool:write_file ${relativePath}`, workerLabel);
    return { ok: true, file_path: relativePath, changed: before !== args.content, created: !before };
  }

  if (name === "create_directory") {
    const relativePath = ensureAllowedWritePath(args.directory_path, actorDir, workerOutputDir);
    const absolutePath = toAbsoluteSandboxPath(sandboxRepoPath, relativePath);
    await fs.mkdir(absolutePath, { recursive: true });
    logProgress(`tool:create_directory ${relativePath}`, workerLabel);
    return { ok: true, directory_path: relativePath };
  }

  if (name === "write_manifest") {
    const manifestPath = path.join(workerOutputDir, "manifest.json");
    await fs.mkdir(workerOutputDir, { recursive: true });
    await writeJson(manifestPath, {
      actor_dir: actorDir,
      contracts: args.contracts ?? [],
      with_fixture_contract_added: args.with_fixture_contract_added ?? [],
    });
    logProgress(`tool:write_manifest ${args.contracts?.length ?? 0} contract(s)`, workerLabel);
    return { ok: true, manifest_path: manifestPath };
  }

  if (name === "cargo_check") {
    logProgress(`tool:cargo_check`, workerLabel);
    const result = await execCapture("cargo", ["check", "--message-format=short"], { cwd: sandboxRepoPath });
    logProgress(`tool:cargo_check ${result.code === 0 ? "passed" : "errors found"}`, workerLabel);
    return { ok: result.code === 0, stderr: result.stderr, stdout: result.stdout, code: result.code };
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
// Diff & merge
// ---------------------------------------------------------------------------

async function diffDirectories(originalRoot, sandboxRoot, scopeDirs) {
  const diffs = [];

  for (const scopeDir of scopeDirs) {
    const originalScope = path.join(originalRoot, scopeDir);
    const sandboxScope = path.join(sandboxRoot, scopeDir);

    if (!(await pathExists(originalScope)) && !(await pathExists(sandboxScope))) continue;

    let originalFiles = [];
    let sandboxFiles = [];
    try { originalFiles = (await pathExists(originalScope)) ? await listFilesRecursive(originalScope, DEFAULT_EXCLUDED_PATHS) : []; } catch { /* skip unreadable scope */ }
    try { sandboxFiles = (await pathExists(sandboxScope)) ? await listFilesRecursive(sandboxScope, DEFAULT_EXCLUDED_PATHS) : []; } catch { /* skip unreadable scope */ }

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

function buildAggregatedReport({ repoPath, model, workerTimeoutSeconds, maxAgents, actorDirs, workerResults, manifests, finalDiff }) {
  const ok = workerResults.filter((r) => r.status === "fulfilled");
  const failed = workerResults.filter((r) => r.status === "rejected");
  const totalContracts = manifests.reduce((sum, m) => sum + m.contracts.length, 0);

  return {
    repoPath,
    model,
    workerTimeoutSeconds,
    maxAgents,
    totalActors: workerResults.length,
    succeeded: ok.length,
    failed: failed.length,
    actors: actorDirs,
    workers: workerResults.map((r) => ({
      actor_dir: r.actorDir,
      status: r.status,
      summary: r.status === "fulfilled" ? summarizeText(r.summary, 512) : undefined,
      error: r.status === "rejected" ? r.error : undefined,
    })),
    manifests,
    totalContracts,
    changedFiles: finalDiff.map((d) => ({ file: d.file })),
  };
}

function buildAggregatedMarkdown(report) {
  const lines = [
    "# Z.AI Shared-WS Fixture Alignment",
    "",
    "## Scope",
    `- Actors: ${report.actors.join(", ")}`,
    `- Model: ${report.model}`,
    `- Max agents: ${report.maxAgents}`,
    "",
    "## Results",
    `| Actor | Status | Summary |`,
    `|-------|--------|---------|`,
  ];

  for (const worker of report.workers) {
    const name = path.basename(worker.actor_dir);
    if (worker.status === "fulfilled") {
      lines.push(`| ${name} | ok | ${worker.summary ?? ""} |`);
    } else {
      lines.push(`| ${name} | **failed** | ${worker.error ?? "unknown"} |`);
    }
  }

  lines.push("");
  lines.push(`Total: ${report.totalActors} actors, ${report.succeeded} succeeded, ${report.failed} failed`);
  lines.push(`Contracts created/modified: ${report.totalContracts}`);
  lines.push("");
  lines.push("## Changed files");
  if (report.changedFiles.length > 0) {
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

  logProgress(`starting shared-ws fixture alignment for ${repoPath}`);
  logProgress(`artifacts will be written to ${outputDirectory}`);
  logProgress(`model ${args.model}`);
  logWarning(`using Z_AI_API_KEY ${maskSecret(apiKey)}`);
  logProgress(`max agents: ${args.maxAgents}`);
  logProgress(`worker timeout: ${args.workerTimeoutSeconds}s`);
  logProgress(`excluding generated paths: ${DEFAULT_EXCLUDED_PATHS.join(", ")}`);

  await ensureDirectoryExists(repoPath, "Repository path");
  await ensureDirectoryExists(srcPath, "src directory");

  let actorDirs;
  if (args.actors) {
    actorDirs = args.actors.split(",").map(normalizeRelativePath).filter(Boolean);
    logProgress(`using explicit actors: ${actorDirs.join(", ")}`);
  } else {
    actorDirs = await discoverActors(repoPath);
    logProgress(`discovered ${actorDirs.length} actor(s) using shared_ws`);
  }

  if (actorDirs.length === 0) {
    throw new Error("No actors found. Use --actors to specify explicitly.");
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
    flow: ["zai-shared-ws-alignment"],
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
      `Actors (${actorDirs.length}):`,
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

  logProgress("loading worker manifests");
  const manifests = await loadManifests(outputDirectory, workerResults);
  const totalContracts = manifests.reduce((sum, m) => sum + m.contracts.length, 0);
  logProgress(`manifests loaded: ${manifests.length} valid, ${totalContracts} total contract(s)`);

  logProgress("validating final diff");
  const diffScopeDirs = [...actorDirs, "tests/contracts", "tests/live", "tests/execution"];
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

  logProgress(`diff validated: ${finalDiff.length} file(s) changed across actor directories`);

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
    `Shared-WS fixture alignment complete for ${repoPath}`,
    `Actors: ${actorDirs.join(", ")}`,
    `Model: ${args.model}`,
    `Max agents: ${args.maxAgents}`,
    `Results: ${succeeded.length} succeeded, ${failed.length} failed`,
    `Contracts: ${totalContracts} created/modified`,
    `Artifacts: ${outputDirectory}`,
    `Changed files: ${finalDiff.length}`,
  ].join("\n") + "\n");

  if (failed.length > 0) {
    logWarning(`${failed.length} worker(s) failed: ${failed.map((r) => r.actorName).join(", ")}`);
  }

  if (manifests.length > 0 && args.apply) {
    const needsBuildRs = manifests.some((m) => m.contracts.length > 0);
    if (needsBuildRs) {
      process.stdout.write(colorize("\n[post-merge] New contracts were registered. You may need to update build.rs to include them in validate_required_ws_contracts().\n", ANSI.yellow));
    }
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
