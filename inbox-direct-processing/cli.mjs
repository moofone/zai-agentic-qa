#!/usr/bin/env node

import fs from "node:fs/promises";
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const DEFAULT_MODEL = "glm-5";
const DEFAULT_WORKER_TIMEOUT_SECONDS = 10 * 60;
const DEFAULT_API_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
const DEFAULT_MAX_AGENTS = 4;
const MAX_TOOL_ROUNDS = 128;
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
  "You are a direct inbox processing enforcer for a Rust project built on the icanact-core actor framework.",
  "Your job is to find and eliminate ALL indirect message processing patterns. In icanact-core, the mailbox IS the queue — messages arrive, the actor processes them immediately inline, done. Any code that introduces draining, polling, timers, batching, or intermediate queuing on top of the mailbox is a violation.",
  "",
  "## Core rule",
  "The icanact-core mailbox IS the queue. When a message arrives via Tell/Ask/PubSub, the actor processes it directly and immediately in the handler. There is NEVER a reason to drain, poll, batch, or re-queue messages.",
  "",
  "## Forbidden patterns",
  "The following patterns are FORBIDDEN in actor code (including tests and mocks):",
  "",
  "1. **Draining loops** — any loop that calls `drain()`, `pop()`, `try_recv()`, `try_next()`, or equivalent on a collection to process items one by one instead of handling messages directly:",
  "   - `while let Some(msg) = pending.drain(..).next() { ... }`",
  "   - `while let Ok(msg) = rx.try_recv() { ... }`",
  "   - `loop { match rx.try_next() { ... } }`",
  "   - `for item in buffer.drain(..) { ... }` (when used to defer/delay processing)",
  "   - Any pattern where messages are collected into a Vec/VecDeque and then drained in a loop",
  "",
  "2. **Polling / timer-based processing** — using `tokio::time::interval`, `tokio::time::sleep` in a loop, or `tokio::select!` with a timer branch to periodically check for work:",
  "   - `let mut interval = tokio::time::interval(Duration::from_millis(100)); loop { interval.tick().await; ... }`",
  "   - `tokio::time::sleep(Duration::from_millis(50)).await;` inside a loop that processes buffered items",
  "   - `tokio::select! { _ = timer => { check_and_process() }, ... }`",
  "",
  "3. **Intermediate queues / buffers on top of the mailbox** — stashing inbound messages into a `Vec`, `VecDeque`, `HashMap` or similar collection to be processed later, rather than handling them immediately in the message handler:",
  "   - `pending_messages: Vec<SomeMessage>` that accumulates messages for later processing",
  "   - `buffer: VecDeque<OrderEvent>` filled by one handler and drained by another",
  "   - `unprocessed: HashMap<u64, Task>` that defers work",
  "",
  "4. **Batch processing of inbound messages** — collecting multiple messages before processing them as a group:",
  "   - `batch: Vec<Update>` + `if batch.len() >= BATCH_SIZE { process_batch(&batch) }`",
  "   - Flushing logic that waits for N items or a timeout before processing",
  "",
  "5. **Spawn-for-message-forwarding** — spawning a `tokio::spawn` or `std::thread::spawn` whose sole purpose is to read from a channel/buffer and forward messages to the actor (the mailbox already does this):",
  "   - `tokio::spawn(async move { while let Some(msg) = rx.recv().await { addr.tell(msg) } })`",
  "",
  "## What IS allowed",
  "- The icanact-core mailbox itself (that's the whole point)",
  "- `tokio::time::sleep` used for a single timeout (e.g. waiting for an external response with a deadline) — NOT in a polling loop",
  "- `tokio::select!` used to race an async IO call against a timeout — NOT to poll a buffer",
  "- Iterating over a collection that was built synchronously within the same handler (e.g. `for position in &self.positions { ... }`) — this is just reading state, not draining a message queue",
  "- `drain()` used to CLEAR state (e.g. `self.pending_saga_events.drain(..)` to take ownership and return results) — this is a return-value pattern, not deferred processing",
  "- `take()` on an `Option` field to move ownership — same as above",
  "",
  "Exceptions (allowed, do NOT flag or change):",
  "  - Code inside shared crates (shared_ws, shared_restapi) — these use channels/buffers for IO transport, which is fine",
  "  - The icanact-core framework internals themselves",
  "",
  "## CustomRunnerActor — the ONLY exception for custom runtime behavior",
  "`CustomRunnerActor` trait implementations (via `spawn_with_custom_runner`) provide a `run_with_inbox` method that gives the actor a native async inbox loop. This is the ONE place where custom loop/select/sleep behavior is allowed, because the framework owns that loop — it IS the mailbox processor.",
  "",
  "What this means in practice:",
  "  - A `run_with_inbox` implementation that uses `tokio::select!` to multiplex inbox messages with IO (WS connections, REST calls) is ALLOWED — the select IS the mailbox handler",
  "  - A `run_with_inbox` implementation that processes messages from the framework's inbox in a loop is ALLOWED — it IS processing directly from the mailbox",
  "  - BUT: a `run_with_inbox` that drains a `Vec<VecDeque<...>>` buffer inside the loop instead of handling inbox messages directly is a violation — the inbox IS the queue",
  "  - This exception applies ONLY to code inside `impl CustomRunnerActor` blocks (typically in `custom_runner.rs` or `runtime.rs`)",
  "  - Any other actor code that has its own select loop, timer loop, or drain loop outside `CustomRunnerActor::run_with_inbox` is a violation",
  "",
  "## What to do",
  "1. Read `docs/ACTOR_SCHEMA.md` first for authoritative file-role definitions",
  "2. Search every `.rs` file in the actor directory for the forbidden patterns listed above",
  "3. For each match, read surrounding context to determine:",
  "   a. Is it inside a shared crate (shared_ws, shared_restapi)? → allowed, skip",
  "   b. Is it inside a `CustomRunnerActor::run_with_inbox` implementation that processes directly from the framework inbox? → allowed, note as exception",
  "   c. Is it a `drain()` / `take()` used purely as a return-value / ownership transfer (not deferred processing)? → allowed, note as exception",
  "   d. Is it a `tokio::time::sleep` for a single timeout, not in a loop? → allowed, note as exception",
  "   e. Is it iterating over state that was built synchronously in the same handler? → allowed, note as exception",
  "   f. Otherwise → it is a violation that must be fixed (including `#[cfg(test)]` blocks and `mock.rs`)",
  "4. **Fix every violation in-place** by rewriting the code so the actor processes each message directly in its handler",
  "5. Remove unused imports that were only needed by the forbidden pattern",
  "6. Write a manifest.json listing all violations fixed (or an empty array if already clean)",
  "",
  "## How to fix violations",
  "- **Draining loop over a Vec/VecDeque** → refactor so the message handler processes the item immediately. If items arrive from a Tell, handle them in the Tell handler. If items arrive from PubSub, handle them in the subscription callback. Remove the buffer field from the actor struct.",
  "- **Polling loop with interval/sleep** → replace with direct message handling. If the loop was checking external state, use PubSub subscriptions or periodic Tell from a supervisor instead. If it was draining a buffer, the buffer itself is the problem — remove it.",
  "- **Intermediate buffer that accumulates for later processing** → remove the buffer field. Each message should trigger its processing immediately in the handler that receives it.",
  "- **Batch processing with flush threshold** → process each item immediately as it arrives. If ordering matters, the mailbox already provides FIFO ordering. If atomicity matters, use a single handler that processes one logical unit.",
  "- **tokio::spawn forwarding loop** → the mailbox already delivers messages. Remove the spawn and have the sender route directly through the actor's address.",
  "",
  "## Manifest format",
  "Write via `write_manifest` with this structure:",
  "```json",
  "{",
  '  "fixes": [',
  "    {",
  '      "rule": "no_draining" | "no_polling" | "no_intermediate_queue" | "no_batching" | "no_spawn_forwarding",',
  '      "pattern": "while let Some(msg) = pending.drain(..).next()",',
  '      "file": "src/actors/.../business_logic.rs",',
  '      "line": 42,',
  '      "context": "brief excerpt of the original offending line",',
  '      "fix": "what was changed"',
  "    }",
  "  ],",
  '  "exceptions_noted": ["<file>:<line> — brief description of allowed usage"]',
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
  "- All cross-actor traffic goes through icanact-core traits (Tell/Ask/PubSub/Broadcast). shared_restapi and shared_ws are called from the actor's business_logic layer and never own or expose transports directly.",
  "- Parse REST/WS responses into concrete domain structs immediately and mutate actor state directly; don't stash raw JSON or spawn helper tasks.",
  "- All JSON parsing/deserialization MUST use `sonic_rs` — `serde_json` is forbidden in actor code.",
  "",
  "## Rules",
  "- Fix every violation in-place — rewrite the code so messages are processed directly",
  "- Be thorough: search every `.rs` file, not just messaging.rs",
  "- Distinguish carefully between allowed exceptions and true violations",
  "- If the actor is already clean, say so briefly and write an empty fixes array",
  "- Do NOT flag imports that are unused — only flag actual usage (function calls, type annotations, struct fields)",
  "- Do NOT modify code outside your assigned actor directory",
  "**After all fixes, run `cargo_check` to verify the code compiles.** If there are compilation errors, fix them and run `cargo_check` again. Repeat until it passes. Do NOT skip this step.",
  "Use the provided file tools to inspect code and make edits.",
  "Do the work now. Do not ask follow-up questions.",
].join("\n");

function buildUserPrompt(actorDir, actorName) {
  return [
    `You are fixing the actor module: ${actorDir}`,
    `Actor name: ${actorName}`,
    "",
    "Steps:",
    "1. Read docs/ACTOR_SCHEMA.md for authoritative structure definitions",
    "2. List all .rs files in the actor directory",
    "3. Search each file for draining loops, polling/timers, intermediate queues, batching, and spawn forwarding",
    "4. Read context around each match to classify as violation or allowed exception",
    "5. Fix every violation in-place so the actor processes messages directly",
    "6. Call write_manifest with your fixes",
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
    "  npm run inbox:direct -- --repo /absolute/path/to/repo",
    "    [--actors actor_dir_1,actor_dir_2]",
    "    [--max-agents N]",
    "    [--output /path/to/artifacts]",
    "    [--model glm-5-turbo]",
    "    [--worker-timeout-seconds N]",
    "    [--apply] [--dry-run]",
    "",
    "Defaults:",
    "  --actors auto-discovered (all actor directories under src/actors/)",
    `  --max-agents ${DEFAULT_MAX_AGENTS}`,
    `  --model ${DEFAULT_MODEL}`,
    `  --worker-timeout-seconds ${DEFAULT_WORKER_TIMEOUT_SECONDS}`,
    "  --apply write sandbox edits back to the real repo after validation",
    "  --output ./artifacts/zai-inbox-direct/<repo-name>-<timestamp>",
    "  requires Z_AI_API_KEY in the environment",
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
    if (arg === "--help" || arg === "-h") { result.help = true; continue; }
    if (arg === "--apply") { result.apply = true; continue; }
    if (arg === "--dry-run") { result.dryRun = true; continue; }
    if (arg === "--repo") { result.repo = argv[i + 1]; i += 1; continue; }
    if (arg === "--actors") { result.actors = argv[i + 1]; i += 1; continue; }
    if (arg === "--max-agents") { result.maxAgents = Number(argv[i + 1]); i += 1; continue; }
    if (arg === "--model") { result.model = argv[i + 1]; i += 1; continue; }
    if (arg === "--output") { result.output = argv[i + 1]; i += 1; continue; }
    if (arg === "--worker-timeout-seconds") { result.workerTimeoutSeconds = Number(argv[i + 1]); i += 1; continue; }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!result.help && !result.repo) throw new Error("Missing required argument: --repo");
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
  try { await fs.access(target); return true; } catch { return false; }
}

async function ensureDirectoryExists(directory, label) {
  const stats = await fs.stat(directory);
  if (!stats.isDirectory()) throw new Error(`${label} is not a directory: ${directory}`);
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

function colorize(message, color) { return `${color}${message}${ANSI.reset}`; }

function formatTimestampLabel() { return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z"); }

function formatLogPrefix(workerLabel) {
  const ts = `[${formatTimestampLabel()}]`;
  if (workerLabel) {
    return `${ts} ${colorize(`[${workerLabel}]`, getWorkerColor(workerLabel))} `;
  }
  return `${ts} `;
}

function logProgress(message, workerLabel) { process.stdout.write(`${formatLogPrefix(workerLabel)}${message}\n`); }
function logWarning(message, workerLabel) { process.stdout.write(colorize(`${formatLogPrefix(workerLabel)}${message}\n`, ANSI.yellow)); }
function logError(message, workerLabel) { process.stderr.write(colorize(`${formatLogPrefix(workerLabel)}${message}\n`, ANSI.red)); }

function normalizeRelativePath(value) { return value.replaceAll("\\", "/").replace(/\/+$/, ""); }

function summarizeText(text, maxLength = 160) {
  const flattened = String(text).replace(/\s+/g, " ").trim();
  if (!flattened) return "no text";
  return flattened.length <= maxLength ? flattened : `${flattened.slice(0, maxLength - 1)}...`;
}

function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object") {
        if (typeof part.text === "string") return part.text;
        if (typeof part.content === "string") return part.content;
      }
      return "";
    }).join("\n");
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
    try { entries = await fs.readdir(currentDirectory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolutePath = path.join(currentDirectory, entry.name);
      const relativePath = path.relative(rootDirectory, absolutePath).replaceAll("\\", "/");
      if (normalizedIgnoredPrefixes.some((prefix) => relativePath === prefix || relativePath.startsWith(`${prefix}/`))) continue;
      if (entry.isDirectory()) { await walk(absolutePath); continue; }
      if (entry.isFile()) { files.push(relativePath); }
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
  const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "zai-inbox-direct-sandbox-"));
  const sandboxPath = path.join(sandboxRoot, repoNameFromPath(repoPath));
  await fs.mkdir(sandboxPath, { recursive: true });

  for (const root of ["src/actors", "src", "docs"]) {
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

  const buildRs = path.join(repoPath, "build.rs");
  if (await pathExists(buildRs)) {
    await fs.copyFile(buildRs, path.join(sandboxPath, "build.rs"));
  }

  await fs.writeFile(path.join(outputDirectory, "sandbox-path.txt"), `${sandboxPath}\n`, "utf8");
  return { sandboxRoot, sandboxPath };
}

async function buildOutputDirectory(repoPath, explicitOutput) {
  const baseDirectory = explicitOutput
    ? path.resolve(explicitOutput)
    : path.resolve("artifacts", "zai-inbox-direct", `${repoNameFromPath(repoPath)}-${timestamp()}`);
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

  const actorDirs = new Set();

  async function walk(currentDir) {
    let entries;
    try { entries = await fs.readdir(currentDir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        const modRs = path.join(fullPath, "mod.rs");
        if (await pathExists(modRs)) {
          const rel = normalizeRelativePath(path.relative(repoPath, fullPath));
          if (rel.startsWith("src/actors/")) {
            actorDirs.add(rel);
          }
        }
        await walk(fullPath);
      }
    }
  }

  await walk(srcActorsDir);
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
          properties: { file_path: { type: "string", description: "Relative file path to read." } },
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
          properties: { directory_path: { type: "string", description: "Relative directory path to inspect." } },
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
        description: "Overwrite a file with updated content. Use for fixing violations in source files within the assigned actor directory.",
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
        name: "write_manifest",
        description: "Write the audit manifest. Call this at the END of your work.",
        parameters: {
          type: "object",
          properties: {
            fixes: {
              type: "array",
              description: "List of fixes applied.",
              items: {
                type: "object",
                properties: {
                  rule: { type: "string", enum: ["no_draining", "no_polling", "no_intermediate_queue", "no_batching", "no_spawn_forwarding"] },
                  pattern: { type: "string" },
                  file: { type: "string" },
                  line: { type: "number" },
                  context: { type: "string" },
                  fix: { type: "string" },
                },
                required: ["rule", "pattern", "file", "line", "context", "fix"],
              },
            },
            exceptions_noted: {
              type: "array",
              description: "List of allowed usages that were inspected but not changed.",
              items: { type: "string" },
            },
          },
          required: ["fixes"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "cargo_check",
        description: "Run `cargo check` in the sandbox. Call as your FINAL step after all fixes.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
  ];
}

function toAbsoluteSandboxPath(sandboxRepoPath, relativePath) {
  return path.resolve(sandboxRepoPath, normalizeRelativePath(relativePath));
}

function ensureAllowedPath(relativePath) {
  let normalized = normalizeRelativePath(relativePath);
  if (normalized === "." || normalized === "./" || normalized === "") normalized = "src";
  if (
    normalized.startsWith("src/") || normalized === "src" ||
    normalized.startsWith("docs/") || normalized === "docs" ||
    normalized.startsWith("tests/") || normalized === "tests" ||
    normalized === "Cargo.toml" || normalized === "build.rs"
  ) return normalized;
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
    return { ok: true, directory_path: relativePath, matches: result.stdout.trim() ? result.stdout.trim().split("\n") : [] };
  }

  if (name === "write_file") {
    const normalized = normalizeRelativePath(args.file_path);
    const actorNorm = normalizeRelativePath(actorDir);
    if (normalized !== actorNorm && !normalized.startsWith(`${actorNorm}/`)) {
      throw new Error(`Write access denied for ${args.file_path} (must be under ${actorDir})`);
    }
    const absolutePath = toAbsoluteSandboxPath(sandboxRepoPath, normalized);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    const before = (await pathExists(absolutePath)) ? await fs.readFile(absolutePath, "utf8") : "";
    await fs.writeFile(absolutePath, args.content, "utf8");
    logWarning(`tool:write_file ${normalized}`, workerLabel);
    return { ok: true, file_path: normalized, changed: before !== args.content, created: !before };
  }

  if (name === "write_manifest") {
    const manifestPath = path.join(workerOutputDir, "manifest.json");
    await fs.mkdir(workerOutputDir, { recursive: true });
    await writeJson(manifestPath, {
      actor_dir: actorDir,
      fixes: args.fixes ?? [],
      exceptions_noted: args.exceptions_noted ?? [],
    });
    const count = (args.fixes ?? []).length;
    if (count > 0) {
      logWarning(`FIXED: ${count} violation(s)`, workerLabel);
    } else {
      logProgress(`clean — no violations`, workerLabel);
    }
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
      body: JSON.stringify({ model, messages, tools, tool_choice: "auto", parallel_tool_calls: false, temperature: 0.1, stream: false }),
      signal: controller.signal,
    });

    const text = await response.text();
    await fs.writeFile(path.join(outputDirectory, `zai-round-${String(round).padStart(2, "0")}.json`), `${text}\n`, "utf8");
    if (!response.ok) throw new Error(`Z.AI request failed with ${response.status}: ${text}`);
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
  throw new Error("Missing Z_AI_API_KEY.");
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
    if (elapsedMs >= workerTimeoutMs) throw new Error(`Timed out after ${Math.round(workerTimeoutMs / 1000)}s.`);

    logProgress(`model round ${round}`, workerLabel);
    const response = await callZaiChat({
      apiKey, model, messages, tools,
      timeoutMs: Math.max(30000, workerTimeoutMs - elapsedMs),
      outputDirectory, round,
    });

    const choice = response.choices?.[0];
    const message = choice?.message;
    if (!message) throw new Error(`Z.AI response did not contain a message in round ${round}.`);

    messages.push({ role: "assistant", content: message.content ?? "", tool_calls: message.tool_calls });

    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      for (const toolCall of message.tool_calls) {
        const result = await executeToolCall(toolCall, { sandboxRepoPath, actorDir, workerOutputDir: outputDirectory, workerLabel });
        messages.push({ role: "tool", tool_call_id: toolCall.id, content: JSON.stringify(result) });
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

      const promise = runWorker({ apiKey, model, outputDirectory: workerDir, sandboxRepoPath, actorDir, actorName, workerTimeoutMs, workerLabel })
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
      try { manifests.push(JSON.parse(await fs.readFile(manifestPath, "utf8"))); } catch { logWarning(`malformed manifest for ${result.actorName}`, result.workerLabel); }
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
      diffs.push({ file: `${scopeDir}/${relativeFile}`, before, after });
    }
  }
  return diffs;
}

function buildAggregatedReport({ repoPath, model, workerTimeoutSeconds, maxAgents, actorDirs, workerResults, manifests, finalDiff }) {
  const ok = workerResults.filter((r) => r.status === "fulfilled");
  const failed = workerResults.filter((r) => r.status === "rejected");
  const totalFixes = manifests.reduce((sum, m) => sum + (m.fixes?.length ?? 0), 0);
  const cleanActors = manifests.filter((m) => (m.fixes?.length ?? 0) === 0).length;

  return {
    repoPath, model, workerTimeoutSeconds, maxAgents,
    totalActors: workerResults.length, succeeded: ok.length, failed: failed.length,
    actors: actorDirs, cleanActors, dirtyActors: manifests.filter((m) => (m.fixes?.length ?? 0) > 0).length, totalFixes,
    workers: workerResults.map((r) => ({
      actor_dir: r.actorDir, status: r.status,
      summary: r.status === "fulfilled" ? summarizeText(r.summary, 512) : undefined,
      error: r.status === "rejected" ? r.error : undefined,
    })),
    manifests,
    changedFiles: finalDiff.map((d) => ({ file: d.file })),
  };
}

function buildAggregatedMarkdown(report) {
  const lines = [
    "# Z.AI Inbox Direct Processing Fix",
    "",
    `- Actors: ${report.actors.join(", ")}`,
    `- Model: ${report.model}`,
    `- Max agents: ${report.maxAgents}`,
    "",
    `| Actor | Status | Fixes | Summary |`,
    `|-------|--------|-------|---------|`,
  ];

  for (const worker of report.workers) {
    const name = path.basename(worker.actor_dir);
    const manifest = report.manifests.find((m) => normalizeRelativePath(worker.actor_dir) === normalizeRelativePath(m.actor_dir ?? ""));
    const fCount = manifest?.fixes?.length ?? 0;
    if (worker.status === "fulfilled") {
      lines.push(`| ${name} | ok | ${fCount === 0 ? "clean" : `${fCount} fixed`} | ${worker.summary ?? ""} |`);
    } else {
      lines.push(`| ${name} | **failed** | — | ${worker.error ?? "unknown"} |`);
    }
  }

  lines.push("");
  lines.push(`Total: ${report.totalActors} actors, ${report.cleanActors} clean, ${report.dirtyActors} with fixes, ${report.totalFixes} total`);
  lines.push("");

  if (report.totalFixes > 0) {
    lines.push("## Fixes");
    for (const manifest of report.manifests) {
      if (!manifest.fixes?.length) continue;
      lines.push(`### ${path.basename(manifest.actor_dir ?? "unknown")}`);
      for (const f of manifest.fixes) {
        lines.push(`- \`${f.file}:${f.line}\` — ${f.rule} — \`${f.pattern}\` — ${f.fix}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(`${usage()}\n`); return; }

  const repoPath = path.resolve(args.repo);
  const srcPath = path.join(repoPath, "src");
  const outputDirectory = await buildOutputDirectory(repoPath, args.output);
  const apiKey = await resolveApiKey();

  logProgress(`starting inbox direct processing fix for ${repoPath}`);
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
    logProgress(`discovered ${actorDirs.length} actor(s)`);
  }

  if (actorDirs.length === 0) throw new Error("No actors found. Use --actors to specify explicitly.");

  const { sandboxRoot, sandboxPath: sandboxRepoPath } = await createSandbox(repoPath, outputDirectory);

  await writeJson(path.join(outputDirectory, "run-config.json"), {
    repoPath, sandboxRepoPath, outputDirectory, apiBaseUrl: DEFAULT_API_BASE_URL,
    model: args.model, maxAgents: args.maxAgents, workerTimeoutSeconds: args.workerTimeoutSeconds,
    flow: ["zai-inbox-direct"], actorDirs,
  });

  if (args.dryRun) {
    process.stdout.write([`Dry run ready.`, `Repo: ${repoPath}`, `Actors (${actorDirs.length}):`, ...actorDirs.map((d) => `  ${d}`)].join("\n") + "\n");
    await fs.rm(sandboxRoot, { recursive: true, force: true, maxRetries: 3 });
    return;
  }

  logProgress(`sandbox ready at ${sandboxRepoPath}`);

  const workerResults = await runAllWorkers({
    actors: actorDirs, apiKey, model: args.model, sandboxRepoPath, outputDirectory,
    workerTimeoutMs: args.workerTimeoutSeconds * 1000, maxAgents: args.maxAgents,
  });

  const succeeded = workerResults.filter((r) => r.status === "fulfilled").length;
  const failed = workerResults.filter((r) => r.status === "rejected").length;
  logProgress(`all workers settled: ${succeeded} succeeded, ${failed} failed`);

  const manifests = await loadManifests(outputDirectory, workerResults);
  const totalFixes = manifests.reduce((sum, m) => sum + (m.fixes?.length ?? 0), 0);

  const diffScopeDirs = [...actorDirs];
  const finalDiff = await diffDirectories(repoPath, sandboxRepoPath, diffScopeDirs);

  const allowedPrefixes = diffScopeDirs.map(normalizeRelativePath);
  const unauthorizedFiles = finalDiff.map((d) => d.file).filter((file) => {
    const normalized = normalizeRelativePath(file);
    return !allowedPrefixes.some((dir) => normalized === dir || normalized.startsWith(`${dir}/`));
  });
  if (unauthorizedFiles.length > 0) throw new Error(`Unauthorized file modifications: ${unauthorizedFiles.join(", ")}`);

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

  const report = buildAggregatedReport({ repoPath, model: args.model, workerTimeoutSeconds: args.workerTimeoutSeconds, maxAgents: args.maxAgents, actorDirs, workerResults, manifests, finalDiff });
  await writeJson(path.join(outputDirectory, "report.json"), report);
  await fs.writeFile(path.join(outputDirectory, "report.md"), buildAggregatedMarkdown(report), "utf8");

  process.stdout.write([
    `Inbox direct processing complete for ${repoPath}`,
    `Results: ${succeeded} ok, ${failed} failed, ${totalFixes} fix(es)`,
    `Changed files: ${finalDiff.length}`,
  ].join("\n") + "\n");

  if (totalFixes > 0) {
    process.stdout.write(colorize(`\n[!] ${totalFixes} fix(es) applied.\n`, ANSI.yellow));
  } else {
    process.stdout.write(colorize("\n[ok] All actors process messages directly — no violations.\n", ANSI.green));
  }

  try { await fs.rm(sandboxRoot, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ }
}

run().catch(async (error) => {
  logError(error instanceof Error ? error.message : String(error));
  try {
    const artifactsDir = process.argv.includes("--output") ? path.resolve(process.argv[process.argv.indexOf("--output") + 1]) : undefined;
    if (artifactsDir) {
      const sandboxPathFile = path.join(artifactsDir, "sandbox-path.txt");
      if (await pathExists(sandboxPathFile)) {
        const sandboxPath = (await fs.readFile(sandboxPathFile, "utf8")).trim();
        await fs.rm(path.dirname(sandboxPath), { recursive: true, force: true, maxRetries: 3 });
      }
    }
  } catch { /* best effort */ }
  process.exitCode = 1;
});
