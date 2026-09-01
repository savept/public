import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import { block } from "./errors.mjs";
import { validatePolicy } from "./policy.mjs";
import { commandEvidence, parseToolVersions } from "./toolchain.mjs";
import { collectFiles, discoverWorkspace } from "./workspace.mjs";

function parseRootArgument(argv) {
  if (argv.length === 0) return process.cwd();
  if (argv.length === 2 && argv[0] === "--root" && argv[1])
    return path.resolve(argv[1]);
  block("usage: node tools/policy/validate.mjs [--root <repository-root>]");
}

export function runCli(argv = process.argv.slice(2)) {
  let realRoot;
  try {
    realRoot = realpathSync(parseRootArgument(argv));
  } catch (error) {
    block(`repository root cannot be resolved: ${error.message}`);
  }
  let toolVersionsText;
  try {
    toolVersionsText = readFileSync(
      path.join(realRoot, ".tool-versions"),
      "utf8",
    );
  } catch (error) {
    block(`tool versions cannot be read: ${error.message}`);
  }
  const versions = parseToolVersions(toolVersionsText);
  const workspaceRecords = discoverWorkspace(realRoot);
  validatePolicy({
    root: realRoot,
    toolVersionsText,
    toolchain: {
      processNode: process.version,
      asdfCurrentNode: commandEvidence("asdf", ["current", "nodejs"], realRoot),
      asdfCurrentPnpm: commandEvidence("asdf", ["current", "pnpm"], realRoot),
      asdfExecNode: commandEvidence(
        "asdf",
        ["exec", "node", "--version"],
        realRoot,
      ),
      asdfExecPnpm: commandEvidence(
        "asdf",
        ["exec", "pnpm", "--version"],
        realRoot,
      ),
      expectedNode: versions.nodejs,
      expectedPnpm: versions.pnpm,
    },
    workspaceRecords,
    files: collectFiles(realRoot),
  });
  process.stdout.write(
    `WORKSPACE_POLICY_PASSED: workspace policy passed for ${workspaceRecords.length} workspace packages\n`,
  );
}
