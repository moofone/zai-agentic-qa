# Z.AI Docs Alignment

This task lives inside the standalone `zai-agentic-qa` project.

Usage:

```bash
npm run docs:alignment -- --repo /absolute/path/to/repo
```

Useful flags:

```bash
npm run docs:alignment -- --repo /absolute/path/to/repo --dry-run
npm run docs:alignment -- --repo /absolute/path/to/repo --output /tmp/docs-alignment
npm run docs:alignment -- --repo /absolute/path/to/repo --model glm-5
npm run docs:alignment -- --repo /absolute/path/to/repo --docs-folders docs/architecture,docs/guides
npm run docs:alignment -- --repo /absolute/path/to/repo --max-agents 3
npm run docs:alignment -- --repo /absolute/path/to/repo --worker-timeout-seconds 1800
npm run docs:alignment -- --repo /absolute/path/to/repo --apply
```

Prerequisite:

```bash
export Z_AI_API_KEY=...
```

What it does:

- Uses the Z.AI coding chat-completions API directly
- Creates a disposable sandbox containing only `docs/`, `src/`, and `tests/`
- Scans configured `--docs-folders` (default `docs/architecture`) recursively for `*.md` files
- Runs concurrent workers (via `--max-agents`) against each discovered doc
- Each worker reads `src/**` and `tests/**` as code evidence and rewrites only its assigned doc
- Never allows writes outside the assigned document
- Prints each `write_file` edit in real time as a compact patch snippet
- Validates that the final diff touches only docs under the configured folders
- Failed workers do not block other workers
- Optionally copies validated sandbox docs back to the real repo when `--apply` is set
- Writes run artifacts under `artifacts/opencode-docs-alignment/...`

Artifacts:

```
<outputDir>/
  run-config.json
  sandbox-path.txt
  report.json
  report.md
  final-diff.json
  workers/
    <doc-basename>/
      zai-round-01.json
      zai-round-02.json
      ...
      worker-output.txt
      diff.json
```

Current limits:

- Default behavior is patch-only inside the sandbox unless `--apply` is passed
- No commit, branch, or scheduler integration
- Write scope is strictly the assigned Markdown file
- Code evidence scope is strictly `src/**` and `tests/**`
- The sandbox copy is retained for inspection and contains only the alignment scope

Run it from the project folder:

```bash
cd zai-agentic-qa
npm run docs:alignment -- --repo /absolute/path/to/repo
```
