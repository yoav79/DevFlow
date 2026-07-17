import { describe, expect, it } from "vitest";
import { TASK_STATES } from "../src/types.js";

describe("DevFlow test infrastructure", () => {
  it("loads TypeScript ESM modules", () => {
    expect(Array.isArray(TASK_STATES)).toBe(true);
    expect(TASK_STATES).toContain("CREATED");
    expect(TASK_STATES).toContain("COMPLETED");
    expect(TASK_STATES).toHaveLength(16);
  });
});
