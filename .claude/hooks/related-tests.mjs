#!/usr/bin/env node
// PostToolUse (Write|Edit): run the tests that depend on the file the agent just edited.
// `vitest related` exits 0 when no test depends on the file.
import { existsSync } from "node:fs";
import path from "node:path";
import {
  TEST_EXTENSIONS,
  block,
  checkoutOf,
  editedFile,
  isFile,
  readPayload,
  relativeTo,
  runHook,
  runTool,
} from "./lib.mjs";

runHook("related-tests", () => {
  const payload = readPayload();
  const file = editedFile(payload);
  if (file === null || !TEST_EXTENSIONS.has(path.extname(file)) || !existsSync(file) || !isFile(file)) return 0;

  const root = checkoutOf(file, payload);
  if (root === null) return 0;

  const tests = runTool(root, "vitest", ["related", relativeTo(root, file), "--run"]);
  return tests.ok ? 0 : block(`Tests related to ${file} fail:\n${tests.output}`);
});
