import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const FIXTURE_ROOT = dirname(fileURLToPath(import.meta.url));

export const PLUGIN_ROOT = resolve(FIXTURE_ROOT, "../../..");
export const CLI_PATH = join(PLUGIN_ROOT, "dist/cli.js");
export const MCP_PATH = join(PLUGIN_ROOT, "dist/mcp.js");
export const HOOK_PATH = join(PLUGIN_ROOT, "dist/hook.js");
export const SOURCE_ENVELOPE_PATH = join(FIXTURE_ROOT, "source-envelope.json");

const MCP_RESPONSE_TIMEOUT_MS = 10_000;
const MCP_EXIT_TIMEOUT_MS = 3_000;

export function assertAdapterExists(adapterPath, adapterName) {
  assert.equal(
    existsSync(adapterPath),
    true,
    `Task 4 RED: missing production ${adapterName} adapter at ${adapterPath}`,
  );
}

export function makeTemporaryRoot(t, label) {
  const root = mkdtempSync(join(tmpdir(), `memex adapter ${label} `));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  return root;
}

export function makeIsolatedEnvironment(home, extra = {}) {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    ...extra,
  };
}

export function runNodeAdapter(
  adapterPath,
  args,
  { cwd = PLUGIN_ROOT, env = process.env, input, timeout = 10_000 } = {},
) {
  return spawnSync(process.execPath, [adapterPath, ...args], {
    cwd,
    encoding: "utf8",
    env,
    input,
    shell: false,
    timeout,
    windowsHide: true,
  });
}

export function parseSingleJsonDocument(stdout) {
  assert.notEqual(stdout.trim(), "", "adapter stdout must contain one JSON document");
  let parsed;
  assert.doesNotThrow(() => {
    parsed = JSON.parse(stdout);
  }, "adapter stdout must contain exactly one JSON document");
  return parsed;
}

export function initializeGitRepository(root, files = {}) {
  mkdirSync(root, { recursive: true });
  runGit(root, ["init", "--initial-branch=main"]);
  runGit(root, ["config", "user.email", "memex@example.test"]);
  runGit(root, ["config", "user.name", "Memex Adapter Test"]);

  const entries = Object.entries(files);
  if (entries.length === 0) {
    entries.push(["README.md", "# Adapter fixture\n"]);
  }
  for (const [file, content] of entries) {
    const filePath = join(root, file);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, "utf8");
  }

  runGit(root, ["add", "--all"]);
  runGit(root, ["commit", "-m", "test: initialize adapter fixture"]);
  return runGit(root, ["rev-parse", "HEAD"]).trim();
}

export function runGit(root, args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

export function snapshotTree(root) {
  if (!existsSync(root)) {
    return [];
  }

  const entries = [];
  visit(root);
  return entries;

  function visit(entryPath) {
    const metadata = lstatSync(entryPath, { bigint: true });
    const entry = {
      path: relative(root, entryPath).split("\\").join("/") || ".",
      type: metadata.isDirectory()
        ? "directory"
        : metadata.isFile()
          ? "file"
          : metadata.isSymbolicLink()
            ? "symlink"
            : "other",
      mode: Number(metadata.mode),
      mtimeNs: metadata.mtimeNs.toString(),
      size: metadata.size.toString(),
    };
    if (metadata.isFile()) {
      entry.sha256 = createHash("sha256").update(readFileSync(entryPath)).digest("hex");
    }
    entries.push(entry);

    if (metadata.isDirectory()) {
      for (const child of readdirSync(entryPath).sort()) {
        visit(join(entryPath, child));
      }
    }
  }
}

export function fileMtimeNs(filePath) {
  return statSync(filePath, { bigint: true }).mtimeNs.toString();
}

export function createMcpSession(t, { cwd = PLUGIN_ROOT, env = process.env } = {}) {
  const child = spawn(process.execPath, [MCP_PATH], {
    cwd,
    env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  const stdoutLines = [];
  const queuedLines = [];
  const lineWaiters = [];
  const stderrChunks = [];
  let stdoutBuffer = "";
  let exitResult;

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    let newline = stdoutBuffer.indexOf("\n");
    while (newline !== -1) {
      const line = stdoutBuffer.slice(0, newline).replace(/\r$/u, "");
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      deliverLine(line);
      newline = stdoutBuffer.indexOf("\n");
    }
  });
  child.stdout.on("end", () => {
    if (stdoutBuffer !== "") {
      deliverLine(stdoutBuffer);
      stdoutBuffer = "";
    }
  });
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

  const exitPromise = new Promise((resolveExit) => {
    child.once("exit", (code, signal) => {
      exitResult = { code, signal };
      for (const waiter of lineWaiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(
          new Error(`MCP process exited before response (code=${String(code)}, signal=${String(signal)})`),
        );
      }
      resolveExit(exitResult);
    });
  });

  t.after(async () => {
    if (exitResult === undefined) {
      child.kill("SIGKILL");
      await exitPromise;
    }
  });

  return {
    child,
    stdoutLines,
    get stderr() {
      return stderrChunks.join("");
    },
    send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    sendRaw(text) {
      child.stdin.write(text);
    },
    async splitWrite(text, splitAt) {
      child.stdin.write(text.slice(0, splitAt));
      await waitForImmediate();
      child.stdin.write(text.slice(splitAt));
    },
    async nextMessage(timeout = MCP_RESPONSE_TIMEOUT_MS) {
      const line = await nextLine(timeout);
      assert.notEqual(line, "", "MCP server must not emit blank protocol lines");
      let message;
      assert.doesNotThrow(() => {
        message = JSON.parse(line);
      }, `MCP stdout line must be JSON-RPC: ${line}`);
      assert.equal(message.jsonrpc, "2.0");
      return message;
    },
    async finish(timeout = MCP_EXIT_TIMEOUT_MS) {
      child.stdin.end();
      return withTimeout(exitPromise, timeout, "MCP process did not exit after stdin EOF");
    },
  };

  function deliverLine(line) {
    stdoutLines.push(line);
    const waiter = lineWaiters.shift();
    if (waiter === undefined) {
      queuedLines.push(line);
      return;
    }
    clearTimeout(waiter.timer);
    waiter.resolve(line);
  }

  function nextLine(timeout) {
    const queued = queuedLines.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }

    return new Promise((resolveLine, rejectLine) => {
      const waiter = {
        resolve: resolveLine,
        reject: rejectLine,
        timer: undefined,
      };
      waiter.timer = setTimeout(() => {
        const index = lineWaiters.indexOf(waiter);
        if (index !== -1) {
          lineWaiters.splice(index, 1);
        }
        rejectLine(new Error(`Timed out waiting ${String(timeout)}ms for MCP stdout`));
      }, timeout);
      lineWaiters.push(waiter);
    });
  }
}

function withTimeout(promise, timeout, message) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeout);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}
