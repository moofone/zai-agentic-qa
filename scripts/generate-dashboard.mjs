#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DEFAULT_ARTIFACTS_DIR = "./artifacts";

const TASK_META = {
  "zai-docs-alignment":              { label: "Docs Alignment",              type: "fix" },
  "zai-fixture-alignment":            { label: "Fixture Alignment",           type: "fix" },
  "zai-shared-ws-alignment":          { label: "WS Fixture Alignment",       type: "fix" },
  "zai-actor-messaging-conformance":  { label: "Actor Messaging",             type: "fix" },
  "zai-actor-schema-conformance":     { label: "Actor Schema",               type: "fix" },
  "zai-fixture-e2e-coverage":         { label: "Fixture E2E",                type: "fix" },
  "zai-json-parsing-hygiene":         { label: "JSON Parsing",               type: "fix" },
  "zai-saga-workflow-e2e":            { label: "SAGA Workflow E2E",          type: "fix" },
  "zai-inbox-direct":                  { label: "Inbox Direct",               type: "fix" },
  "zai-persistence-audit":            { label: "Persistence Audit",           type: "audit" },
  "zai-test-green":                   { label: "Test Green",                 type: "fix" },
};

const TASK_ORDER = Object.keys(TASK_META);

function usage() {
  return [
    "Usage:",
    "  npm run dashboard -- [options]",
    "",
    "Options:",
    "  --artifacts <dir>   Artifacts directory to scan (default: ./artifacts)",
    "  --output <file>     Output HTML file (default: ./artifacts/dashboard.html)",
    "  --help              Show this help",
  ].join("\n");
}

function parseArgs(argv) {
  const result = { artifactsDir: DEFAULT_ARTIFACTS_DIR, output: null, help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") { result.help = true; continue; }
    if (arg === "--artifacts") { result.artifactsDir = argv[i + 1]; i += 1; continue; }
    if (arg === "--output") { result.output = argv[i + 1]; i += 1; continue; }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!result.output) {
    result.output = path.join(result.artifactsDir, "dashboard.html");
  }
  return result;
}

async function pathExists(target) {
  try { await fs.access(target); return true; } catch { return false; }
}

async function readJson(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  return JSON.parse(content);
}

async function scanArtifacts(artifactsDir) {
  const results = [];

  if (!(await pathExists(artifactsDir))) return results;

  const taskTypeEntries = await fs.readdir(artifactsDir, { withFileTypes: true });

  for (const taskTypeEntry of taskTypeEntries) {
    if (!taskTypeEntry.isDirectory()) continue;
    if (!taskTypeEntry.name.startsWith("zai-")) continue;

    const taskTypeDir = path.join(artifactsDir, taskTypeEntry.name);
    const runEntries = await fs.readdir(taskTypeDir, { withFileTypes: true });
    const sortedRuns = runEntries.filter(e => e.isDirectory()).map(e => e.name).sort();
    const latestRun = sortedRuns[sortedRuns.length - 1];
    if (!latestRun) continue;

    const runDir = path.join(taskTypeDir, latestRun);
    const taskRun = {
      dir: `${taskTypeEntry.name}/${latestRun}`,
      key: taskTypeEntry.name,
      label: (TASK_META[taskTypeEntry.name]?.label) ?? taskTypeEntry.name.replace(/^zai-/, "").replace(/-/g, " "),
      type: (TASK_META[taskTypeEntry.name]?.type) ?? "fix",
      report: null,
      manifests: null,
    };

    try { taskRun.report = await readJson(path.join(runDir, "report.json")); } catch { /* skip */ }
    try { taskRun.manifests = await readJson(path.join(runDir, "manifests.json")); } catch { /* skip */ }

    results.push(taskRun);
  }

  results.sort((a, b) => {
    const ai = TASK_ORDER.indexOf(a.key);
    const bi = TASK_ORDER.indexOf(b.key);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  return results;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function hasChanges(report, type) {
  if (!report) return false;
  if (type === "audit") return (report.totalViolations ?? 0) > 0;
  return (report.changedFiles?.length ?? 0) > 0;
}

function isClean(report, type) {
  if (!report) return false;
  if ((report.failed ?? 0) > 0) return false;
  if (type === "audit") return (report.totalViolations ?? 0) === 0;
  return (report.changedFiles?.length ?? 0) === 0;
}

function renderCleanRow(task) {
  return `
    <tr class="row-clean">
      <td>${escapeHtml(task.label)}</td>
      <td class="center">pass</td>
      <td class="center">${task.report?.totalActors ?? task.report?.workers?.length ?? 0} actors</td>
      <td class="center">no changes needed</td>
    </tr>`;
}

function renderFixDetails(task) {
  const r = task.report;
  const changedFiles = r?.changedFiles ?? [];
  const failedWorkers = r?.workers?.filter(w => w.status === "rejected") ?? [];
  const succeededWorkers = r?.workers?.filter(w => w.status === "fulfilled") ?? [];

  let changesList = "";
  if (changedFiles.length > 0) {
    changesList = `
      <div class="detail-group">
        <div class="detail-label">Changed files (${changedFiles.length})</div>
        <ul class="detail-list">
          ${changedFiles.map(f => `<li><code>${escapeHtml(f.file)}</code></li>`).join("")}
        </ul>
      </div>`;
  }

  let workerRows = "";
  for (const w of succeededWorkers) {
    const actorName = path.basename(w.actor_dir || "unknown");
    const summary = w.summary || "";
    const highlight = summary && !summary.toLowerCase().includes("clean") && !summary.toLowerCase().includes("no ") && !summary.toLowerCase().includes("already");
    workerRows += `<tr>
      <td><code>${escapeHtml(actorName)}</code></td>
      <td class="center">ok</td>
      <td>${escapeHtml(summary)}</td>
    </tr>`;
  }
  for (const w of failedWorkers) {
    workerRows += `<tr class="row-failed">
      <td><code>${escapeHtml(path.basename(w.actor_dir || "unknown"))}</code></td>
      <td class="center">fail</td>
      <td class="text-error">${escapeHtml(w.error || "unknown")}</td>
    </tr>`;
  }

  let workerSection = "";
  if (succeededWorkers.length > 0 || failedWorkers.length > 0) {
    workerSection = `
      <div class="detail-group">
        <div class="detail-label">Workers (${succeededWorkers.length} ok${failedWorkers.length ? `, ${failedWorkers.length} failed` : ""})</div>
        <table class="detail-table">
          <thead><tr><th>Actor</th><th></th><th>Summary</th></tr></thead>
          <tbody>${workerRows}</tbody>
        </table>
      </div>`;
  }

  return changesList + workerSection;
}

function renderAuditDetails(task) {
  const r = task.report;
  const manifests = task.manifests ?? [];

  let violationBlocks = "";
  for (const m of manifests) {
    if (!m.violations?.length) continue;
    const actorName = path.basename(m.actor_dir || "unknown");
    violationBlocks += `
      <div class="detail-group">
        <div class="detail-label">${escapeHtml(actorName)} (${m.violations.length})</div>
        <ul class="detail-list">
          ${m.violations.map(v => `
            <li>
              <code>${escapeHtml(v.file)}:${v.line}</code>
              <span class="badge badge-${v.severity}">${escapeHtml(v.severity)}</span>
              <div class="violation-text">${escapeHtml(v.context)}</div>
            </li>
          `).join("")}
        </ul>
      </div>`;
  }

  return violationBlocks;
}

function renderChangedRow(task) {
  const r = task.report;
  const changedCount = r?.changedFiles?.length ?? 0;
  const failedCount = r?.failed ?? 0;
  const statusClass = failedCount > 0 ? "row-warn" : "row-changed";
  const statusText = failedCount > 0 ? `${changedCount} changes, ${failedCount} fail` : `${changedCount} changed`;

  const details = task.type === "audit" ? renderAuditDetails(task) : renderFixDetails(task);

  return `
    <tr class="${statusClass}">
      <td colspan="4">
        <div class="changed-row-header">
          <span>${escapeHtml(task.label)}</span>
          <span class="changed-count">${statusText}</span>
        </div>
        <div class="changed-row-details">${details}</div>
      </td>
    </tr>`;
}

function renderFailedRow(task) {
  const r = task.report;
  const error = r?.workers?.find(w => w.status === "rejected")?.error || "unknown error";
  return `
    <tr class="row-failed">
      <td colspan="4">
        <div class="changed-row-header">
          <span>${escapeHtml(task.label)}</span>
          <span class="changed-count text-error">failed</span>
        </div>
        <div class="changed-row-details">
          <div class="detail-group">
            <div class="violation-text">${escapeHtml(error)}</div>
          </div>
        </div>
      </td>
    </tr>`;
}

function renderNoDataRow(task) {
  return `
    <tr class="row-missing">
      <td>${escapeHtml(task.label)}</td>
      <td class="center">—</td>
      <td class="center">—</td>
      <td class="center">no artifacts</td>
    </tr>`;
}

function generateHtml(taskRuns, artifactsDir) {
  const totalTasks = taskRuns.length;
  const totalClean = taskRuns.filter(t => isClean(t.report, t.type)).length;
  const totalChanged = taskRuns.filter(t => hasChanges(t.report, t.type)).length;
  const totalMissing = TASK_ORDER.length - totalTasks;

  let tableRows = "";
  for (const taskKey of TASK_ORDER) {
    const task = taskRuns.find(t => t.key === taskKey);
    const meta = TASK_META[taskKey];

    if (!task) {
      tableRows += renderNoDataRow({ key: taskKey, label: meta.label, type: meta.type });
      continue;
    }

    if (!task.report) {
      tableRows += renderNoDataRow(task);
      continue;
    }

    if ((task.report.failed ?? 0) > 0 && !hasChanges(task.report, task.type)) {
      tableRows += renderFailedRow(task);
    } else if (isClean(task.report, task.type)) {
      tableRows += renderCleanRow(task);
    } else {
      tableRows += renderChangedRow(task);
    }
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Z.AI QA Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      padding: 2rem;
      background: #f9fafb;
      color: #1f2937;
      max-width: 960px;
      margin: 0 auto;
    }
    h1 { font-size: 1.25rem; margin-bottom: 0.25rem; }
    .timestamp { color: #6b7280; font-size: 0.8125rem; margin-bottom: 1.5rem; }

    .summary-bar {
      display: flex;
      gap: 1.5rem;
      margin-bottom: 1.5rem;
      font-size: 0.875rem;
    }
    .summary-bar span { color: #6b7280; }
    .summary-bar strong { font-weight: 600; }

    table.main-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.875rem;
    }
    table.main-table th {
      text-align: left;
      padding: 0.5rem 0.75rem;
      border-bottom: 2px solid #e5e7eb;
      font-weight: 600;
      color: #374151;
    }
    table.main-table td {
      padding: 0.5rem 0.75rem;
      border-bottom: 1px solid #f3f4f6;
      vertical-align: top;
    }
    .center { text-align: center; }

    .row-clean { background: #f0fdf4; }
    .row-clean td:first-child { font-weight: 500; color: #15803d; }

    .row-changed { background: #fffbeb; }
    .row-changed td:first-child { font-weight: 500; color: #92400e; }

    .row-warn { background: #fef3c7; border-left: 3px solid #f59e0b; }

    .row-failed { background: #fef2f2; border-left: 3px solid #dc2626; }

    .row-missing td { color: #9ca3af; }

    .changed-row-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-weight: 500;
    }
    .changed-count {
      font-size: 0.75rem;
      padding: 0.125rem 0.5rem;
      border-radius: 9999px;
      background: #fbbf24;
      color: #78350f;
    }

    .changed-row-details {
      margin-top: 0.75rem;
      padding-left: 0.5rem;
    }

    .detail-group { margin-bottom: 0.75rem; }
    .detail-label {
      font-weight: 600;
      font-size: 0.75rem;
      text-transform: uppercase;
      color: #6b7280;
      letter-spacing: 0.05em;
      margin-bottom: 0.25rem;
    }

    .detail-list {
      list-style: none;
      padding: 0;
    }
    .detail-list li {
      padding: 0.125rem 0;
      font-size: 0.8125rem;
    }
    .detail-list code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.75rem;
      background: #f3f4f6;
      padding: 0.0625rem 0.25rem;
      border-radius: 3px;
    }

    .detail-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.8125rem;
    }
    .detail-table th {
      text-align: left;
      padding: 0.25rem 0.5rem;
      font-weight: 600;
      font-size: 0.75rem;
      color: #6b7280;
      border-bottom: 1px solid #e5e7eb;
    }
    .detail-table td {
      padding: 0.25rem 0.5rem;
      border-bottom: 1px solid #f3f4f6;
    }

    .badge {
      display: inline-block;
      font-size: 0.625rem;
      font-weight: 600;
      padding: 0.0625rem 0.375rem;
      border-radius: 3px;
      margin-left: 0.375rem;
      vertical-align: middle;
    }
    .badge-high { background: #fecaca; color: #991b1b; }
    .badge-medium { background: #fef3c7; color: #92400e; }
    .badge-low { background: #f3f4f6; color: #374151; }

    .text-error { color: #dc2626; }
    .violation-text {
      color: #6b7280;
      font-size: 0.8125rem;
      margin-top: 0.125rem;
    }
  </style>
</head>
<body>
  <h1>QA Dashboard</h1>
  <div class="timestamp">${new Date().toLocaleString()}</div>

  <div class="summary-bar">
    <span><strong>${totalClean}</strong> clean</span>
    <span><strong>${totalChanged}</strong> changed</span>
    <span><strong>${totalMissing}</strong> missing</span>
  </div>

  <table class="main-table">
    <thead>
      <tr><th>Task</th><th>Status</th><th>Scope</th><th>Result</th></tr>
    </thead>
    <tbody>
      ${tableRows}
    </tbody>
  </table>
</body>
</html>`;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const artifactsDir = path.resolve(args.artifactsDir);
  const outputPath = path.resolve(args.output);

  const taskRuns = await scanArtifacts(artifactsDir);

  const html = generateHtml(taskRuns, artifactsDir);
  await fs.writeFile(outputPath, html, "utf8");
  console.log(`Dashboard written to: ${outputPath}`);
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
