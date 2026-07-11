#!/usr/bin/env node
import { runLifecycleCli } from "./install.mjs";

process.exitCode = await runLifecycleCli("uninstall");
