import { expect, test } from "vitest";
import { NAME } from "../src/index.js";
test("package identity", () => { expect(NAME).toBe("obsbot-mcp"); });
