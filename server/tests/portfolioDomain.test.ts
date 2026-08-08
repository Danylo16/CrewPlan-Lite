import { describe, expect, it } from "vitest";
import {
  canTransitionProject,
  costForMinutes,
  durationMinutes,
} from "../src/domain/portfolio.js";

describe("portfolio domain", () => {
  it("allows only explicit project lifecycle transitions", () => {
    expect(canTransitionProject("DRAFT", "PLANNED")).toBe(true);
    expect(canTransitionProject("ACTIVE", "ON_HOLD")).toBe(true);
    expect(canTransitionProject("ACTIVE", "ARCHIVED")).toBe(false);
    expect(canTransitionProject("ARCHIVED", "ACTIVE")).toBe(false);
  });

  it("calculates actual duration and cost in integer minutes and cents", () => {
    const startedAt = new Date("2026-08-10T07:00:00.000Z");
    const endedAt = new Date("2026-08-10T08:30:00.000Z");
    expect(durationMinutes(startedAt, endedAt)).toBe(90);
    expect(costForMinutes(4_200, 90)).toBe(6_300);
  });
});
