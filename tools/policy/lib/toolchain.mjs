import { spawnSync } from "node:child_process";

import { block } from "./errors.mjs";

function version(value, label) {
  const normalized = String(value).trim().replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(normalized))
    block(`malformed ${label} tool version`);
  return normalized;
}

export function parseToolVersions(text) {
  const found = { nodejs: [], pnpm: [] };
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const fields = line.split(/\s+/);
    if (fields[0] !== "nodejs" && fields[0] !== "pnpm") continue;
    if (fields.length !== 2) block(`malformed ${fields[0]} tool version entry`);
    found[fields[0]].push(version(fields[1], fields[0]));
  }
  for (const tool of ["nodejs", "pnpm"]) {
    if (found[tool].length !== 1)
      block(`expected exactly one ${tool} tool version entry`);
  }
  return { nodejs: found.nodejs[0], pnpm: found.pnpm[0] };
}

function commandVersion(value, label, toolName) {
  if (value instanceof Error)
    block(`toolchain ${label} failed: ${value.message}`);
  const text = String(value).trim();
  if (label.startsWith("asdf current")) {
    const lines = text
      .split(/\r?\n/)
      .map((candidate) => candidate.trim())
      .filter((candidate) => candidate.split(/\s+/)[0] === toolName);
    if (lines.length !== 1)
      block(`toolchain ${label} must report exactly one ${toolName} entry`);
    return version(lines[0].split(/\s+/)[1], label);
  }
  return version(text, label);
}

export function checkToolchain({
  expectedNode,
  expectedPnpm,
  processNode,
  asdfCurrentNode,
  asdfCurrentPnpm,
  asdfExecNode,
  asdfExecPnpm,
}) {
  const node = version(expectedNode, "expected nodejs");
  const pnpm = version(expectedPnpm, "expected pnpm");
  const evidence = [
    [
      "process.version",
      commandVersion(processNode, "process.version", "nodejs"),
      node,
    ],
    [
      "asdf current nodejs",
      commandVersion(asdfCurrentNode, "asdf current nodejs", "nodejs"),
      node,
    ],
    [
      "asdf current pnpm",
      commandVersion(asdfCurrentPnpm, "asdf current pnpm", "pnpm"),
      pnpm,
    ],
    [
      "asdf exec node --version",
      commandVersion(asdfExecNode, "asdf exec node --version", "nodejs"),
      node,
    ],
    [
      "asdf exec pnpm --version",
      commandVersion(asdfExecPnpm, "asdf exec pnpm --version", "pnpm"),
      pnpm,
    ],
  ];
  for (const [label, actual, expected] of evidence) {
    if (actual !== expected)
      block(`toolchain ${label} reported ${actual}; expected ${expected}`);
  }
}

export function commandEvidence(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.error) return result.error;
  if (result.signal) return new Error(`terminated by signal ${result.signal}`);
  if (result.status !== 0) {
    return new Error(
      `exited with status ${String(result.status)}: ${String(result.stderr).trim()}`,
    );
  }
  if (!String(result.stdout).trim() && String(result.stderr).trim()) {
    return new Error(String(result.stderr).trim());
  }
  return result.stdout;
}
