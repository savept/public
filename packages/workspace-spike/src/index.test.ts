import { describe, expect, it } from "vitest";
import { workspaceVisibility } from "./index.js";

describe("@savept/workspace-spike", () => {
  it("identifies itself as public workspace code", () => {
    expect(workspaceVisibility).toBe("public");
  });
});
