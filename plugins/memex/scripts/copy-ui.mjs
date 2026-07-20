#!/usr/bin/env node
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(pluginRoot, "src/ui/memex-dashboard.html");
const destination = resolve(pluginRoot, "dist/ui/memex-dashboard.html");

mkdirSync(dirname(destination), { recursive: true });
copyFileSync(source, destination);
