import assert from "node:assert/strict";
import { test } from "node:test";

import { checkToolchain, parseToolVersions } from "../lib/toolchain.mjs";
import { assertBlocked, goodToolchain, toolVersions } from "./helpers.mjs";

test("parseToolVersions accepts one normalized nodejs and pnpm entry", () => {
  assert.deepEqual(parseToolVersions(" nodejs   v24.18.0 \n\tpnpm\t11.7.0\n"), {
    nodejs: "24.18.0",
    pnpm: "11.7.0",
  });
});

for (const [name, text] of [
  ["missing nodejs", "pnpm 11.7.0\n"],
  ["missing pnpm", "nodejs 24.18.0\n"],
  ["multiple nodejs", "nodejs 24.18.0\nnodejs 24.17.0\npnpm 11.7.0\n"],
  ["multiple pnpm", "nodejs 24.18.0\npnpm 11.7.0\npnpm 11.6.0\n"],
  ["malformed nodejs", "nodejs 24\npnpm 11.7.0\n"],
  ["malformed pnpm", "nodejs 24.18.0\npnpm latest\n"],
  ["extra tokens", "nodejs 24.18.0 unexpected\npnpm 11.7.0\n"],
]) {
  test(`parseToolVersions fails closed for ${name}`, () => {
    assertBlocked(() => parseToolVersions(text), /tool version/i);
  });
}

test("checkToolchain accepts matching injected evidence", () => {
  assert.doesNotThrow(() => checkToolchain(goodToolchain));
});

test("checkToolchain rejects duplicate asdf current evidence lines", () => {
  assertBlocked(
    () =>
      checkToolchain({
        ...goodToolchain,
        asdfCurrentNode:
          "nodejs 24.18.0 /repo/.tool-versions\nnodejs 24.18.0 /repo/.tool-versions",
      }),
    /asdf current nodejs/i,
  );
});

for (const key of [
  "processNode",
  "asdfCurrentNode",
  "asdfCurrentPnpm",
  "asdfExecNode",
  "asdfExecPnpm",
]) {
  test(`checkToolchain rejects mismatched ${key}`, () => {
    assertBlocked(
      () => checkToolchain({ ...goodToolchain, [key]: "0.0.0" }),
      /toolchain/i,
    );
  });

  test(`checkToolchain rejects command error injected at ${key}`, () => {
    assertBlocked(
      () =>
        checkToolchain({
          ...goodToolchain,
          [key]: new Error("command unavailable"),
        }),
      /toolchain/i,
    );
  });
}
