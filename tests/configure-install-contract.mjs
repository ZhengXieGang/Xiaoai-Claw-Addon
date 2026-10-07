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
assert.match(
  configureInstaller,
  /agentIdExplicit/u,
  "configure must honor an explicit --agent instead of a previously saved agent",
);
assert.match(
  configureInstaller,
  /reuseExistingAgent/u,
  "configure must reuse an existing agent selected by --agent",
);
assert.match(
  readFileSync(join(repositoryRoot, "installers", "install.sh"), "utf8"),
  /--agent "\$AGENT_ID"/u,
  "install.sh must forward --agent to the configure step",
);
assert.match(
  readFileSync(join(repositoryRoot, "installers", "install.cmd"), "utf8"),
  /--agent ""%AGENT_ID%""/u,
  "install.cmd must forward --agent to the configure step",
);

console.log("Configure install contract passed (host dependency isolation).");
