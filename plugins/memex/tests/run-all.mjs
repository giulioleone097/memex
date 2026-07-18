import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_ROOT = dirname(fileURLToPath(import.meta.url));
const PERFORMANCE_TEST = join(TEST_ROOT, "e2e", "retrieve-performance.e2e.test.mjs");

const testFiles = await collectTestFiles(TEST_ROOT);
const functionalTests = testFiles.filter((file) => file !== PERFORMANCE_TEST);

// Node runs test files concurrently by default. Keep the functional suite fast,
// then measure performance without competing against the rest of the suite.
const functionalStatus = runTests(functionalTests);
if (functionalStatus !== 0) process.exit(functionalStatus);

process.exit(runTests([PERFORMANCE_TEST]));

async function collectTestFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectTestFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".test.mjs")) {
      files.push(path);
    }
  }
  return files.sort();
}

function runTests(files) {
  const result = spawnSync(process.execPath, ["--test", ...files], {
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error !== undefined) throw result.error;
  return result.status ?? 1;
}
