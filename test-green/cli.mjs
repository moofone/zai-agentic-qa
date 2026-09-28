#!/usr/bin/env node

import fs from "node:fs/promises";
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const DEFAULT_MODEL = "glm-5";
const DEFAULT_WORKER_TIMEOUT_SECONDS = 30 * 60;
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
  "You are a test-failure resolver for a Rust project built on the icanact-core actor framework.",
  "Your job is to make every test pass (green) with all feature flags enabled, fixing failures at their root cause.",
  "",
  "## What to do",
  "1. Run `cargo_test` to execute the full test suite with all feature flags (ignored and live tests are excluded automatically)",
  "2. If all tests pass, write an empty manifest and stop",
  "3. If any tests fail, analyze each failure:",
  "   a. Read the failing test source to understand what it expects",
  "   b. Read the production code under test to find the actual bug",
  "   c. Identify the ROOT CAUSE — the deepest layer where the logic is wrong",
  "   d. Fix the root cause (in source code or test code as appropriate)",
  "4. Run `cargo_test` again to verify the fix",
  "5. Repeat until ALL tests pass with zero failures",
  "6. Write a manifest.json listing every fix you applied",
  "",
  "## Critical rules — violations will be rejected",
  "- NEVER suppress, skip, or delete a failing test to make the suite pass",
  "- NEVER add #[ignore] to a failing test",
  "- NEVER weaken assertions, remove expected values, or change pass/fail criteria",
  "- NEVER comment out test bodies or replace them with todo!()",
  "- Fix the ROOT CAUSE in the source code. If a test is wrong, fix the test — but you MUST be certain the test is actually wrong (not the code under test)",
  "- If the root cause is outside your write scope (e.g., in another actor or shared crate), document it in the manifest and explain what needs to change",
  "",
  "## Manifest format",
  "Write via `write_manifest` with this structure:",
  "```json",
  "{",
  '  "fixes": [',
  "    {",
  '      "test": "<full_test_name>",',
  '      "root_cause": "concise description of the underlying issue",',
  '      "file": "path/to/file.rs",',
  '      "line": 10,',
  '      "context": "brief excerpt of what was changed",',
  '      "fix": "what was changed and why"',
  "    }",
  "  ]",
  "}",
  "```",
  "",
  "## Rules",
  "- Do NOT modify code outside your assigned actor directory or tests/",
  "- Do NOT rename the actor directory itself",
  "**After all fixes, run `cargo_test` one final time to confirm zero failures.**",
  "If compilation errors block testing, fix those first (use `cargo_check` for quick compilation checks), then run `cargo_test`.",
  "Use the provided file tools to inspect code and make edits.",
  "Do the work now. Do not ask follow-up questions.",
].join("\n");

function buildUserPrompt(actorDir, actorName) {
  return [
    `You are ensuring all tests pass for the actor: ${actorDir}`,
    `Actor name: ${actorName}`,
    "",
    "Steps:",
    "1. Run cargo_test to execute the full test suite with all feature flags",
    "2. If all tests pass, call write_manifest with an empty fixes array and stop",
    "3. If any tests fail:",
    "   a. Read the failing test to understand what it expects",
    "   b. Read the source code to find the bug",
    "   c. Fix the root cause (never suppress or weaken the test)",
    "   d. Run cargo_test again to verify",
    "   e. Repeat until all tests pass",
    "4. Call write_manifest with all fixes applied",
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
    "  npm run test:green -- --repo /absolute/path/to/repo",
    "    [--actors actor_dir_1,actor_dir_2]",
    "    [--max-agents N]",
    "    [--output /path/to/artifacts]",
    "    [--model glm-5]",
    "    [--worker-timeout-seconds N]",
    "    [--apply] [--dry-run]",
    "",
    "Defaults:",
    "  --actors auto-discovered (all actor directories under src/actors/)",
    `  --max-agents ${DEFAULT_MAX_AGENTS}`,
    `  --model ${DEFAULT_MODEL}`,
    `  --worker-timeout-seconds ${DEFAULT_WORKER_TIMEOUT_SECONDS}`,
    "  --apply write sandbox edits back to the real repo after validation",
    "  --output ./artifacts/zai-test-green/<repo-name>-<timestamp>",
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

function execCaptureAllowFail(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => resolve({ stdout, stderr, code: -1 }));
    child.on("exit", (code) => resolve({ stdout, stderr, code }));
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
  const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "zai-test-green-sandbox-"));
  const sandboxPath = path.join(sandboxRoot, repoNameFromPath(repoPath));
  await fs.mkdir(sandboxPath, { recursive: true });

  for (const root of ["src", "tests"]) {
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
        if (root === "tests" && (relative.startsWith("live/") || relative === "live")) return false;
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
    : path.resolve("artifacts", "zai-test-green", `${repoNameFromPath(repoPath)}-${timestamp()}`);
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
        description: "Overwrite a file with updated content. Use for fixing source code in the assigned actor directory or test code in tests/.",
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
        description: "Write the audit manifest. The file is written automatically to your output directory. Call this at the END of your work.",
        parameters: {
          type: "object",
          properties: {
            fixes: {
              type: "array",
              description: "List of test fixes applied.",
              items: {
                type: "object",
                properties: {
                  test: { type: "string", description: "Full test name that was failing." },
                  root_cause: { type: "string", description: "Root cause of the test failure." },
                  file: { type: "string" },
                  line: { type: "number" },
                  context: { type: "string" },
                  fix: { type: "string", description: "What was changed and why." },
                },
                required: ["test", "root_cause", "file", "line", "context", "fix"],
              },
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
        description: "Run `cargo check` in the sandbox for a quick compilation check. Use this to verify compilation fixes before running the full test suite.",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    },
    {
      type: "function",
      function: {
        name: "cargo_test",
        description: "Run `cargo test --all-features` excluding ignored and live tests. Returns the full test output including any failures. Use this to find failing tests and verify fixes.",
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
    normalized === "Cargo.lock" ||
    normalized === "build.rs"
  ) {
    return normalized;
  }

  throw new Error(`Access denied for ${relativePath} (outside allowed scope: src/, tests/, Cargo.toml, Cargo.lock, build.rs)`);
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
    const isActorFile = normalized === actorNorm || normalized.startsWith(`${actorNorm}/`);
    const isTestFile = normalized === "tests" || normalized.startsWith("tests/");
    if (!isActorFile && !isTestFile) {
      throw new Error(`Write access denied for ${args.file_path} (must be under ${actorDir} or tests/)`);
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
    const isTestDir = normalized === "tests" || normalized.startsWith("tests/");
    if (!isActorDir && !isTestDir) {
      throw new Error(`Write access denied for ${args.directory_path} (must be under ${actorDir} or tests/)`);
    }
    const absolutePath = toAbsoluteSandboxPath(sandboxRepoPath, normalized);
    await fs.mkdir(absolutePath, { recursive: true });
    logProgress(`tool:create_directory ${normalized}`, workerLabel);
    return { ok: true, directory_path: normalized };
  }

  if (name === "write_manifest") {
    const manifestPath = path.join(workerOutputDir, "manifest.json");
    await fs.mkdir(workerOutputDir, { recursive: true });
    await writeJson(manifestPath, {
      actor_dir: actorDir,
      fixes: args.fixes ?? [],
    });
    const count = (args.fixes ?? []).length;
    if (count > 0) {
      logWarning(`FIXED: ${count} test failure(s)`, workerLabel);
    } else {
      logProgress(`all tests green — no fixes needed`, workerLabel);
    }
    return { ok: true, manifest_path: manifestPath };
  }

  if (name === "cargo_check") {
    logProgress(`tool:cargo_check`, workerLabel);
    const result = await execCapture("cargo", ["check", "--message-format=short"], { cwd: sandboxRepoPath });
    logProgress(`tool:cargo_check ${result.code === 0 ? "passed" : "errors found"}`, workerLabel);
    return { ok: result.code === 0, stderr: result.stderr, stdout: result.stdout, code: result.code };
  }

  if (name === "cargo_test") {
    logProgress(`tool:cargo_test`, workerLabel);
    const result = await execCaptureAllowFail("cargo", ["test", "--all-features", "--", "--skip", "live"], { cwd: sandboxRepoPath });
    const allPassed = result.code === 0;
    logProgress(`tool:cargo_test ${allPassed ? "all tests passed" : "test failures detected"}`, workerLabel);
    return { ok: allPassed, stdout: result.stdout, stderr: result.stderr, code: result.code };
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
  const totalFixes = manifests.reduce((sum, m) => sum + (m.fixes?.length ?? 0), 0);
  const greenActors = manifests.filter((m) => (m.fixes?.length ?? 0) === 0).length;
  const fixedActors = manifests.filter((m) => (m.fixes?.length ?? 0) > 0);

  return {
    repoPath,
    model,
    workerTimeoutSeconds,
    maxAgents,
    totalActors: workerResults.length,
    succeeded: ok.length,
    failed: failed.length,
    actors: actorDirs,
    greenActors,
    fixedActors: fixedActors.length,
    totalFixes,
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
    "# Z.AI Test Green",
    "",
    "## Scope",
    `- Actors: ${report.actors.join(", ")}`,
    `- Model: ${report.model}`,
    `- Max agents: ${report.maxAgents}`,
    "",
    "## Results",
    "| Actor | Status | Fixes | Summary |",
    "|-------|--------|-------|---------|",
  ];

  for (const worker of report.workers) {
    const name = path.basename(worker.actor_dir);
    const manifest = report.manifests.find((m) => {
      const actorDir = normalizeRelativePath(worker.actor_dir);
      const manifestDir = normalizeRelativePath(m.actor_dir ?? "");
      return actorDir === manifestDir;
    });
    const fCount = manifest?.fixes?.length ?? 0;
    if (worker.status === "fulfilled") {
      const fStr = fCount === 0 ? "all green" : `${colorize(`${fCount} fixed`, ANSI.yellow)}`;
      lines.push(`| ${name} | ok | ${fStr} | ${worker.summary ?? ""} |`);
    } else {
      lines.push(`| ${name} | **failed** | — | ${worker.error ?? "unknown"} |`);
    }
  }

  lines.push("");
  lines.push(`Total: ${report.totalActors} actors, ${report.greenActors} green, ${report.fixedActors} with fixes, ${report.totalFixes} total fix(es)`);
  lines.push("");

  if (report.totalFixes > 0) {
    lines.push("## Fixes applied");
    for (const manifest of report.manifests) {
      if (!manifest.fixes || manifest.fixes.length === 0) continue;
      const actorName = path.basename(manifest.actor_dir ?? "unknown");
      lines.push(`### ${actorName}`);
      for (const f of manifest.fixes) {
        lines.push(`- \`${f.test}\` — ${f.file}:${f.line} — ${f.root_cause} — ${f.fix}`);
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

  logProgress(`starting test-green for ${repoPath}`);
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
    flow: ["zai-test-green"],
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
  const totalFixes = manifests.reduce((sum, m) => sum + (m.fixes?.length ?? 0), 0);
  logProgress(`manifests loaded: ${manifests.length} valid, ${totalFixes} total fix(es)`);

  logProgress("validating final diff");
  const diffScopeDirs = [...actorDirs, "tests"];
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

  logProgress(`diff validated: ${finalDiff.length} file(s) changed across actor directories and tests/`);

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
    `Test-green complete for ${repoPath}`,
    `Actors: ${actorDirs.join(", ")}`,
    `Model: ${args.model}`,
    `Max agents: ${args.maxAgents}`,
    `Results: ${succeeded.length} succeeded, ${failed.length} failed`,
    `Fixes: ${totalFixes} applied across ${manifests.filter((m) => (m.fixes?.length ?? 0) > 0).length} actor(s)`,
    `Artifacts: ${outputDirectory}`,
    `Changed files: ${finalDiff.length}`,
  ].join("\n") + "\n");

  if (failed.length > 0) {
    logWarning(`${failed.length} worker(s) failed: ${failed.map((r) => r.actorName).join(", ")}`);
  }

  if (totalFixes > 0) {
    process.stdout.write(colorize(`\n[!] ${totalFixes} fix(es) applied — see report.md for details.\n`, ANSI.yellow));
  } else {
    process.stdout.write(colorize("\n[ok] All tests green.\n", ANSI.green));
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
