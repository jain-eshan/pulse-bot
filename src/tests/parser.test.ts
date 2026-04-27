import { describe, it, expect } from "vitest";
import { looksLikeSessionAnnouncement } from "../lib/parser.js";

describe("looksLikeSessionAnnouncement", () => {
  it("accepts strong announcement with time + venue + action", () => {
    expect(
      looksLikeSessionAnnouncement("FADM P2P tonight 9PM LT3 — all welcome, bring notes from chapter 3")
    ).toBe(true);
  });

  it("accepts message with only time + venue", () => {
    expect(
      looksLikeSessionAnnouncement("Pranayama session tomorrow morning at the atrium starting 7am sharp, bring your mat")
    ).toBe(true);
  });

  it("rejects short message", () => {
    expect(looksLikeSessionAnnouncement("9pm LT3 join")).toBe(false);
  });

  it("rejects casual chat with no event signals", () => {
    expect(
      looksLikeSessionAnnouncement("hey what's up everyone, anyone seen my notebook from yesterday lectures?")
    ).toBe(false);
  });

  it("rejects question messages with only one signal", () => {
    expect(
      looksLikeSessionAnnouncement("anyone going to LT3 right now? need to grab notes from someone please")
    ).toBe(false);
  });

  it("accepts venue + action message", () => {
    expect(
      looksLikeSessionAnnouncement("Hosting an open mic at the atrium, all welcome to come and perform or just chill")
    ).toBe(true);
  });

  it("rejects very long text (>2000 chars)", () => {
    const long = "session at 5pm in LT1 ".repeat(200);
    expect(looksLikeSessionAnnouncement(long)).toBe(false);
  });
});
