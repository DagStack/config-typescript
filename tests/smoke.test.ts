import { describe, expect, it } from "vitest";

import { VERSION } from "../src/index.js";

describe("@dagstack/config — smoke", () => {
  it("exports VERSION string", () => {
    expect(typeof VERSION).toBe("string");
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
