#!/usr/bin/env node
// Stop: sweep everything this turn changed before the agent finishes, with one retry.
// This also catches files rewritten through a shell command, which never reach a per-edit hook.
import { existsSync } from "node:fs";
import path from "node:path";
import {
  LINT_EXTENSIONS,
  TEST_EXTENSIONS,
  block,
  changedFiles,
  clearRegisteredCheckouts,
  ensureGeneratedTypes,
  gitToplevel,
  readPayload,
  registeredCheckouts,
  runHook,
  runTool,
  sessionCwd,
} from "./lib.mjs";

// Not lintable, but a change here can still break the tests or the typecheck.
const PROJECT_CONFIG_FILES = new Set(["package.json", "tsconfig.json"]);

function sweep(root) {
  const changed = changedFiles(root);
  const affectsCode = changed.some(
    (file) =>
      LINT_EXTENSIONS.has(path.extname(file)) ||
      TEST_EXTENSIONS.has(path.extname(file)) ||
      PROJECT_CONFIG_FILES.has(file),
  );
  // A Q&A turn or a docs-only change: nothing to check here.
  if (!affectsCode) return [];

  const syncError = ensureGeneratedTypes(root);
  if (syncError !== null) return [syncError];

  const failures = [];
  // Deleted files cannot be linted, but they still trigger the tests and the typecheck below.
  const lintable = changed.filter(
    (file) => LINT_EXTENSIONS.has(path.extname(file)) && existsSync(path.join(root, file)),
  );
  if (lintable.length > 0) {
    const lint = runTool(root, "eslint", ["--quiet", ...lintable]);
    if (!lint.ok) failures.push(`ESLint errors in changed files (${root}):\n${lint.output}`);
  }

  // The whole unit suite takes seconds, so it also catches a red test in a module this turn only imported.
  const tests = runTool(root, "vitest", ["run"]);
  if (!tests.ok) failures.push(`Unit tests fail (${root}):\n${tests.output}`);

  // Same typecheck as CI; it covers .astro files, which plain tsc does not.
  const typecheck = runTool(root, "astro", ["check"]);
  if (!typecheck.ok) failures.push(`Typecheck fails (${root}):\n${typecheck.output}`);

  return failures;
}

runHook("end-of-turn", () => {
  const payload = readPayload();

  // Already sent back once by this hook: let it finish. The commit gate and CI catch the rest.
  if (payload.stop_hook_active === true || Number(payload.loop_count ?? 0) > 0) return 0;

  const cwd = sessionCwd(payload);
  const sessionRoot = existsSync(cwd) ? gitToplevel(cwd) : null;
  const roots = [
    ...new Set(
      [...(sessionRoot === null ? [] : [sessionRoot]), ...registeredCheckouts(payload)].map((r) => path.resolve(r)),
    ),
  ];
  if (roots.length === 0) {
    // Not silent: the user sees why nothing was checked.
    console.log(JSON.stringify({ systemMessage: `end-of-turn hook: no git checkout at ${cwd}, nothing checked.` }));
    return 0;
  }

  const failures = roots.flatMap(sweep);
  if (failures.length > 0) return block(`Fix these before you finish:\n\n${failures.join("\n\n")}`);

  clearRegisteredCheckouts(payload);
  return 0;
});
