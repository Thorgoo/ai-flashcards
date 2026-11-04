// Shared helpers for the Claude Code hooks in this directory.
// Claude only sees a hook's stderr when it exits 2, so every failure must end up there.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

// Derived from eslint.config.js: eslint-plugin-astro covers .astro on top of the JS/TS family.
export const LINT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".astro"]);
export const TEST_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

const MAX_OUTPUT_CHARS = 12_000;
const BLOCKING_EXIT = 2;

/** Runs a hook body; an unexpected crash reaches Claude instead of exiting 1, which nobody sees. */
export function runHook(name, main) {
  try {
    process.exitCode = main() ?? 0;
  } catch (error) {
    console.error(`Hook ${name} crashed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = BLOCKING_EXIT;
  }
}

export function block(message) {
  console.error(message);
  return BLOCKING_EXIT;
}

/** Any malformed or empty payload means "nothing to check", never a hook failure. */
export function readPayload() {
  try {
    const payload = JSON.parse(readFileSync(0, "utf8"));
    return payload !== null && typeof payload === "object" ? payload : {};
  } catch {
    return {};
  }
}

function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
  if (result.error) {
    throw new Error(`git could not run: ${result.error.message}`);
  }
  return result.status === 0 ? result.stdout : null;
}

export function gitToplevel(cwd) {
  const output = git(cwd, ["rev-parse", "--show-toplevel"]);
  return output === null ? null : path.resolve(output.trim());
}

function gitCommonDir(cwd) {
  const output = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (output === null) return null;
  const resolved = path.resolve(output.trim());
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Absolute path of the edited file from the payload, or null when the payload names none. */
export function editedFile(payload) {
  const file = payload.tool_input?.file_path ?? payload.tool_input?.notebook_path;
  if (typeof file !== "string" || file === "") return null;
  return path.resolve(sessionCwd(payload), file);
}

export function sessionCwd(payload) {
  return typeof payload.cwd === "string" && payload.cwd !== "" ? payload.cwd : process.cwd();
}

export function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * The checkout owning the edited file, or null for files outside this repository
 * (~/.claude, other projects). $CLAUDE_PROJECT_DIR is deliberately unused: after EnterWorktree,
 * or for an edit in a sibling worktree, it names a different checkout.
 */
export function checkoutOf(file, payload) {
  const directory = path.dirname(file);
  const root = gitToplevel(directory);
  if (root === null) return null;
  const repository = gitCommonDir(root);
  const sessionRepository = gitCommonDir(sessionCwd(payload));
  return repository !== null && repository === sessionRepository ? root : null;
}

export function relativeTo(root, file) {
  return path.relative(root, file).replaceAll("\\", "/");
}

function registryPath(payload) {
  const sessionId = typeof payload.session_id === "string" ? payload.session_id.replace(/[^A-Za-z0-9_-]/g, "") : "";
  return sessionId === "" ? null : path.join(tmpdir(), "claude-hooks", `${sessionId}.roots`);
}

/** Remembers a checkout edited this session so the Stop hook sweeps it even when it is not cwd. */
export function registerCheckout(payload, root) {
  const registry = registryPath(payload);
  if (registry === null) return;
  mkdirSync(path.dirname(registry), { recursive: true });
  appendFileSync(registry, `${root}\n`);
}

export function registeredCheckouts(payload) {
  const registry = registryPath(payload);
  if (registry === null || !existsSync(registry)) return [];
  return readFileSync(registry, "utf8")
    .split("\n")
    .filter((root) => root !== "" && existsSync(root));
}

export function clearRegisteredCheckouts(payload) {
  const registry = registryPath(payload);
  if (registry !== null && existsSync(registry)) writeFileSync(registry, "");
}

/** Changed and new files relative to the checkout root, including deleted ones. */
export function changedFiles(root) {
  const tracked = git(root, ["diff", "--name-only", "-z", "HEAD"]) ?? "";
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]) ?? "";
  return [...new Set(`${tracked}${untracked}`.split("\0").filter(Boolean))];
}

function binaryOf(root, packageName) {
  const manifestPath = path.join(root, "node_modules", packageName, "package.json");
  if (!existsSync(manifestPath)) return null;
  const { bin } = JSON.parse(readFileSync(manifestPath, "utf8"));
  const relative = typeof bin === "string" ? bin : bin?.[packageName];
  return relative === undefined ? null : path.join(root, "node_modules", packageName, relative);
}

function clip(text) {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `[output truncated to the last ${MAX_OUTPUT_CHARS} characters]\n${text.slice(-MAX_OUTPUT_CHARS)}`;
}

/** Runs a locally installed tool. A missing or crashing tool is a failure, never a pass. */
export function runTool(root, packageName, args) {
  const binary = binaryOf(root, packageName);
  if (binary === null || !existsSync(binary)) {
    return { ok: false, output: `${packageName} is not installed in ${root}; run npm ci.` };
  }
  const result = spawnSync(process.execPath, [binary, ...args], {
    cwd: root,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) {
    return { ok: false, output: `${packageName} could not run: ${result.error.message}` };
  }
  const output = stripVTControlCharacters(`${result.stdout}${result.stderr}`).trim();
  return {
    ok: result.status === 0,
    output: clip(output === "" ? `${packageName} exited with ${result.status} and no output.` : output),
  };
}

/**
 * .astro/ is gitignored, so a fresh worktree lacks it and type-aware ESLint then reports
 * false errors on astro:* imports. Returns an error message when the sync itself fails.
 */
export function ensureGeneratedTypes(root) {
  if (existsSync(path.join(root, ".astro", "types.d.ts"))) return null;
  const sync = runTool(root, "astro", ["sync"]);
  return sync.ok ? null : `astro sync failed in ${root}:\n${sync.output}`;
}
