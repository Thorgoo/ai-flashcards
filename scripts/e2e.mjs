// Runs the Playwright tests locally against the local Supabase: points .env and .dev.vars at the
// local stack (the CI format, ci.yml "Configure secrets"), with the e2e account allowed and fake
// AI, runs `playwright test` with any extra arguments, then puts the original files back - also
// on Ctrl+C. A leftover backup means an earlier run did not restore; it is never overwritten.
// Local only (CI writes its own .env): needs `supabase start`. Usage: npm run e2e [-- <playwright args>]
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, renameSync, rmSync, writeFileSync } from "node:fs";

const FILES = [".env", ".dev.vars"];
const backupOf = (file) => `${file}.e2e-backup`;
// npx is a .cmd shim on Windows and needs a shell there; the shell gets one command line (Node
// deprecates separate args with shell: true). Only fixed arguments go through it: Playwright,
// which gets the user's arguments, runs from its CLI file with node and no shell.
const isWindows = process.platform === "win32";
const npx = (args) => (isWindows ? [["npx", ...args].join(" "), []] : ["npx", args]);
const PLAYWRIGHT_CLI = "node_modules/@playwright/test/cli.js";

const leftover = FILES.filter((file) => existsSync(backupOf(file)));
if (leftover.length > 0) {
  console.error(`Backup file(s) from an earlier run exist: ${leftover.map(backupOf).join(", ")}.`);
  console.error("Restore each one by hand before running again, e.g.:");
  for (const file of leftover) console.error(`  mv ${backupOf(file)} ${file}`);
  process.exit(1);
}

const status = spawnSync(...npx(["supabase", "status", "-o", "env"]), { encoding: "utf8", shell: isWindows });
const local = {};
for (const line of (status.stdout ?? "").split(/\r?\n/)) {
  const match = /^([A-Z_]+)="?(.*?)"?$/.exec(line.trim());
  if (match) local[match[1]] = match[2];
}
const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = local;
if (status.status !== 0 || !API_URL || !ANON_KEY || !SERVICE_ROLE_KEY) {
  console.error("Could not read API_URL, ANON_KEY and SERVICE_ROLE_KEY from `supabase status -o env`.");
  console.error("Start the local stack first: npx supabase start");
  if (status.stderr) console.error(status.stderr.trim());
  process.exit(1);
}

const appEnv = {
  SUPABASE_URL: API_URL,
  SUPABASE_KEY: ANON_KEY,
  ALLOWED_EMAILS: "e2e@example.com",
  AI_MODE: "fake",
};
const contents = `${Object.entries(appEnv)
  .map(([name, value]) => `${name}=${value}`)
  .join("\n")}\n`;

// Which files existed before the run (and so were backed up), and which this run wrote. Only a
// file written here without a backup is removed afterwards: a failure before the write (a backup
// that could not be made, a busy file) never touches the original.
const backedUp = new Set();
const written = new Set();
let restored = false;
function restore() {
  if (restored) return;
  restored = true;
  for (const file of FILES) {
    if (backedUp.has(file)) {
      renameSync(backupOf(file), file);
    } else if (written.has(file)) {
      rmSync(file, { force: true });
    }
  }
}

let child;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    // Ctrl+C reaches Playwright from the console as well; restore once it has stopped (the close
    // handler below). A SIGTERM sent to this process alone is passed on.
    if (child && child.exitCode === null) {
      if (signal === "SIGTERM") child.kill(signal);
      return;
    }
    restore();
    process.exit(130);
  });
}

let exitCode;
try {
  for (const file of FILES) {
    if (existsSync(file)) {
      copyFileSync(file, backupOf(file));
      backedUp.add(file);
    }
    written.add(file);
    writeFileSync(file, contents);
  }
  exitCode = await new Promise((resolve) => {
    child = spawn(process.execPath, [PLAYWRIGHT_CLI, "test", ...process.argv.slice(2)], {
      stdio: "inherit",
      env: {
        ...process.env,
        // The app reads these too (process env wins over .env), so set them to the local stack as well.
        ...appEnv,
        SUPABASE_ANON_KEY: ANON_KEY,
        SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
      },
    });
    child.on("error", (error) => {
      console.error(`Could not start Playwright: ${error.message}`);
      resolve(1);
    });
    child.on("close", (code, signal) => resolve(code ?? (signal ? 130 : 1)));
  });
} finally {
  restore();
}
process.exit(exitCode);
