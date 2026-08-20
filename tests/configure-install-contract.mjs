import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configureInstaller = readFileSync(
  join(repositoryRoot, "scripts", "configure-openclaw-install.mjs"),
  "utf8",
);

assert.match(
  configureInstaller,
  /function resolveOpenclawHostRuntime\(options\)/u,
  "the configure helper must resolve the host package for workspace templates",
);
assert.doesNotMatch(
  configureInstaller,
  /HOST_RUNTIME_DEPENDENCIES|npmCommand|installResult/u,
  "the plugin installer must not mutate the OpenClaw host dependency tree",
);
assert.doesNotMatch(
  configureInstaller,
  /@aws-sdk\/client-bedrock|@slack\/web-api|grammy/u,
  "host channel dependencies must not be bundled into XiaoAi installation",
);

console.log("Configure install contract passed (host dependency isolation).");
