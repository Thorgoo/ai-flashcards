#!/usr/bin/env node
// PostToolUse (Write|Edit): lint only the file the agent just edited.
import { existsSync } from "node:fs";
import path from "node:path";
import {
  LINT_EXTENSIONS,
  block,
  checkoutOf,
  editedFile,
  ensureGeneratedTypes,
  isFile,
  readPayload,
  registerCheckout,
  relativeTo,
  runHook,
  runTool,
} from "./lib.mjs";

runHook("lint-edited-file", () => {
  const payload = readPayload();
  const file = editedFile(payload);
  if (file === null || !LINT_EXTENSIONS.has(path.extname(file)) || !existsSync(file) || !isFile(file)) return 0;

  const root = checkoutOf(file, payload);
  if (root === null) return 0;
  registerCheckout(payload, root);

  const syncError = ensureGeneratedTypes(root);
  if (syncError !== null) return block(syncError);

  // No --fix: rewriting the file under the agent makes its next Edit fail as "modified since read".
  const lint = runTool(root, "eslint", ["--quiet", relativeTo(root, file)]);
  return lint.ok ? 0 : block(`ESLint reported errors in ${file}:\n${lint.output}`);
});
