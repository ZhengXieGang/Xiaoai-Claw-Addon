import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configureScript = join(
  repositoryRoot,
  "scripts",
  "configure-openclaw-install.mjs",
);
const pluginId = "openclaw-plugin-xiaoai-cloud";

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function makeFixture(name) {
  const root = mkdtempSync(join(tmpdir(), `xiaoai-agent-${name}-`));
  const packageDir = join(root, "openclaw-pkg");
  const configFile = join(root, "openclaw.json");
  const agentsFile = join(root, "agents.json");
  const traceFile = join(root, "openclaw.trace");
  const addFile = join(root, "agents-add.txt");
  const openclawBin = join(root, "openclaw");
  mkdirSync(packageDir, { recursive: true });
  writeJson(join(packageDir, "package.json"), { name: "openclaw" });
  writeFileSync(
    openclawBin,
    `#!/bin/sh
set -u
printf '%s\\n' "$*" >> "$XIAOAI_TRACE_FILE"
case "$1:$2" in
  config:file)
    printf '%s\\n' "$XIAOAI_CONFIG_FILE"
    ;;
  agents:list)
    cat "$XIAOAI_AGENTS_FILE"
    ;;
  agents:add)
    printf '%s\\n' "$*" > "$XIAOAI_ADD_FILE"
    ;;
esac
exit 0
`,
    "utf8",
  );
  chmodSync(openclawBin, 0o755);
  return { root, packageDir, configFile, agentsFile, traceFile, addFile, openclawBin };
}

function runConfigure(fixture, extraArgs, config, agents) {
  writeJson(fixture.configFile, config);
  writeJson(fixture.agentsFile, agents);
  const result = spawnSync(
    process.execPath,
    [
      configureScript,
      "--openclaw-bin",
      fixture.openclawBin,
      "--openclaw-package-dir",
      fixture.packageDir,
      "--log-file",
      join(fixture.root, "configure.log"),
      ...extraArgs,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        XIAOAI_CONFIG_FILE: fixture.configFile,
        XIAOAI_AGENTS_FILE: fixture.agentsFile,
        XIAOAI_TRACE_FILE: fixture.traceFile,
        XIAOAI_ADD_FILE: fixture.addFile,
      },
    },
  );
  assert.equal(
    result.status,
    0,
    `configure failed\nstdout=${result.stdout}\nstderr=${result.stderr}`,
  );
  const summary = JSON.parse(result.stdout);
  const written = JSON.parse(readFileSync(fixture.configFile, "utf8"));
  const trace = readFileSync(fixture.traceFile, "utf8");
  return { summary, written, trace, fixture };
}

function baseConfig(agentList) {
  return {
    agents: {
      defaults: {
        workspace: "/tmp/xiaoai-main-workspace",
        model: "openai/gpt-test",
      },
      list: agentList,
    },
    plugins: {
      allow: [pluginId],
      entries: {
        [pluginId]: {
          enabled: true,
          config: {
            openclawAgent: "xiaoai",
            openclawChannel: "telegram",
          },
        },
      },
    },
  };
}

const mainAgent = {
  id: "main",
  default: true,
  workspace: "/tmp/xiaoai-main-workspace",
  model: "openai/gpt-test",
};
const existingXiaoai = {
  id: "xiaoai",
  default: false,
  workspace: "/tmp/xiaoai-custom-workspace",
  model: "openai/gpt-test",
  tools: {
    profile: "coding",
    allow: ["xiaoai_speak", "custom_tool"],
  },
};

const omitted = runConfigure(
  makeFixture("omit"),
  [],
  baseConfig([mainAgent, existingXiaoai]),
  [mainAgent, existingXiaoai],
);
const omittedAgents = omitted.written.agents.list;
const omittedXiaoai = omittedAgents.find((agent) => agent.id === "xiaoai");
const omittedMain = omittedAgents.find((agent) => agent.id === "main");
assert.equal(omitted.summary.agentId, "xiaoai");
assert.equal(omitted.summary.createdAgent, false);
assert.equal(omittedXiaoai.default, false);
assert.equal(omittedMain.default, true);
assert.equal(omittedAgents.filter((agent) => agent.default === true).length, 1);
assert.equal(omittedXiaoai.workspace, "/tmp/xiaoai-custom-workspace");
assert.equal(omitted.summary.workspace, "/tmp/xiaoai-custom-workspace");
assert.equal(omittedXiaoai.tools.profile, "minimal");
assert.equal(omitted.trace.includes("agents add"), false);

const reusable = {
  id: "speaker",
  default: true,
  workspace: "/tmp/keep-speaker-workspace",
  model: "openai/keep-model",
  tools: {
    profile: "full",
    allow: ["custom_tool"],
  },
};
const reused = runConfigure(
  makeFixture("reuse"),
  ["--agent", "speaker"],
  baseConfig([reusable]),
  [reusable],
);
const reusedAgents = reused.written.agents.list;
const reusedSpeaker = reusedAgents.find((agent) => agent.id === "speaker");
assert.equal(reused.summary.agentId, "speaker");
assert.equal(reused.summary.createdAgent, false);
assert.equal(reused.summary.workspace, "/tmp/keep-speaker-workspace");
assert.equal(reusedSpeaker.workspace, "/tmp/keep-speaker-workspace");
assert.equal(reusedSpeaker.default, true);
assert.equal(reusedSpeaker.tools.profile, "full");
assert.deepEqual(reusedSpeaker.tools.allow, ["custom_tool"]);
assert.equal(reusedAgents.some((agent) => agent.id === "main"), false);
assert.equal(reused.written.plugins.entries[pluginId].config.openclawAgent, "speaker");
assert.equal(reused.trace.includes("agents add"), false);

const created = runConfigure(
  makeFixture("create"),
  ["--agent", "newagent"],
  baseConfig([mainAgent]),
  [mainAgent],
);
const createdAgents = created.written.agents.list;
const createdAgent = createdAgents.find((agent) => agent.id === "newagent");
const createdMain = createdAgents.find((agent) => agent.id === "main");
assert.equal(created.summary.agentId, "newagent");
assert.equal(created.summary.createdAgent, true);
assert.equal(created.summary.workspace, createdAgent.workspace);
assert.equal(createdAgent.workspace.endsWith("xiaoai-main-workspace-newagent"), true);
assert.equal(createdAgent.default, false);
assert.equal(createdMain.default, true);
assert.equal(createdAgents.filter((agent) => agent.default === true).length, 1);
assert.equal(createdAgent.tools.profile, "minimal");
assert.equal(created.trace.includes("agents add newagent"), true);

console.log("Configure agent selection passed.");
