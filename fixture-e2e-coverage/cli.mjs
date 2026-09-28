#!/usr/bin/env node

import fs from "node:fs/promises";
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const DEFAULT_MODEL = "glm-5";
const DEFAULT_WORKER_TIMEOUT_SECONDS = 20 * 60;
const DEFAULT_API_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
const DEFAULT_MAX_AGENTS = 2;
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
  "You are a fixture E2E coverage engineer for a Rust project that uses shared_restapi and shared_ws.",
  "Your job is to ensure every registered fixture (success AND error) is exercised by an end-to-end test that runs the full business logic flow through it.",
  "",
  "## The problem this solves",
  "A fixture file on disk without a test that exercises it is dead code. Many actors have registered fixtures (success + error) but no tests that actually run the business logic path through them. Capture tests only write fixtures — they don't test the logic that consumes them.",
  "",
  "## What 'exercising a fixture' means",
  "An E2E test exercises a fixture when it:",
  "1. Triggers the business logic that would normally make the real API call",
  "2. The fixture gate intercepts and serves the fixture JSON instead of making a real call",
  "3. The business logic parses the fixture response into domain structs (same code path as production)",
  "4. The test asserts on the resulting domain state, parsed structs, or error handling",
  "",
  "This means the test runs through: messaging → business_logic → query/execute function → fixture gate → fixture file → parse → domain struct → assert",
  "",
  "## What to do",
  "1. Read `docs/ACTOR_SCHEMA.md` first for authoritative structure definitions",
  "2. Find ALL registered fixtures for this actor:",
  "   a. Search for `ContractFixtureRequirement` or `WsContractFixtureRequirement` const arrays",
  "   b. Search for `RestFixtureRequirement` or `WsFixtureRequirement` registrations",
  "   c. Search for `register_required_rest_contracts` and `register_required_ws_contracts` calls",
  "   d. List the fixture JSON files that exist under `test/fixtures/`",
  "3. Find ALL existing tests (unit + integration) in the actor directory and under `tests/` that reference this actor",
  "4. For each registered fixture, determine if an existing test exercises the FULL business logic flow through it:",
  "   a. Search for the `contract_id` string in test files — a match in a test that calls business logic through the fixture gate counts as covered",
  "   b. A test that only reads the JSON file directly (e.g. `fs::read_to_string(\"test/fixtures/...\")`) but does NOT go through the business logic does NOT count",
  "   c. A capture test (that WRITES fixtures) does NOT count — it tests capture, not consumption",
  "5. Create missing E2E tests for any fixture that lacks coverage:",
  "   a. Each test MUST go through the actual business logic code path (call the same function that production calls)",
  "   b. Each test MUST be an `#[ignore]` integration test (since it depends on fixture files)",
  "   c. Tests must use actor messaging (Tell/Ask/PubSub) — no `Arc<Mutex<Vec<...>>>`, no channels, no shared state",
  "   d. For success fixtures: test that the parsed response produces correct domain state",
  "   e. For error fixtures: test that the error is properly handled — the business logic returns an error / sets error state / the actor recovers gracefully",
  "   f. Test edge cases: empty response body, malformed JSON (if the exchange sends garbage), missing fields, zero-length arrays, timeout scenarios",
  "6. After creating tests, run `cargo_check` to verify compilation",
  "7. Write a manifest.json listing all fixtures and their test coverage status",
  "",
  "## How fixture consumption works in tests",
  "The project uses a `#[cfg(test)]` code path where `execute_live_query` (or equivalent) reads the fixture file directly from disk instead of making a real HTTP/WS call. This means unit tests that call business logic query functions automatically consume fixtures.",
  "",
  "For REST actors: the test path typically calls `business_logic::query_*()` or `business_logic::fetch_*()` which internally calls `execute_live_query()` with the fixture contract ID. The fixture gate is bypassed in test mode (or the `#[cfg(test)]` version reads fixtures directly).",
  "",
  "For WS actors: the test path typically sends a Tell message that triggers the WS subscription handler, which consumes the fixture through the shared_ws fixture gate. The handler parses the fixture frames into domain structs.",
  "",
  "Tests go in the project root `tests/e2e/` directory (e.g. `tests/e2e/<actor_name>_fixture_e2e.rs`). Follow the exact pattern of existing tests in the `tests/` directory.",
  "",
  "## Test structure",
  "Tests go in `tests/contracts/<actor_name>_fixture_e2e.rs` (or `tests/live/` if that's the project convention). Follow the exact pattern of existing tests.",
  "",
  "Each test function should cover ONE fixture (success or error). Name it descriptively:",
  "```rust",
  "#[test]",
  "#[ignore = \"requires fixture files\"]",
  "fn e2e_<contract_id>_success_exercises_business_logic() { ... }",
  "",
  "fn e2e_<contract_id>_error_exercises_error_handling() { ... }",
  "```",
  "",
  "## Edge cases that MUST be covered for each fixture",
  "- Success fixture: parse succeeds, domain structs have correct values, state updates correctly",
  "- Error fixture: the specific error (invalid symbol, rate limit, auth failure, etc.) is properly handled — the actor sets an error, returns an error result, or recovers",
  "- Empty/malformed fixture body: if the fixture JSON has an empty body or malformed content, the business logic handles it gracefully (not a panic)",
  "- Missing fields: if the fixture is missing expected fields, the parse fails with a clear error (not a panic)",
  "",
  "## Manifest format",
  "Write via `write_manifest` with this structure:",
  "```json",
  "{",
  '  "fixtures": [',
  "    {",
  '      "contract_id": "<contract_id>",',
  '      "fixture_type": "success" | "error",',
  '      "fixture_path": "test/fixtures/<group>/<file>.json",',
  '      "test_exists": true | false,',
  '      "test_exercises_full_flow": true | false,',
  '      "test_file": "tests/contracts/<actor>_fixture_e2e.rs",',
  '      "test_function": "e2e_<contract_id>_<type>_...",',
  '      "action": "covered" | "test_created" | "no_test"',
  "    }",
  "  ],",
  '  "tests_created": ["<file_path>", ...]',
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
  "- Do NOT create fixture files — only tests that exercise existing fixtures",
  "- Do NOT modify fixture JSON files",
  "- Do NOT modify `docs/ACTOR_SCHEMA.md`",
  "- Do NOT modify code outside your assigned actor directory and `tests/contracts/` or `tests/live/`",
  "- Write scope: `tests/contracts/<actor>_fixture_e2e.rs` (or `tests/live/` if that's the convention)",
  "- Tests MUST go through the actual business logic code path — not just deserialize the JSON",
  "- Tests MUST use actor messaging (Tell/Ask/PubSub) — never shared state",
  "- Do NOT skip edge cases — every error fixture must have a test that exercises the error handling path",
  "- After all tests are written, run `cargo_check` to verify compilation",
  "Use the provided file tools to inspect code and make edits.",
  "Do the work now. Do not ask follow-up questions.",
].join("\n");

function buildUserPrompt(actorDir, actorName) {
  return [
    `You are writing E2E tests for the actor module: ${actorDir}`,
    `Actor name: ${actorName}`,
    "",
    "Steps:",
    "1. Read docs/ACTOR_SCHEMA.md for authoritative structure definitions",
    "2. Find ALL registered fixtures (ContractFixtureRequirement / WsContractFixtureRequirement arrays + register_required_*_contracts calls)",
    "3. List all fixture JSON files under test/fixtures/",
    "4. Search for existing tests (unit + integration) that exercise each fixture through the business logic",
    "5. Create missing E2E tests for uncovered fixtures — both success AND error paths",
    "6. Ensure edge cases are covered (empty body, malformed JSON, missing fields, specific error handling)",
    "7. Run cargo_check to verify compilation",
    "8. Call write_manifest with full coverage report",
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
    "  npm run fixture-e2e:coverage -- --repo /absolute/path/to/repo",
    "    [--actors actor_dir_1,actor_dir_2]",
    "    [--max-agents N]",
    "    [--output /path/to/artifacts]",
    "    [--model glm-5]",
    "    [--worker-timeout-seconds N]",
    "    [--apply] [--dry-run]",
    "",
    "Defaults:",
    "  --actors auto-discovered (actors using shared_restapi or shared_ws)",
    `  --max-agents ${DEFAULT_MAX_AGENTS}`,
    `  --model ${DEFAULT_MODEL}`,
    `  --worker-timeout-seconds ${DEFAULT_WORKER_TIMEOUT_SECONDS}`,
    "  --apply write sandbox tests back to the real repo after validation",
    "  --output ./artifacts/zai-fixture-e2e-coverage/<repo-name>-<timestamp>",
    "  requires Z_AI_API_KEY in the environment",
    "",
    "This task creates E2E tests, not fixture files. It ensures every registered fixture",
    "(success AND error) is exercised by a test that runs the full business logic flow.",
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
  const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "zai-fixture-e2e-coverage-sandbox-"));
  const sandboxPath = path.join(sandboxRoot, repoNameFromPath(repoPath));
  await fs.mkdir(sandboxPath, { recursive: true });

  for (const root of ["src/actors", "src", "tests"]) {
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
    : path.resolve("artifacts", "zai-fixture-e2e-coverage", `${repoNameFromPath(repoPath)}-${timestamp()}`);
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
    "shared_restapi::Client",
    "shared_ws::Client",
    "WsTransport",
    "WsClient",
    "RestFixtureRequirement",
    "WsFixtureRequirement",
    "ContractFixtureRequirement",
    "WsContractFixtureRequirement",
    "register_required_rest_contracts",
    "register_required_ws_contracts",
    "with_fixture_contract",
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
        description: "Overwrite a file with updated content. Use for creating test files in tests/contracts/ or tests/live/.",
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
        description: "Run `cargo check` in the sandbox to verify the code compiles. Call this as your FINAL step after all tests are written. If it reports errors, fix them and run again until clean.",
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
        description: "Write the coverage manifest. The file is written automatically to your output directory. Call this at the END of your work.",
        parameters: {
          type: "object",
          properties: {
            fixtures: {
              type: "array",
              description: "List of fixture coverage entries.",
              items: {
                type: "object",
                properties: {
                  contract_id: { type: "string" },
                  fixture_type: { type: "string", enum: ["success", "error"] },
                  fixture_path: { type: "string" },
                  test_exists: { type: "boolean" },
                  test_exercises_full_flow: { type: "boolean" },
                  test_file: { type: "string" },
                  test_function: { type: "string" },
                  action: { type: "string", enum: ["covered", "test_created", "no_test"] },
                },
                required: ["contract_id", "fixture_type", "fixture_path", "test_exists", "test_exercises_full_flow", "action"],
              },
            },
            tests_created: {
              type: "array",
              description: "List of test files created.",
              items: { type: "string" },
            },
          },
          required: ["fixtures"],
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
    const testsContracts = "tests/contracts";
    const testsLive = "tests/live";
    const testsExecution = "tests/execution";
    const isActorDir = normalized === actorNorm || normalized.startsWith(`${actorNorm}/`);
    const isTestsContracts = normalized.startsWith(`${testsContracts}/`) || normalized === testsContracts;
    const isTestsLive = normalized.startsWith(`${testsLive}/`) || normalized === testsLive;
    const isTestsExecution = normalized.startsWith(`${testsExecution}/`) || normalized === testsExecution;
    const isTestsE2e = normalized.startsWith("tests/e2e/") || normalized === "tests/e2e";
    if (!isActorDir && !isTestsContracts && !isTestsLive && !isTestsExecution && !isTestsE2e) {
      throw new Error(`Write access denied for ${args.file_path} (must be under ${actorDir}, tests/contracts/, tests/live/, or tests/execution/)`);
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
    if (!isActorDir && !isTestsContracts && !isTestsLive && !isTestsExecution) {
      throw new Error(`Write access denied for ${args.directory_path} (must be under ${actorDir}, tests/contracts/, tests/live/, or tests/execution/)`);
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
      fixtures: args.fixtures ?? [],
      tests_created: args.tests_created ?? [],
    });
    const total = (args.fixtures ?? []).length;
    const covered = (args.fixtures ?? []).filter((f) => f.test_exercises_full_flow).length;
    if (total > 0) {
      logWarning(`FIXTURES: ${covered}/${total} covered`, workerLabel);
    } else {
      logProgress(`no registered fixtures found`, workerLabel);
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
  const allFixtures = manifests.reduce((sum, m) => sum + (m.fixtures?.length ?? 0), 0);
  const covered = manifests.reduce((sum, m) => sum + (m.fixtures?.filter((f) => f.test_exercises_full_flow).length ?? 0), 0);
  const testsCreated = manifests.reduce((sum, m) => sum + (m.tests_created?.length ?? 0), 0);

  return {
    repoPath,
    model,
    workerTimeoutSeconds,
    maxAgents,
    totalActors: workerResults.length,
    succeeded: ok.length,
    failed: failed.length,
    actors: actorDirs,
    allFixtures,
    covered,
    uncovered: allFixtures - covered,
    testsCreated,
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
    "# Z.AI Fixture E2E Coverage",
    "",
    "## Scope",
    `- Actors: ${report.actors.join(", ")}`,
    `- Model: ${report.model}`,
    `- Max agents: ${report.maxAgents}`,
    "",
    "## Results",
    `| Actor | Status | Fixtures | Covered | Tests Created | Summary |`,
    `|-------|--------|---------|---------|-------------|---------|`,
  ];

  for (const worker of report.workers) {
    const name = path.basename(worker.actor_dir);
    const manifest = report.manifests.find((m) => {
      const actorDir = normalizeRelativePath(worker.actor_dir);
      const manifestDir = normalizeRelativePath(m.actor_dir ?? "");
      return actorDir === manifestDir;
    });
    const fTotal = manifest?.fixtures?.length ?? 0;
    const fCovered = manifest?.fixtures?.filter((f) => f.test_exercises_full_flow).length ?? 0;
    if (worker.status === "fulfilled") {
      const covStr = fTotal === 0 ? "no fixtures" : `${colorize(`${fCovered}/${fTotal}`, fCovered === fTotal ? ANSI.green : ANSI.yellow)}`;
      lines.push(`| ${name} | ok | ${fTotal} | ${covStr} | ${(manifest?.tests_created?.length ?? 0)} | ${worker.summary ?? ""} |`);
    } else {
      lines.push(`| ${name} | **failed** | — | — | — | ${worker.error ?? "unknown"} |`);
    }
  }

  lines.push("");
  lines.push(`Total: ${report.totalActors} actors, ${report.allFixtures} fixtures, ${report.covered} covered, ${report.uncovered} uncovered, ${report.testsCreated} tests created`);
  lines.push("");

  if (report.uncovered > 0) {
    lines.push("## Uncovered fixtures");
    for (const manifest of report.manifests) {
      const uncovered = (manifest.fixtures ?? []).filter((f) => !f.test_exercises_full_flow);
      if (uncovered.length === 0) continue;
      const actorName = path.basename(manifest.actor_dir ?? "unknown");
      lines.push(`### ${actorName}`);
      for (const f of uncovered) {
        lines.push(`- [${f.fixture_type}] \`${f.contract_id}\` → \`${f.fixture_path}\``);
      }
      lines.push("");
    }
  }

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

  logProgress(`starting fixture e2e coverage for ${repoPath}`);
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
    logProgress(`discovered ${actorDirs.length} actor(s) with fixture contracts`);
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
    flow: ["zai-fixture-e2e-coverage"],
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

  logProgress("loading manifests");
  const manifests = await loadManifests(outputDirectory, workerResults);
  const allFixtures = manifests.reduce((sum, m) => sum + (m.fixtures?.length ?? 0), 0);
  const covered = manifests.reduce((sum, m) => sum + (m.fixtures?.filter((f) => f.test_exercises_full_flow).length ?? 0), 0);
  logProgress(`manifests loaded: ${manifests.length} valid, ${covered}/${allFixtures} fixtures covered`);

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
    `Fixture E2E coverage complete for ${repoPath}`,
    `Actors: ${actorDirs.join(", ")}`,
    `Model: ${args.model}`,
    `Max agents: ${args.maxAgents}`,
    `Results: ${succeeded.length} succeeded, ${failed.length} failed`,
    `Fixtures: ${covered}/${allFixtures} covered, ${report.uncovered} uncovered`,
    `Tests created: ${report.testsCreated}`,
    `Artifacts: ${outputDirectory}`,
    `Changed files: ${finalDiff.length}`,
  ].join("\n") + "\n");

  if (failed.length > 0) {
    logWarning(`${failed.length} worker(s) failed: ${failed.map((r) => r.actorName).join(", ")}`);
  }

  if (report.uncovered > 0) {
    process.stdout.write(colorize(`\n[!] ${report.uncovered} fixture(s) have no E2E test coverage — see report.md for details.\n`, ANSI.yellow));
  } else if (allFixtures > 0) {
    process.stdout.write(colorize("\n[ok] All registered fixtures have E2E test coverage.\n", ANSI.green));
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
