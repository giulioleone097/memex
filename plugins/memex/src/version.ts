import { readFileSync } from "node:fs";

interface PackageMetadata {
  version?: unknown;
}

function readPackageVersion(): string {
  const packageUrl = new URL("../package.json", import.meta.url);
  const parsed: unknown = JSON.parse(readFileSync(packageUrl, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Memex package metadata must be an object.");
  }
  const { version } = parsed as PackageMetadata;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("Memex package version must be a non-empty string.");
  }
  return version;
}

export const MEMEX_VERSION = readPackageVersion();
