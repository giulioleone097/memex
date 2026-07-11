import { execFile } from "node:child_process";
import { stdin, stdout } from "node:process";
import { promisify } from "node:util";

import { resolveWikiLocation, type WikiLocation } from "./paths.js";
import { readState } from "./state.js";

const execFileAsync = promisify(execFile);
const MAX_INPUT_BYTES = 128 * 1024;
const MAX_CONTEXT_CHARS = 300;
const FRESH_MS = 7 * 24 * 60 * 60 * 1000;

interface HookInput {
  cwd?: unknown;
  hook_event_name?: unknown;
}

interface WikiSnapshot {
  mode: "code" | "personal";
  wikiRoot: string;
  updatedAt: string;
}

async function main(): Promise<void> {
  const payload = await readInput();
  if (payload === undefined || payload.hook_event_name !== "SessionStart" || typeof payload.cwd !== "string") return;
  const codeRoot = await nearestGitRoot(payload.cwd);
  const code = codeRoot === undefined ? undefined : await readSnapshot("code", codeRoot);
  const personal = code === undefined ? await readSnapshot("personal") : undefined;
  const snapshot = code ?? personal;
  if (snapshot === undefined) return;
  stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: renderContext(snapshot) } })}\n`);
}

async function readInput(): Promise<HookInput | undefined> {
  stdin.setEncoding("utf8");
  let raw = "";
  for await (const chunk of stdin) {
    if (typeof chunk !== "string") return undefined;
    raw += chunk;
    if (Buffer.byteLength(raw, "utf8") > MAX_INPUT_BYTES) return undefined;
  }
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value))
      : undefined;
  } catch {
    return undefined;
  }
}

async function nearestGitRoot(cwd: string): Promise<string | undefined> {
  try {
    const { stdout: result } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      timeout: 1_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
    const root = result.trim();
    return root.length > 0 ? root : undefined;
  } catch {
    return undefined;
  }
}

async function readSnapshot(mode: "code" | "personal", root?: string): Promise<WikiSnapshot | undefined> {
  try {
    const location = await resolveWikiLocation({ mode, ...(root === undefined ? {} : { root }) });
    const state = await readState(location);
    if (!isValidSnapshot(location, state.mode, state.wikiRoot, state.updatedAt)) return undefined;
    return { mode, wikiRoot: state.wikiRoot, updatedAt: state.updatedAt };
  } catch {
    return undefined;
  }
}

function isValidSnapshot(location: WikiLocation, mode: unknown, wikiRoot: unknown, updatedAt: unknown): mode is "code" | "personal" {
  return mode === location.mode && wikiRoot === location.wikiRoot && typeof updatedAt === "string" && !Number.isNaN(Date.parse(updatedAt));
}

function renderContext(snapshot: WikiSnapshot): string {
  const freshness = Date.now() - Date.parse(snapshot.updatedAt) > FRESH_MS ? "stale" : "fresh";
  const suffix = `; updatedAt=${snapshot.updatedAt}; freshness=${freshness}`;
  const prefix = `OpenWiki mode=${snapshot.mode}; wikiRoot=`;
  const available = MAX_CONTEXT_CHARS - prefix.length - suffix.length;
  const wikiRoot = available > 3 && snapshot.wikiRoot.length > available
    ? `${snapshot.wikiRoot.slice(0, available - 3)}...`
    : snapshot.wikiRoot;
  return `${prefix}${wikiRoot}${suffix}`.slice(0, MAX_CONTEXT_CHARS);
}

await main();
