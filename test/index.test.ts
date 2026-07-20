import { describe, test, expect } from "bun:test";

// ---------------------------------------------------------------------------
// Export shape — OpenCode v1.17+ loader iterates Object.values(mod) and
// calls each function-valued export as a plugin. Only DoomLoopGuard and
// default may be present.
// ---------------------------------------------------------------------------

describe("plugin export shape", () => {
  test("only DoomLoopGuard and default are runtime exports", async () => {
    const mod = await import("../src/index.ts");

    // Collect runtime-observable values (types/interfaces are erased)
    const runtimeExports: string[] = [];
    for (const [key, val] of Object.entries(mod)) {
      if (key === "__esModule") continue; // bundler artifact
      if (typeof val === "function" || typeof val === "object") {
        runtimeExports.push(key);
      }
    }

    // DoomLoopGuard (named) + default (re-export of DoomLoopGuard)
    expect(runtimeExports.sort()).toEqual(["DoomLoopGuard", "default"]);

    // Verify DoomLoopGuard is a function (async)
    expect(typeof mod.DoomLoopGuard).toBe("function");

    // Verify default is the same reference
    expect(mod.default).toBe(mod.DoomLoopGuard);
  });
});
