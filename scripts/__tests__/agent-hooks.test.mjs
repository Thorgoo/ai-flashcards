// Proves the Claude Code hooks in .claude/hooks: each case sends a real payload to the real script
// and asserts the exit code and stderr, the only combination Claude sees (exit 2 + stderr).
// Everything runs in throwaway git repositories; only eslint, vitest and astro are stubbed.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const HOOKS_DIR = path.join(REPO_ROOT, ".claude", "hooks");
const SETTINGS = path.join(REPO_ROOT, ".claude", "settings.json");

const STUBS = {
  eslint: `
    import { appendFileSync, readFileSync } from "node:fs";
    const args = process.argv.slice(2);
    appendFileSync(".stub/calls.log", "eslint " + args.join(" ") + "\\n");
    const broken = args.filter((a) => !a.startsWith("-") && readFileSync(a, "utf8").includes("LINT_ERROR"));
    if (broken.length > 0) { console.log(broken.map((f) => f + ": error no-unused-vars").join("\\n")); process.exit(1); }
  `,
  vitest: `
    import { appendFileSync, existsSync } from "node:fs";
    appendFileSync(".stub/calls.log", "vitest " + process.argv.slice(2).join(" ") + "\\n");
    if (existsSync(".stub/fail-vitest")) { console.log("AssertionError: expected 1 to be 2"); process.exit(1); }
  `,
  astro: `
    import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
    const command = process.argv[2];
    appendFileSync(".stub/calls.log", "astro " + command + "\\n");
    if (command === "sync") { mkdirSync(".astro", { recursive: true }); writeFileSync(".astro/types.d.ts", ""); process.exit(0); }
    if (existsSync(".stub/fail-astro")) { console.log("src/clean.ts:1:1 - error ts(2322): bad type"); process.exit(1); }
  `,
};

/** Git Bash, not the WSL launcher in System32, which is what a bare `bash` can resolve to on Windows. */
function findBash() {
  if (process.platform !== "win32") return "bash";
  const execPath = spawnSync("git", ["--exec-path"], { encoding: "utf8" }).stdout.trim();
  const candidate = path.resolve(execPath, "..", "..", "..", "bin", "bash.exe");
  if (!existsSync(candidate)) throw new Error(`Git Bash not found at ${candidate}`);
  return candidate;
}

function cleanEnv(extra = {}) {
  // Hooks and tests must not inherit a parent's vitest run or a git hook's repository.
  const inherited = Object.entries(process.env).filter(
    ([key]) => !key.startsWith("VITEST") && !key.startsWith("GIT_") && key !== "NODE_OPTIONS",
  );
  return { ...Object.fromEntries(inherited), ...extra };
}

function git(cwd, ...args) {
  const result = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], {
    cwd,
    encoding: "utf8",
    env: cleanEnv(),
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

function installStubs(root) {
  mkdirSync(path.join(root, ".stub"), { recursive: true });
  mkdirSync(path.join(root, ".astro"), { recursive: true });
  writeFileSync(path.join(root, ".astro", "types.d.ts"), "");
  for (const [name, source] of Object.entries(STUBS)) {
    const directory = path.join(root, "node_modules", name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name, bin: { [name]: "cli.mjs" } }));
    writeFileSync(path.join(directory, "cli.mjs"), source);
  }
}

function createRepo(parent, name) {
  const root = path.join(parent, name);
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, ".gitignore"), "node_modules/\n.astro/\n.stub/\n");
  writeFileSync(path.join(root, "README.md"), "# fixture\n");
  writeFileSync(path.join(root, "src", "clean.ts"), "export const clean = 1;\n");
  mkdirSync(path.join(root, ".claude"));
  cpSync(HOOKS_DIR, path.join(root, ".claude", "hooks"), { recursive: true });
  cpSync(SETTINGS, path.join(root, ".claude", "settings.json"));
  git(root, "init", "--quiet");
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "fixture");
  installStubs(root);
  return root;
}

function write(root, relative, content) {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

function calls(root) {
  const log = path.join(root, ".stub", "calls.log");
  return existsSync(log) ? readFileSync(log, "utf8") : "";
}

describe("agent hooks", { timeout: 60_000 }, () => {
  let sandbox;
  let repo;

  function runScript(script, payload, options = {}) {
    const input = typeof payload === "string" ? payload : JSON.stringify(payload);
    return spawnSync(process.execPath, [path.join(repo, ".claude", "hooks", script)], {
      cwd: options.cwd ?? repo,
      input,
      encoding: "utf8",
      env: cleanEnv({ TMP: sandbox, TEMP: sandbox, TMPDIR: sandbox, ...options.env }),
    });
  }

  const editPayload = (file, extra = {}) => ({
    tool_name: "Edit",
    cwd: repo,
    session_id: "session-1",
    tool_input: { file_path: file },
    ...extra,
  });
  const stopPayload = (extra = {}) => ({ cwd: repo, session_id: "session-1", stop_hook_active: false, ...extra });

  beforeEach(() => {
    sandbox = mkdtempSync(path.join(tmpdir(), "agent-hooks-"));
    repo = createRepo(sandbox, "repo");
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  describe("lint-edited-file", () => {
    it("blocks a broken file and names the file and the problem on stderr", () => {
      const file = write(repo, "src/broken.ts", "const LINT_ERROR = 1;\n");
      const result = runScript("lint-edited-file.mjs", editPayload(file));
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("broken.ts");
      expect(result.stderr).toContain("no-unused-vars");
    });

    it("lints only the edited file", () => {
      write(repo, "src/other-broken.ts", "const LINT_ERROR = 1;\n");
      const result = runScript("lint-edited-file.mjs", editPayload(path.join(repo, "src", "clean.ts")));
      expect(result.status).toBe(0);
      expect(calls(repo).trim()).toBe("eslint --quiet src/clean.ts");
    });

    it("covers .astro files", () => {
      const file = write(repo, "src/page.astro", "---\nconst LINT_ERROR = 1;\n---\n");
      expect(runScript("lint-edited-file.mjs", editPayload(file)).status).toBe(2);
    });

    it("passes a clean file with no blocking output", () => {
      const result = runScript("lint-edited-file.mjs", editPayload(path.join(repo, "src", "clean.ts")));
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    });

    it("skips a file type the linter does not cover", () => {
      const result = runScript("lint-edited-file.mjs", editPayload(path.join(repo, "README.md")));
      expect(result.status).toBe(0);
      expect(calls(repo)).toBe("");
    });

    it("skips a file that does not exist", () => {
      const result = runScript("lint-edited-file.mjs", editPayload(path.join(repo, "src", "gone.ts")));
      expect(result.status).toBe(0);
      expect(calls(repo)).toBe("");
    });

    it.each([
      ["an empty object", "{}"],
      ["unparseable input", "not json"],
      ["empty stdin", ""],
      ["JSON null", "null"],
      ["a tool call without a path", JSON.stringify({ tool_name: "Edit", tool_input: {} })],
      ["a non-string path", JSON.stringify({ tool_input: { file_path: 7 } })],
    ])("treats %s as nothing to check", (_label, payload) => {
      const result = runScript("lint-edited-file.mjs", payload);
      expect(result.status).toBe(0);
      expect(calls(repo)).toBe("");
    });

    it("resolves a relative path against the payload cwd", () => {
      write(repo, "src/broken.ts", "const LINT_ERROR = 1;\n");
      const result = runScript("lint-edited-file.mjs", editPayload("src/broken.ts"), { cwd: sandbox });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("broken.ts");
    });

    it("skips a broken file from another repository", () => {
      const other = createRepo(sandbox, "other");
      const file = write(other, "src/broken.ts", "const LINT_ERROR = 1;\n");
      const result = runScript("lint-edited-file.mjs", editPayload(file));
      expect(result.status).toBe(0);
      expect(calls(other)).toBe("");
    });

    it("ignores a project dir variable that points at another checkout", () => {
      const other = createRepo(sandbox, "other");
      write(other, "src/broken.ts", "const LINT_ERROR = 1;\n");
      const result = runScript("lint-edited-file.mjs", editPayload(path.join(repo, "src", "clean.ts")), {
        env: { CLAUDE_PROJECT_DIR: other },
      });
      expect(result.status).toBe(0);
      expect(calls(other)).toBe("");
    });

    it("fails visibly when the linter is not installed", () => {
      rmSync(path.join(repo, "node_modules", "eslint"), { recursive: true });
      const result = runScript("lint-edited-file.mjs", editPayload(path.join(repo, "src", "clean.ts")));
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("eslint is not installed");
    });

    it("generates the gitignored Astro types before linting a fresh checkout", () => {
      rmSync(path.join(repo, ".astro"), { recursive: true });
      const result = runScript("lint-edited-file.mjs", editPayload(path.join(repo, "src", "clean.ts")));
      expect(result.status).toBe(0);
      expect(calls(repo).split("\n")[0]).toBe("astro sync");
    });
  });

  describe("related-tests", () => {
    it("blocks when a related test fails", () => {
      write(repo, ".stub/fail-vitest", "");
      const result = runScript("related-tests.mjs", editPayload(path.join(repo, "src", "clean.ts")));
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("clean.ts");
      expect(result.stderr).toContain("AssertionError");
    });

    it("passes and runs only the edited file's related tests", () => {
      const result = runScript("related-tests.mjs", editPayload(path.join(repo, "src", "clean.ts")));
      expect(result.status).toBe(0);
      expect(calls(repo).trim()).toBe("vitest related src/clean.ts --run");
    });

    it.each([
      ["a skipped type", () => editPayload(path.join(repo, "README.md"))],
      ["a missing file", () => editPayload(path.join(repo, "src", "gone.ts"))],
      ["an empty payload", () => ({})],
    ])("does nothing for %s", (_label, payload) => {
      const result = runScript("related-tests.mjs", payload());
      expect(result.status).toBe(0);
      expect(calls(repo)).toBe("");
    });

    it("fails visibly when the test runner is not installed", () => {
      rmSync(path.join(repo, "node_modules", "vitest"), { recursive: true });
      const result = runScript("related-tests.mjs", editPayload(path.join(repo, "src", "clean.ts")));
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("vitest is not installed");
    });
  });

  describe("end-of-turn", () => {
    it("passes without running any check when nothing changed", () => {
      const result = runScript("end-of-turn.mjs", stopPayload());
      expect(result.status).toBe(0);
      expect(calls(repo)).toBe("");
    });

    it("runs no checks for a docs-only change", () => {
      write(repo, "README.md", "# changed\n");
      const result = runScript("end-of-turn.mjs", stopPayload());
      expect(result.status).toBe(0);
      expect(calls(repo)).toBe("");
    });

    it("passes a clean change after running lint, the unit suite and the typecheck", () => {
      write(repo, "src/clean.ts", "export const clean = 2;\n");
      const result = runScript("end-of-turn.mjs", stopPayload());
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(calls(repo).trim().split("\n")).toEqual(["eslint --quiet src/clean.ts", "vitest run", "astro check"]);
    });

    it("blocks on a lint error written straight to disk, bypassing the per-edit hook", () => {
      write(repo, "src/from-shell.ts", "const LINT_ERROR = 1;\n");
      const result = runScript("end-of-turn.mjs", stopPayload());
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("src/from-shell.ts");
    });

    it("reports every failing gate in one message", () => {
      write(repo, "src/broken.ts", "const LINT_ERROR = 1;\n");
      write(repo, ".stub/fail-vitest", "");
      write(repo, ".stub/fail-astro", "");
      const result = runScript("end-of-turn.mjs", stopPayload());
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("ESLint errors");
      expect(result.stderr).toContain("Unit tests fail");
      expect(result.stderr).toContain("Typecheck fails");
    });

    it("typechecks after a deleted module, without linting the missing file", () => {
      rmSync(path.join(repo, "src", "clean.ts"));
      write(repo, ".stub/fail-astro", "");
      const result = runScript("end-of-turn.mjs", stopPayload());
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("Typecheck fails");
      expect(calls(repo)).not.toContain("eslint");
    });

    it("lets the agent finish on the retry even though the error remains", () => {
      write(repo, "src/broken.ts", "const LINT_ERROR = 1;\n");
      const result = runScript("end-of-turn.mjs", stopPayload({ stop_hook_active: true }));
      expect(result.status).toBe(0);
      expect(calls(repo)).toBe("");
    });

    it("honours loop_count from harnesses that import this hook", () => {
      write(repo, "src/broken.ts", "const LINT_ERROR = 1;\n");
      expect(runScript("end-of-turn.mjs", stopPayload({ loop_count: 1 })).status).toBe(0);
    });

    it.each([
      ["an empty object", "{}"],
      ["unparseable input", "not json"],
    ])("treats %s as a clean tree when the session cwd has no changes", (_label, payload) => {
      expect(runScript("end-of-turn.mjs", payload).status).toBe(0);
    });

    it("sweeps a sibling worktree the per-edit hook registered", () => {
      const sibling = path.join(sandbox, "sibling");
      git(repo, "worktree", "add", "--quiet", "-b", "sibling", sibling);
      installStubs(sibling);
      const file = write(sibling, "src/broken.ts", "const LINT_ERROR = 1;\n");
      expect(runScript("lint-edited-file.mjs", editPayload(file)).status).toBe(2);

      const result = runScript("end-of-turn.mjs", stopPayload());
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("src/broken.ts");
    });

    it("checks the payload cwd, not a project dir variable naming a broken checkout", () => {
      const other = createRepo(sandbox, "other");
      write(other, "src/broken.ts", "const LINT_ERROR = 1;\n");
      const result = runScript("end-of-turn.mjs", stopPayload(), { env: { CLAUDE_PROJECT_DIR: other } });
      expect(result.status).toBe(0);
      expect(calls(other)).toBe("");
    });

    it("fails visibly when the typechecker is not installed", () => {
      write(repo, "src/clean.ts", "export const clean = 2;\n");
      rmSync(path.join(repo, "node_modules", "astro"), { recursive: true });
      const result = runScript("end-of-turn.mjs", stopPayload());
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("astro is not installed");
    });

    it("tells the user when the session is not in a git checkout", () => {
      const outside = path.join(sandbox, "outside");
      mkdirSync(outside);
      const result = runScript("end-of-turn.mjs", { cwd: outside }, { cwd: outside });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).systemMessage).toContain("nothing checked");
    });
  });

  describe("settings.json", () => {
    const configured = JSON.parse(readFileSync(SETTINGS, "utf8")).hooks;
    const commands = [
      ...configured.PostToolUse.flatMap((entry) => entry.hooks),
      ...configured.Stop.flatMap((entry) => entry.hooks),
    ].map((hook) => hook.command);

    it("matches the edit tools and sets timeouts in seconds", () => {
      expect(configured.PostToolUse[0].matcher).toBe("Write|Edit");
      for (const entry of [...configured.PostToolUse, ...configured.Stop]) {
        for (const hook of entry.hooks) expect(hook.timeout).toBeLessThanOrEqual(120);
      }
    });

    it.each(commands)("reaches its script from a worktree with a stale project dir: %s", (command) => {
      const sibling = path.join(sandbox, "sibling");
      git(repo, "worktree", "add", "--quiet", "-b", "sibling", sibling);
      installStubs(sibling);
      const broken = write(sibling, "src/broken.ts", "const LINT_ERROR = 1;\n");
      write(sibling, ".stub/fail-vitest", "");

      const result = spawnSync(findBash(), ["-c", command], {
        cwd: sibling,
        input: JSON.stringify({ cwd: sibling, stop_hook_active: false, tool_input: { file_path: broken } }),
        encoding: "utf8",
        env: cleanEnv({ CLAUDE_PROJECT_DIR: path.join(sandbox, "does-not-exist") }),
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/ESLint|Tests related|Fix these/);
    });
  });
});
