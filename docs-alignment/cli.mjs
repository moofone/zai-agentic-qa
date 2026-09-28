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
const DEFAULT_DOCS_FOLDERS = "docs/architecture";
const DEFAULT_MAX_AGENTS = 1;
const ALIGNMENT_INCLUDED_ROOTS = ["docs", "src", "tests"];
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
const MAX_TOOL_ROUNDS = 512;

function usage() {
  return [
    "Usage:",
    "  npm run docs:alignment -- --repo /absolute/path/to/repo",
    "    [--docs-folders docs/architecture,docs/guides]",
    "    [--max-agents N]",
    "    [--output /path/to/artifacts]",
    "    [--model glm-5]",
    "    [--worker-timeout-seconds N]",
    "    [--apply] [--dry-run]",
    "",
    "Defaults:",
    `  --docs-folders ${DEFAULT_DOCS_FOLDERS}`,
    `  --max-agents ${DEFAULT_MAX_AGENTS}`,
    `  --model ${DEFAULT_MODEL}`,
    `  --worker-timeout-seconds ${DEFAULT_WORKER_TIMEOUT_SECONDS}`,
    "  --apply write sandboxed docs back to the real repo after validation",
    "  --output ./artifacts/zai-docs-alignment/<repo-name>-<timestamp>",
    "  requires Z_AI_API_KEY in the environment",
  ].join("\n");
}

function parseArgs(argv) {
  const result = {
    apply: false,
    docsFolders: DEFAULT_DOCS_FOLDERS,
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
    if (arg === "--docs-folders") {
      result.docsFolders = argv[i + 1];
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

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function execCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr, code });
        return;
      }
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

const ANSI = {
  reset: "\u001b[0m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  cyan: "\u001b[36m",
  magenta: "\u001b[35m",
  blue: "\u001b[34m",
};

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

function summarizeText(text, maxLength = 160) {
  const flattened = String(text).replace(/\s+/g, " ").trim();
  if (!flattened) return "no text";
  if (flattened.length <= maxLength) return flattened;
  return `${flattened.slice(0, maxLength - 1)}...`;
}

function normalizeRelativePath(value) {
  return value.replaceAll("\\", "/").replace(/\/+$/, "");
}

function shouldIgnoreRelativePath(relativePath, ignoredPrefixes = DEFAULT_EXCLUDED_PATHS) {
  if (!relativePath) return false;
  const normalized = normalizeRelativePath(relativePath);
  return ignoredPrefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

async function buildOutputDirectory(repoPath, explicitOutput) {
  const baseDirectory = explicitOutput
    ? path.resolve(explicitOutput)
    : path.resolve("artifacts", "zai-docs-alignment", `${repoNameFromPath(repoPath)}-${timestamp()}`);
  await fs.mkdir(baseDirectory, { recursive: true });
  return baseDirectory;
}

async function createSandbox(repoPath, outputDirectory) {
  const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "zai-docs-alignment-sandbox-"));
  const sandboxPath = path.join(sandboxRoot, repoNameFromPath(repoPath));
  await fs.mkdir(sandboxPath, { recursive: true });

  for (const includedRoot of ALIGNMENT_INCLUDED_ROOTS) {
    const sourcePath = path.join(repoPath, includedRoot);
    if (!(await pathExists(sourcePath))) {
      continue;
    }

    await fs.cp(sourcePath, path.join(sandboxPath, includedRoot), {
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

  await fs.writeFile(path.join(outputDirectory, "sandbox-path.txt"), `${sandboxPath}\n`, "utf8");
  return { sandboxRoot, sandboxPath };
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function listFilesRecursive(rootDirectory, ignoredRelativePrefixes = []) {
  const files = [];
  const normalizedIgnoredPrefixes = ignoredRelativePrefixes.map(normalizeRelativePath);

  async function walk(currentDirectory) {
    const entries = await fs.readdir(currentDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(currentDirectory, entry.name);
      const relativePath = path.relative(rootDirectory, absolutePath).replaceAll("\\", "/");
      if (shouldIgnoreRelativePath(relativePath, normalizedIgnoredPrefixes)) {
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

async function listDocFiles(repoPath, folderList) {
  const docFiles = [];
  const seen = new Set();

  for (const folder of folderList) {
    const normalizedFolder = normalizeRelativePath(folder);
    const folderRoot = path.join(repoPath, normalizedFolder);
    if (!(await pathExists(folderRoot))) {
      continue;
    }

    const relativeDocs = await listFilesRecursive(folderRoot, DEFAULT_EXCLUDED_PATHS);
    for (const file of relativeDocs) {
      if (!file.endsWith(".md") || path.basename(file).startsWith(".")) continue;
      const fullPath = path.posix.join(normalizedFolder.replaceAll("\\", "/"), file.replaceAll("\\", "/"));
      if (!seen.has(fullPath)) {
        seen.add(fullPath);
        docFiles.push(fullPath);
      }
    }
  }

  docFiles.sort();
  return docFiles;
}

async function listFilesForIncludedRoots(rootDirectory, includedRoots, ignoredRelativePrefixes = []) {
  const files = [];

  for (const includedRoot of includedRoots) {
    const scopedRoot = path.join(rootDirectory, includedRoot);
    if (!(await pathExists(scopedRoot))) {
      continue;
    }

    const scopedFiles = await listFilesRecursive(scopedRoot, ignoredRelativePrefixes);
    for (const file of scopedFiles) {
      files.push(`${includedRoot}/${file}`);
    }
  }

  files.sort();
  return files;
}

function countLineDifferences(before, after) {
  const beforeLines = before === "" ? [] : before.split("\n");
  const afterLines = after === "" ? [] : after.split("\n");
  const beforeCounts = new Map();
  const afterCounts = new Map();

  for (const line of beforeLines) beforeCounts.set(line, (beforeCounts.get(line) ?? 0) + 1);
  for (const line of afterLines) afterCounts.set(line, (afterCounts.get(line) ?? 0) + 1);

  let additions = 0;
  let deletions = 0;
  const allLines = new Set([...beforeCounts.keys(), ...afterCounts.keys()]);
  for (const line of allLines) {
    const beforeCount = beforeCounts.get(line) ?? 0;
    const afterCount = afterCounts.get(line) ?? 0;
    if (afterCount > beforeCount) additions += afterCount - beforeCount;
    if (beforeCount > afterCount) deletions += beforeCount - afterCount;
  }

  return { additions, deletions };
}

async function diffDirectories(originalRoot, sandboxRoot, ignoredRelativePrefixes = []) {
  const [originalFiles, sandboxFiles] = await Promise.all([
    listFilesForIncludedRoots(originalRoot, ALIGNMENT_INCLUDED_ROOTS, ignoredRelativePrefixes),
    listFilesForIncludedRoots(sandboxRoot, ALIGNMENT_INCLUDED_ROOTS, ignoredRelativePrefixes),
  ]);

  const allRelativeFiles = new Set([...originalFiles, ...sandboxFiles]);
  const diffs = [];

  for (const relativeFile of [...allRelativeFiles].sort()) {
    const originalPath = path.join(originalRoot, relativeFile);
    const sandboxPath = path.join(sandboxRoot, relativeFile);
    const [originalExists, sandboxExists] = await Promise.all([pathExists(originalPath), pathExists(sandboxPath)]);

    const before = originalExists ? await fs.readFile(originalPath, "utf8") : "";
    const after = sandboxExists ? await fs.readFile(sandboxPath, "utf8") : "";
    if (before === after) continue;

    const { additions, deletions } = countLineDifferences(before, after);
    diffs.push({ file: relativeFile, before, after, additions, deletions });
  }

  return diffs;
}

function summarizeDiff(diff) {
  return diff.map((entry) => ({ file: entry.file, additions: entry.additions, deletions: entry.deletions }));
}

function ensureDocsOnlyDiff(diff) {
  const invalidFiles = diff.map((entry) => entry.file).filter((file) => !(file === "docs" || file.startsWith("docs/")));
  if (invalidFiles.length > 0) {
    throw new Error(`Unauthorized file modifications detected: ${invalidFiles.join(", ")}`);
  }
}

function formatLinePatch(before, after) {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");

  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) {
    prefix += 1;
  }

  let beforeSuffix = beforeLines.length - 1;
  let afterSuffix = afterLines.length - 1;
  while (beforeSuffix >= prefix && afterSuffix >= prefix && beforeLines[beforeSuffix] === afterLines[afterSuffix]) {
    beforeSuffix -= 1;
    afterSuffix -= 1;
  }

  const removed = beforeLines.slice(prefix, beforeSuffix + 1).map((line) => `- ${line}`);
  const added = afterLines.slice(prefix, afterSuffix + 1).map((line) => `+ ${line}`);
  const patchLines = [...removed, ...added].filter((line) => line !== "- " && line !== "+ ");
  if (patchLines.length === 0) {
    return "  (file changed, but no line-level delta could be summarized)";
  }

  return patchLines
    .map((line) => {
      if (line.startsWith("+ ")) {
        return colorize(line, "\u001b[32m");
      }
      if (line.startsWith("- ")) {
        return colorize(line, ANSI.red);
      }
      return line;
    })
    .join("\n");
}

async function execRg(args, cwd) {
  try {
    return await execCapture("rg", args, { cwd });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("code 1")) {
      return { stdout: "", stderr: "", code: 1 };
    }
    throw error;
  }
}

async function resolveApiKey() {
  if (process.env.Z_AI_API_KEY) {
    return process.env.Z_AI_API_KEY.trim();
  }

  const shell = process.env.SHELL || "/bin/zsh";
  try {
    const result = await execCapture(shell, ["-lic", "printenv Z_AI_API_KEY"]);
    const value = result.stdout.trim();
    if (value) {
      return value;
    }
  } catch {
    // Fall through to the explicit error below.
  }

  throw new Error("Missing Z_AI_API_KEY. Export it in the current shell or configure it in your shell startup that defines the opencode token.");
}

function maskSecret(secret) {
  const value = String(secret || "").trim();
  if (value.length <= 8) {
    return "*".repeat(value.length);
  }
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
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

function buildSystemPrompt(selectedDoc) {
  return [
    "You are a documentation audit worker.",
    "Your task is to align one Markdown document with the codebase.",
    "Use English only.",
    "Only edit the assigned document.",
    "Never modify code.",
    "Use src/** and tests/** as code evidence.",
    `Assigned document: ${selectedDoc}`,
  ].join(" ");
}

function buildUserPrompt(selectedDoc) {
  return [
    `Analyze ${selectedDoc} against the current src/** and tests/** codebase and correct documentation errors directly in that file.`,
    "Do the work now.",
    "Do not ask follow-up questions.",
    "Do not create a separate plan.",
    "Use the provided file tools to inspect code and rewrite the document in place if needed.",
    "If the document is already correct, leave it unchanged and briefly say that no change was needed.",
  ].join("\n");
}

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
        description: "Overwrite the assigned Markdown file with updated content.",
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
  ];
}

function toAbsoluteSandboxPath(sandboxRepoPath, relativePath) {
  return path.resolve(sandboxRepoPath, normalizeRelativePath(relativePath));
}

function ensureAllowedReadPath(relativePath, selectedDoc, docsFolders) {
  const normalized = normalizeRelativePath(relativePath);
  if (
    normalized === selectedDoc ||
    normalized.startsWith("src/") ||
    normalized === "src" ||
    normalized.startsWith("tests/") ||
    normalized === "tests" ||
    docsFolders.some((folder) => normalized === folder || normalized.startsWith(`${folder}/`))
  ) {
    return normalized;
  }
  throw new Error(`Read access denied for ${relativePath}`);
}

function ensureAllowedWritePath(relativePath, selectedDoc) {
  const normalized = normalizeRelativePath(relativePath);
  if (normalized !== selectedDoc) {
    throw new Error(`Write access denied for ${relativePath}`);
  }
  return normalized;
}

async function executeToolCall(toolCall, context) {
  const { sandboxRepoPath, selectedDoc, docsFolders, workerLabel } = context;
  const name = toolCall.function.name;
  const args = JSON.parse(toolCall.function.arguments || "{}");

  if (name === "read_file") {
    const relativePath = ensureAllowedReadPath(args.file_path, selectedDoc, docsFolders);
    const absolutePath = toAbsoluteSandboxPath(sandboxRepoPath, relativePath);
    const content = await fs.readFile(absolutePath, "utf8");
    logProgress(`tool:read_file ${relativePath}`, workerLabel);
    return { ok: true, file_path: relativePath, content };
  }

  if (name === "list_files") {
    const relativePath = ensureAllowedReadPath(args.directory_path, selectedDoc, docsFolders);
    const absolutePath = toAbsoluteSandboxPath(sandboxRepoPath, relativePath);
    const entries = await listFilesRecursive(absolutePath, DEFAULT_EXCLUDED_PATHS);
    logProgress(`tool:list_files ${relativePath}`, workerLabel);
    return { ok: true, directory_path: relativePath, files: entries };
  }

  if (name === "search_files") {
    const relativePath = ensureAllowedReadPath(args.directory_path, selectedDoc, docsFolders);
    const absolutePath = toAbsoluteSandboxPath(sandboxRepoPath, relativePath);
    const result = await execRg(["-n", "--hidden", args.query, absolutePath], sandboxRepoPath);
    logProgress(`tool:search_files ${relativePath} query=${JSON.stringify(args.query)}`, workerLabel);
    return {
      ok: true,
      directory_path: relativePath,
      matches: result.stdout.trim() ? result.stdout.trim().split("\n") : [],
    };
  }

  if (name === "write_file") {
    const relativePath = ensureAllowedWritePath(args.file_path, selectedDoc);
    const absolutePath = toAbsoluteSandboxPath(sandboxRepoPath, relativePath);
    const before = await fs.readFile(absolutePath, "utf8");
    await fs.writeFile(absolutePath, args.content, "utf8");
    const after = await fs.readFile(absolutePath, "utf8");
    logWarning(`tool:write_file ${relativePath}`, workerLabel);
    process.stdout.write(`${formatLinePatch(before, after)}\n`);
    return { ok: true, file_path: relativePath, changed: before !== after };
  }

  throw new Error(`Unsupported tool call: ${name}`);
}

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

async function runWorker(context) {
  const { apiKey, model, outputDirectory, sandboxRepoPath, selectedDoc, docsFolders, workerTimeoutMs, workerLabel } = context;
  const tools = buildTools();
  const messages = [
    { role: "system", content: buildSystemPrompt(selectedDoc) },
    { role: "user", content: buildUserPrompt(selectedDoc) },
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
        const result = await executeToolCall(toolCall, { sandboxRepoPath, selectedDoc, docsFolders, workerLabel });
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

function slotSummary(inFlight, pending, maxAgents) {
  const active = inFlight.size;
  const slots = maxAgents;
  const remaining = pending.length;
  return `(slots ${active}/${slots} active, ${remaining} pending)`;
}

async function runAllWorkers({ docFiles, docsFolders, apiKey, model, sandboxRepoPath, outputDirectory, workerTimeoutMs, maxAgents }) {
  const workersDir = path.join(outputDirectory, "workers");
  const results = [];
  const pending = [...docFiles];
  const inFlight = new Map();

  while (pending.length > 0 || inFlight.size > 0) {
    while (pending.length > 0 && inFlight.size < maxAgents) {
      const selectedDoc = pending.shift();
      const workerLabel = path.basename(selectedDoc);
      const workerDir = path.join(workersDir, workerLabel);
      await fs.mkdir(workerDir, { recursive: true });

      inFlight.set(selectedDoc, null); // reserve slot before async launch
      logProgress(`started for ${selectedDoc} ${slotSummary(inFlight, pending, maxAgents)}`, workerLabel);

      const promise = runWorker({
        apiKey,
        model,
        outputDirectory: workerDir,
        sandboxRepoPath,
        selectedDoc,
        docsFolders,
        workerTimeoutMs,
        workerLabel,
      })
        .then((summary) => {
          logProgress(`finished ${slotSummary(inFlight, pending, maxAgents)}`, workerLabel);
          return { doc: selectedDoc, workerLabel, status: "fulfilled", summary };
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          logError(`failed: ${message} ${slotSummary(inFlight, pending, maxAgents)}`, workerLabel);
          return { doc: selectedDoc, workerLabel, status: "rejected", error: message };
        });

      inFlight.set(selectedDoc, promise);
    }

    if (inFlight.size > 0) {
      const settled = await Promise.race(inFlight.values());
      inFlight.delete(settled.doc);
      results.push(settled);

      if (settled.status === "fulfilled") {
        const workerDir = path.join(workersDir, settled.workerLabel);
        await fs.writeFile(path.join(workerDir, "worker-output.txt"), `${settled.summary}\n`, "utf8");
        process.stdout.write(`\n${settled.summary.trim()}\n\n`);
      }
    }
  }

  return results;
}

function buildAggregatedReport({ repoPath, docsFolders, model, workerTimeoutSeconds, maxAgents, workerResults, finalDiff }) {
  const ok = workerResults.filter((r) => r.status === "fulfilled");
  const failed = workerResults.filter((r) => r.status === "rejected");
  return {
    repoPath,
    docsFolders,
    model,
    workerTimeoutSeconds,
    maxAgents,
    totalDocs: workerResults.length,
    succeeded: ok.length,
    failed: failed.length,
    workers: workerResults.map((r) => ({
      doc: r.doc,
      status: r.status,
      summary: r.status === "fulfilled" ? summarizeText(r.summary, 512) : undefined,
      error: r.status === "rejected" ? r.error : undefined,
    })),
    changedFiles: summarizeDiff(finalDiff),
  };
}

function buildAggregatedMarkdown(report) {
  const lines = [
    "# Z.AI Docs Alignment",
    "",
    "## Scope",
    `- Docs folders: ${report.docsFolders}`,
    `- Model: ${report.model}`,
    `- Max agents: ${report.maxAgents}`,
    "",
    "## Results",
    `| Doc | Status | Summary |`,
    `|-----|--------|---------|`,
  ];

  for (const worker of report.workers) {
    const basename = path.basename(worker.doc);
    if (worker.status === "fulfilled") {
      lines.push(`| ${basename} | ok | ${worker.summary ?? ""} |`);
    } else {
      lines.push(`| ${basename} | **failed** | ${worker.error ?? "unknown"} |`);
    }
  }

  lines.push("");
  lines.push(`Total: ${report.totalDocs} docs, ${report.succeeded} succeeded, ${report.failed} failed`);
  lines.push("");
  lines.push("## Changed files");
  if (report.changedFiles.length > 0) {
    for (const entry of report.changedFiles) {
      lines.push(`- ${entry.file} (+${entry.additions} -${entry.deletions})`);
    }
  } else {
    lines.push("- none");
  }
  lines.push("");
  return lines.join("\n");
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const repoPath = path.resolve(args.repo);
  const docsFolders = args.docsFolders.split(",").map(normalizeRelativePath).filter(Boolean);
  const srcPath = path.join(repoPath, "src");
  const outputDirectory = await buildOutputDirectory(repoPath, args.output);
  const apiKey = await resolveApiKey();

  logProgress(`starting docs alignment for ${repoPath}`);
  logProgress(`artifacts will be written to ${outputDirectory}`);
  logProgress(`model ${args.model}`);
  logWarning(`using Z_AI_API_KEY ${maskSecret(apiKey)}`);
  logProgress(`max agents: ${args.maxAgents}`);
  logProgress(`worker timeout: ${args.workerTimeoutSeconds}s`);
  logProgress(`docs folders: ${docsFolders.join(", ")}`);
  logProgress(`alignment scope roots: ${ALIGNMENT_INCLUDED_ROOTS.join(", ")}`);
  logProgress(`excluding generated paths: ${DEFAULT_EXCLUDED_PATHS.join(", ")}`);

  await ensureDirectoryExists(repoPath, "Repository path");
  await ensureDirectoryExists(srcPath, "src directory");
  for (const folder of docsFolders) {
    await ensureDirectoryExists(path.join(repoPath, folder), `docs folder ${folder}`);
  }

  const docFiles = await listDocFiles(repoPath, docsFolders);
  if (docFiles.length === 0) {
    throw new Error(`No Markdown files found under ${docsFolders.join(", ")}`);
  }
  logProgress(`discovered ${docFiles.length} docs file(s) under ${docsFolders.join(", ")}`);
  for (const doc of docFiles) {
    logProgress(`  ${doc}`);
  }

  const { sandboxRoot, sandboxPath: sandboxRepoPath } = await createSandbox(repoPath, outputDirectory);
  const outputRelativePath = path.relative(repoPath, outputDirectory).replaceAll("\\", "/");
  const ignoredDiffPrefixes =
    outputRelativePath && !outputRelativePath.startsWith("..") && !path.isAbsolute(outputRelativePath)
      ? [...DEFAULT_EXCLUDED_PATHS, outputRelativePath]
      : [...DEFAULT_EXCLUDED_PATHS];

  await writeJson(path.join(outputDirectory, "run-config.json"), {
    repoPath,
    sandboxRepoPath,
    docsFolders,
    outputDirectory,
    apiBaseUrl: DEFAULT_API_BASE_URL,
    model: args.model,
    maxAgents: args.maxAgents,
    apply: args.apply,
    workerTimeoutSeconds: args.workerTimeoutSeconds,
    flow: ["zai-parallel-doc-workers"],
    discoveredDocFiles: docFiles,
  });

  if (args.dryRun) {
    logProgress("dry run complete");
    process.stdout.write([
      `Dry run ready.`,
      `Repo: ${repoPath}`,
      `Output: ${outputDirectory}`,
      `Model: ${args.model}`,
      `Max agents: ${args.maxAgents}`,
      `Docs folders: ${docsFolders.join(", ")}`,
      `Docs (${docFiles.length}):`,
      ...docFiles.map((d) => `  ${d}`),
    ].join("\n") + "\n");
    await fs.rm(sandboxRoot, { recursive: true, force: true, maxRetries: 3 });
    return;
  }

  logProgress(`sandbox ready at ${sandboxRepoPath}`);
  logProgress(`launching ${docFiles.length} worker(s) with concurrency ${args.maxAgents}`);

  const workerResults = await runAllWorkers({
    docFiles,
    docsFolders,
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

  logProgress("validating final diff");
  const finalDiff = await diffDirectories(repoPath, sandboxRepoPath, ignoredDiffPrefixes);
  ensureDocsOnlyDiff(finalDiff);

  const docFileSet = new Set(docFiles);
  const unauthorizedFiles = finalDiff.map((entry) => entry.file).filter((file) => !docFileSet.has(file));
  if (unauthorizedFiles.length > 0) {
    throw new Error(`Unauthorized file modifications detected: ${unauthorizedFiles.join(", ")}`);
  }

  if (args.apply) {
    for (const entry of finalDiff) {
      const sandboxDocPath = path.join(sandboxRepoPath, entry.file);
      const repoDocPath = path.join(repoPath, entry.file);
      await fs.copyFile(sandboxDocPath, repoDocPath);
      logWarning(`applied sandbox edit to ${repoDocPath}`);
    }
  }

  const workersDir = path.join(outputDirectory, "workers");
  for (const entry of finalDiff) {
    const workerLabel = path.basename(entry.file);
    const workerDir = path.join(workersDir, workerLabel);
    await fs.mkdir(workerDir, { recursive: true });
    await writeJson(path.join(workerDir, "diff.json"), finalDiff.filter((d) => d.file === entry.file));
  }
  await writeJson(path.join(outputDirectory, "final-diff.json"), finalDiff);

  const report = buildAggregatedReport({
    repoPath,
    docsFolders: docsFolders.join(","),
    model: args.model,
    workerTimeoutSeconds: args.workerTimeoutSeconds,
    maxAgents: args.maxAgents,
    workerResults,
    finalDiff,
  });
  await writeJson(path.join(outputDirectory, "report.json"), report);
  await fs.writeFile(path.join(outputDirectory, "report.md"), buildAggregatedMarkdown(report), "utf8");
  logProgress("artifacts written");

  process.stdout.write([
    `Docs alignment complete for ${repoPath}`,
    `Docs folders: ${docsFolders.join(", ")}`,
    `Model: ${args.model}`,
    `Max agents: ${args.maxAgents}`,
    `Results: ${succeeded.length} succeeded, ${failed.length} failed`,
    `Artifacts: ${outputDirectory}`,
    `Changed files: ${finalDiff.length}`,
  ].join("\n") + "\n");

  if (failed.length > 0) {
    logWarning(`${failed.length} worker(s) failed: ${failed.map((r) => path.basename(r.doc)).join(", ")}`);
  }

  // Clean up sandbox
  try {
    await fs.rm(sandboxRoot, { recursive: true, force: true, maxRetries: 3 });
    logProgress("sandbox cleaned up");
  } catch (error) {
    logWarning(`sandbox cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

run().catch(async (error) => {
  logError(error instanceof Error ? error.message : String(error));
  // Best-effort sandbox cleanup on failure
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
