import path from "node:path";
import fs from "node:fs/promises";

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeSlashes(value) {
  return value.replaceAll("\\", "/");
}

async function appendDebugLog(line) {
  const logPath = process.env.ZAI_DOCS_ALIGNMENT_DEBUG_LOG;
  if (!logPath) return;
  await fs.appendFile(logPath, `${new Date().toISOString()} ${line}\n`, "utf8");
}

function isDocsPath(pattern, worktree) {
  if (!pattern) return false;
  const normalizedPattern = normalizeSlashes(String(pattern)).replace(/^\.\//, "");
  const normalizedWorktree = normalizeSlashes(worktree);

  if (
    normalizedPattern === "docs" ||
    normalizedPattern === "docs/" ||
    normalizedPattern.startsWith("docs/")
  ) {
    return true;
  }

  if (path.isAbsolute(normalizedPattern)) {
    const relativeToWorktree = normalizeSlashes(path.relative(normalizedWorktree, normalizedPattern));
    return (
      relativeToWorktree === "docs" ||
      relativeToWorktree === "docs/" ||
      relativeToWorktree.startsWith("docs/")
    );
  }

  return false;
}

function extractTargetPath(args) {
  if (!args || typeof args !== "object") return null;
  if (typeof args.filePath === "string") return args.filePath;
  if (typeof args.path === "string") return args.path;
  return null;
}

export const DocsAuditGuardPlugin = async (input) => {
  const { directory, worktree } = input;
  const rootDirectory = directory || worktree;
  await appendDebugLog(`plugin.initialized ${JSON.stringify({ directory, worktree, rootDirectory })}`);

  return {
    async "permission.ask"(permission, output) {
      await appendDebugLog(`permission.ask ${JSON.stringify(permission)}`);

      // The actual write boundary is enforced in tool.execute.before.
      // Keep permission.ask as lightweight telemetry plus early deny for tools
      // we never expect in this harness.
      if (
        permission.type === "bash" ||
        permission.type === "webfetch" ||
        permission.type === "external_directory"
      ) {
        output.status = "deny";
        await appendDebugLog(`permission.reply ${permission.type} deny`);
        return;
      }

      if (permission.type === "edit") {
        const patterns = asArray(permission.pattern);
        if (patterns.length > 0 && patterns.every((pattern) => isDocsPath(pattern, rootDirectory))) {
          output.status = "allow";
          await appendDebugLog(`permission.reply ${permission.type} allow`);
          return;
        }
      }

      output.status = "ask";
      await appendDebugLog(`permission.reply ${permission.type} ask`);
    },
    async "tool.execute.before"(input, output) {
      await appendDebugLog(`tool.before ${JSON.stringify({ tool: input.tool, args: output.args })}`);
      if (input.tool !== "edit" && input.tool !== "write") {
        return;
      }

      const targetPath = extractTargetPath(output.args);
      if (!targetPath) {
        await appendDebugLog(`tool.blocked ${JSON.stringify({ tool: input.tool, reason: "missing-target-path" })}`);
        throw new Error("Missing target path for edit/write tool.");
      }

      if (!isDocsPath(targetPath, rootDirectory)) {
        await appendDebugLog(`tool.blocked ${JSON.stringify({ tool: input.tool, targetPath })}`);
        throw new Error("Only docs/** edits are allowed.");
      }

      await appendDebugLog(`tool.allowed ${JSON.stringify({ tool: input.tool, targetPath })}`);
    },
    async "tool.execute.after"(input, output) {
      await appendDebugLog(
        `tool.after ${JSON.stringify({ tool: input.tool, metadata: output.metadata, title: output.title })}`,
      );
    },
  };
};
