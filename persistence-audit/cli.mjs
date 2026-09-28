#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const DEFAULT_MODEL = "glm-5";
const DEFAULT_WORKER_TIMEOUT_SECONDS = 10 * 60;
const DEFAULT_API_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
const DEFAULT_MAX_AGENTS = 3;
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
  "You are a persistence layer auditor for a Rust project built on the icanact-core actor framework.",
  "Your job is to identify violations of the DurableState vs Heed/LMDB usage guidelines.",
  "This is a REPORT-ONLY audit — you will NOT modify any files, only report findings.",
  "",
  "## Rule: DurableState for state, Heed/LMDB for database",
  "",
  "**DurableState** — for simple \"last state\" persistence:",
  "  - Serialized blob backup of an actor's current state",
  "  - Recovery after restart (single snapshot restore)",
  "  - NOT meant as a key-value database",
  "  - Use when you just need to persist and restore the actor's state",
  "",
  "**Custom Heed/LMDB code** — for actual database needs:",
  "  - Key-value queries (get by key, range scans)",
  "  - Multiple indexes or lookup tables",
  "  - Historical data with time-series queries",
  "  - Complex data relationships",
  "  - Allowed when you need actual database functionality",
  "",
  "## What counts as a violation",
  "",
  "**Violation: Custom Heed/LMDB for simple state**",
  "  - Opening a Heed database just to store a single serialized blob",
  "  - Using LMDB when you only ever read/write one key",
  "  - Implementing custom snapshot/restore logic with Heed when DurableState would suffice",
  "",
  "**Violation: DurableState for database-like operations**",
  "  - Storing a HashMap/Vec in DurableState and querying it on restore (should use Heed)",
  "  - DurableState payload exceeds ~1MB due to accumulated history (should use Heed)",
  "  - Manual indexing logic inside a DurableState-backed struct",
  "",
  "## What is NOT a violation (allowed)",
  "",
  "- DurableState used for simple actor state backup/restore",
  "- Heed/LMDB used for key-value storage with actual queries",
  "- Heed used for time-series data, order books, trade history, etc.",
  "- Custom Heed databases for specialized access patterns",
  "",
  "## What to do",
  "1. Read `docs/ACTOR_SCHEMA.md` first for context",
  "2. Search the actor directory for:",
  "   - `heed::` / `lmdb::` / `heed::Database` / `heed::Env`",
  "   - `DurableState` / `durable_state` / `persist_state`",
  "   - Custom database opening/management code",
  "3. For each usage, determine if it's a violation or allowed",
  "4. Write a manifest.json listing all findings (violations AND allowed usages)",
  "",
  "## Manifest format",
  "Write via `write_manifest` with this structure:",
  "```json",
  "{",
  '  "actor_dir": "src/actors/...",',
  '  "violations": [',
  "    {",
  '      "type": "heed_for_simple_state" | "durable_state_for_database",',
  '      "file": "src/actors/.../persistence.rs",',
  '      "line": 42,',
  '      "context": "brief excerpt of the offending code",',
  '      "recommendation": "use DurableState" | "use Heed with proper schema",',
  '      "severity": "high" | "medium" | "low"',
  "    }",
  "  ],",
  '  "allowed_usages": [',
  "    {",
  '      "type": "durable_state" | "heed_database",',
  '      "file": "src/actors/.../persistence.rs",',
  '      "line": 42,',
  '      "context": "brief description of why this is correct usage"',
  "    }",
  "  ]",
  "}",
  "```",
  "",
  "## Severity guidelines",
  "- **high**: Clear misuse (Heed for single-key blob, DurableState >1MB with query logic)",
  "- **medium**: Questionable pattern, worth reviewing",
  "- **low**: Minor concern, likely fine but flag for awareness",
  "",
  "## Rules",
  "- This is READ-ONLY — do NOT attempt to modify any code",
  "- Report ALL findings, not just violations — we want a complete picture",
  "- If no persistence code found in the actor, report empty arrays",
  "- Do NOT search outside your assigned actor directory",
  "Do the work now. Do not ask follow-up questions.",
].join("\n");

function buildUserPrompt(actorDir, actorName) {
  return [
    `You are auditing the actor module: ${actorDir}`,
    `Actor name: ${actorName}`,
    "",
    "This is a REPORT-ONLY audit — you will NOT modify any files.",
    "",
    "Steps:",
    "1. Read docs/ACTOR_SCHEMA.md for context",
    "2. List all .rs files in the actor directory",
    "3. Search for persistence-related code:",
    "   - heed:: / lmdb:: / heed::Database / heed::Env",
    "   - DurableState / durable_state / persist_state",
    "4. For each usage, classify as violation or allowed usage",
    "5. Call write_manifest with your findings",
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
    "  npm run persistence:audit -- --repo /absolute/path/to/repo",
    "    [--actors actor_dir_1,actor_dir_2]",
    "    [--max-agents N]",
    "    [--output /path/to/artifacts]",
    "    [--model glm-5]",
    "    [--worker-timeout-seconds N]",
    "    [--dry-run]",
    "",
    "Defaults:",
    "  --actors auto-discovered (all actor directories under src/actors/)",
    `  --max-agents ${DEFAULT_MAX_AGENTS}`,
    `  --model ${DEFAULT_MODEL}`,
    `  --worker-timeout-seconds ${DEFAULT_WORKER_TIMEOUT_SECONDS}`,
    "  --output ./artifacts/zai-persistence-audit/<repo-name>-<timestamp>",
    "  requires Z_AI_API_KEY in the environment",
    "",
    "This is a REPORT-ONLY audit — no files will be modified.",
  ].join("\n");
}

function parseArgs(argv) {
  const result = {
    actors: null,
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
// File listing
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

async function buildOutputDirectory(repoPath, explicitOutput) {
  const baseDirectory = explicitOutput
    ? path.resolve(explicitOutput)
    : path.resolve("artifacts", "zai-persistence-audit", `${repoNameFromPath(repoPath)}-${timestamp()}`);
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
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
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
// Tools (read-only — no write tools)
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
        name: "write_manifest",
        description: "Write the audit manifest. The file is written automatically to your output directory. Call this at the END of your work.",
        parameters: {
          type: "object",
          properties: {
            violations: {
              type: "array",
              description: "List of violations found.",
              items: {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["heed_for_simple_state", "durable_state_for_database"] },
                  file: { type: "string" },
                  line: { type: "number" },
                  context: { type: "string" },
                  recommendation: { type: "string" },
                  severity: { type: "string", enum: ["high", "medium", "low"] },
                },
                required: ["type", "file", "line", "context", "recommendation", "severity"],
              },
            },
            allowed_usages: {
              type: "array",
              description: "List of allowed usages found.",
              items: {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["durable_state", "heed_database"] },
                  file: { type: "string" },
                  line: { type: "number" },
                  context: { type: "string" },
                },
                required: ["type", "file", "line", "context"],
              },
            },
          },
          required: ["violations", "allowed_usages"],
        },
      },
    },
  ];
}

function toAbsolutePath(repoPath, relativePath) {
  return path.resolve(repoPath, normalizeRelativePath(relativePath));
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
  const { repoPath, actorDir, workerOutputDir, workerLabel } = context;
  const name = toolCall.function.name;
  const args = JSON.parse(toolCall.function.arguments || "{}");

  if (name === "read_file") {
    const relativePath = ensureAllowedPath(args.file_path);
    const absolutePath = toAbsolutePath(repoPath, relativePath);
    const content = await fs.readFile(absolutePath, "utf8");
    logProgress(`tool:read_file ${relativePath}`, workerLabel);
    return { ok: true, file_path: relativePath, content };
  }

  if (name === "list_files") {
    const relativePath = ensureAllowedPath(args.directory_path);
    const absolutePath = toAbsolutePath(repoPath, relativePath);
    const entries = await listFilesRecursive(absolutePath, DEFAULT_EXCLUDED_PATHS);
    logProgress(`tool:list_files ${relativePath}`, workerLabel);
    return { ok: true, directory_path: relativePath, files: entries };
  }

  if (name === "search_files") {
    const relativePath = ensureAllowedPath(args.directory_path);
    const absolutePath = toAbsolutePath(repoPath, relativePath);
    const result = await execRg(["-n", "--hidden", "--no-follow", args.query, absolutePath], repoPath);
    logProgress(`tool:search_files ${relativePath} query=${JSON.stringify(args.query)}`, workerLabel);
    return {
      ok: true,
      directory_path: relativePath,
      matches: result.stdout.trim() ? result.stdout.trim().split("\n") : [],
    };
  }

  if (name === "write_manifest") {
    const manifestPath = path.join(workerOutputDir, "manifest.json");
    await fs.mkdir(workerOutputDir, { recursive: true });
    await writeJson(manifestPath, {
      actor_dir: actorDir,
      violations: args.violations ?? [],
      allowed_usages: args.allowed_usages ?? [],
    });
    const violationCount = (args.violations ?? []).length;
    const allowedCount = (args.allowed_usages ?? []).length;
    if (violationCount > 0) {
      logWarning(`FOUND: ${violationCount} violation(s), ${allowedCount} allowed usage(s)`, workerLabel);
    } else if (allowedCount > 0) {
      logProgress(`clean — ${allowedCount} allowed usage(s), no violations`, workerLabel);
    } else {
      logProgress(`clean — no persistence code found`, workerLabel);
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
  const { apiKey, model, outputDirectory, repoPath, actorDir, actorName, workerTimeoutMs, workerLabel } = context;
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
        const result = await executeToolCall(toolCall, { repoPath, actorDir, workerOutputDir: outputDirectory, workerLabel });
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

async function runAllWorkers({ actors, apiKey, model, repoPath, outputDirectory, workerTimeoutMs, maxAgents }) {
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
        repoPath,
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

function buildAggregatedReport({ repoPath, model, workerTimeoutSeconds, maxAgents, actorDirs, workerResults, manifests }) {
  const ok = workerResults.filter((r) => r.status === "fulfilled");
  const failed = workerResults.filter((r) => r.status === "rejected");
  const totalViolations = manifests.reduce((sum, m) => sum + (m.violations?.length ?? 0), 0);
  const totalAllowed = manifests.reduce((sum, m) => sum + (m.allowed_usages?.length ?? 0), 0);
  const cleanActors = manifests.filter((m) => (m.violations?.length ?? 0) === 0).length;
  const dirtyActors = manifests.filter((m) => (m.violations?.length ?? 0) > 0);

  const highSeverity = manifests.reduce((sum, m) => sum + (m.violations?.filter(v => v.severity === "high").length ?? 0), 0);
  const mediumSeverity = manifests.reduce((sum, m) => sum + (m.violations?.filter(v => v.severity === "medium").length ?? 0), 0);
  const lowSeverity = manifests.reduce((sum, m) => sum + (m.violations?.filter(v => v.severity === "low").length ?? 0), 0);

  return {
    repoPath,
    model,
    workerTimeoutSeconds,
    maxAgents,
    totalActors: workerResults.length,
    succeeded: ok.length,
    failed: failed.length,
    actors: actorDirs,
    cleanActors,
    dirtyActors: dirtyActors.length,
    totalViolations,
    totalAllowed,
    highSeverity,
    mediumSeverity,
    lowSeverity,
    workers: workerResults.map((r) => ({
      actor_dir: r.actorDir,
      status: r.status,
      summary: r.status === "fulfilled" ? summarizeText(r.summary, 512) : undefined,
      error: r.status === "rejected" ? r.error : undefined,
    })),
    manifests,
  };
}

function buildAggregatedMarkdown(report) {
  const lines = [
    "# Z.AI Persistence Audit",
    "",
    "## Scope",
    `- Repo: ${report.repoPath}`,
    `- Actors: ${report.actors.length}`,
    `- Model: ${report.model}`,
    `- Max agents: ${report.maxAgents}`,
    "",
    "## Summary",
    `| Metric | Count |`,
    `|--------|-------|`,
    `| Total Actors | ${report.totalActors} |`,
    `| Clean Actors | ${report.cleanActors} |`,
    `| Actors with Violations | ${report.dirtyActors} |`,
    `| Total Violations | ${report.totalViolations} |`,
    `| Allowed Usages | ${report.totalAllowed} |`,
    "",
    "## Severity Breakdown",
    `| Severity | Count |`,
    `|----------|-------|`,
    `| High | ${report.highSeverity} |`,
    `| Medium | ${report.mediumSeverity} |`,
    `| Low | ${report.lowSeverity} |`,
    "",
    "## Results by Actor",
    `| Actor | Status | Violations | Allowed | Summary |`,
    `|-------|--------|------------|---------|---------|`,
  ];

  for (const worker of report.workers) {
    const name = path.basename(worker.actor_dir);
    const manifest = report.manifests.find((m) => {
      const actorDir = normalizeRelativePath(worker.actor_dir);
      const manifestDir = normalizeRelativePath(m.actor_dir ?? "");
      return actorDir === manifestDir;
    });
    const vCount = manifest?.violations?.length ?? 0;
    const aCount = manifest?.allowed_usages?.length ?? 0;
    if (worker.status === "fulfilled") {
      const vStr = vCount === 0 ? "0" : colorize(`${vCount}`, vCount > 0 ? ANSI.yellow : ANSI.green);
      lines.push(`| ${name} | ok | ${vStr} | ${aCount} | ${worker.summary ?? ""} |`);
    } else {
      lines.push(`| ${name} | **failed** | — | — | ${worker.error ?? "unknown"} |`);
    }
  }

  if (report.totalViolations > 0) {
    lines.push("");
    lines.push("## Violations");
    for (const manifest of report.manifests) {
      if (!manifest.violations || manifest.violations.length === 0) continue;
      const actorName = path.basename(manifest.actor_dir ?? "unknown");
      lines.push(`### ${actorName}`);
      for (const v of manifest.violations) {
        lines.push(`- \`${v.file}:${v.line}\` — **${v.severity}** — ${v.type}`);
        lines.push(`  - Context: ${v.context}`);
        lines.push(`  - Recommendation: ${v.recommendation}`);
      }
      lines.push("");
    }
  }

  lines.push("");
  lines.push("## Allowed Usages");
  let hasAllowed = false;
  for (const manifest of report.manifests) {
    if (!manifest.allowed_usages || manifest.allowed_usages.length === 0) continue;
    hasAllowed = true;
    const actorName = path.basename(manifest.actor_dir ?? "unknown");
    lines.push(`### ${actorName}`);
    for (const a of manifest.allowed_usages) {
      lines.push(`- \`${a.file}:${a.line}\` — ${a.type}: ${a.context}`);
    }
    lines.push("");
  }
  if (!hasAllowed) {
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

  logProgress(`starting persistence audit for ${repoPath}`);
  logProgress(`artifacts will be written to ${outputDirectory}`);
  logProgress(`model ${args.model}`);
  logWarning(`using Z_AI_API_KEY ${maskSecret(apiKey)}`);
  logProgress(`max agents: ${args.maxAgents}`);
  logProgress(`worker timeout: ${args.workerTimeoutSeconds}s`);
  logWarning(`REPORT-ONLY mode — no files will be modified`);

  await ensureDirectoryExists(repoPath, "Repository path");
  await ensureDirectoryExists(srcPath, "src directory");

  let actorDirs;
  if (args.actors) {
    actorDirs = args.actors.split(",").map(normalizeRelativePath).filter(Boolean);
    logProgress(`using explicit actors: ${actorDirs.join(", ")}`);
  } else {
    actorDirs = await discoverActors(repoPath);
    logProgress(`discovered ${actorDirs.length} actor(s) under src/actors/`);
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

  await writeJson(path.join(outputDirectory, "run-config.json"), {
    repoPath,
    outputDirectory,
    apiBaseUrl: DEFAULT_API_BASE_URL,
    model: args.model,
    maxAgents: args.maxAgents,
    workerTimeoutSeconds: args.workerTimeoutSeconds,
    flow: ["zai-persistence-audit"],
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
    return;
  }

  logProgress(`launching ${actorDirs.length} worker(s) with concurrency ${args.maxAgents}`);

  const workerResults = await runAllWorkers({
    actors: actorDirs,
    apiKey,
    model: args.model,
    repoPath,
    outputDirectory,
    workerTimeoutMs: args.workerTimeoutSeconds * 1000,
    maxAgents: args.maxAgents,
  });

  const succeeded = workerResults.filter((r) => r.status === "fulfilled");
  const failed = workerResults.filter((r) => r.status === "rejected");
  logProgress(`all workers settled: ${succeeded.length} succeeded, ${failed.length} failed`);

  logProgress("loading manifests");
  const manifests = await loadManifests(outputDirectory, workerResults);
  const totalViolations = manifests.reduce((sum, m) => sum + (m.violations?.length ?? 0), 0);
  const totalAllowed = manifests.reduce((sum, m) => sum + (m.allowed_usages?.length ?? 0), 0);
  logProgress(`manifests loaded: ${manifests.length} valid, ${totalViolations} violation(s), ${totalAllowed} allowed usage(s)`);

  await writeJson(path.join(outputDirectory, "manifests.json"), manifests);

  const report = buildAggregatedReport({
    repoPath,
    model: args.model,
    workerTimeoutSeconds: args.workerTimeoutSeconds,
    maxAgents: args.maxAgents,
    actorDirs,
    workerResults,
    manifests,
  });
  await writeJson(path.join(outputDirectory, "report.json"), report);
  await fs.writeFile(path.join(outputDirectory, "report.md"), buildAggregatedMarkdown(report), "utf8");
  logProgress("artifacts written");

  process.stdout.write([
    `Persistence audit complete for ${repoPath}`,
    `Actors: ${actorDirs.length}`,
    `Model: ${args.model}`,
    `Max agents: ${args.maxAgents}`,
    `Results: ${succeeded.length} succeeded, ${failed.length} failed`,
    `Violations: ${totalViolations} found across ${manifests.filter((m) => (m.violations?.length ?? 0) > 0).length} actor(s)`,
    `Allowed usages: ${totalAllowed}`,
    `Artifacts: ${outputDirectory}`,
  ].join("\n") + "\n");

  if (failed.length > 0) {
    logWarning(`${failed.length} worker(s) failed: ${failed.map((r) => r.actorName).join(", ")}`);
  }

  if (totalViolations > 0) {
    process.stdout.write(colorize(`\n[!] ${totalViolations} violation(s) found — see report.md for details.\n`, ANSI.yellow));
  } else {
    process.stdout.write(colorize("\n[ok] All actors are clean — no violations found.\n", ANSI.green));
  }
}

run().catch((error) => {
  logError(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
