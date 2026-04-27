import { describe, it, expect, vi, beforeEach } from "vitest";
import { hashCode, verifyLinkCode } from "../lib/linkVerify.js";

// Mock supabase so tests don't hit the real DB
vi.mock("../lib/supabase.js", () => {
  const builder = () => ({
    select: () => builder(),
    eq: () => builder(),
    update: () => builder(),
    single: () => Promise.resolve({ data: null }),
    then: (cb: any) => Promise.resolve({ data: null }).then(cb),
  });
  return { supabase: { from: () => builder() } };
});

describe("hashCode", () => {
  it("produces a consistent SHA256 hex string", () => {
    const h = hashCode("123456");
    expect(h).toHaveLength(64);
    expect(h).toMatch(/^[0-9a-f]+$/);
  });

  it("trims whitespace before hashing", () => {
    expect(hashCode("123456")).toBe(hashCode("  123456  "));
  });

  it("produces different hashes for different codes", () => {
    expect(hashCode("123456")).not.toBe(hashCode("654321"));
  });
});

describe("verifyLinkCode", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns not-ok when no record found", async () => {
    const result = await verifyLinkCode("000000", "+911234567890");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not recognised/i);
  });
});
