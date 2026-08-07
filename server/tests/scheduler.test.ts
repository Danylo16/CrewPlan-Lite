import { describe, expect, it } from "vitest";
import { generateSchedule } from "../src/scheduling/generateSchedule.js";
import type {
  SchedulingEmployee,
  SchedulingInput,
  SchedulingRequirement,
} from "../src/scheduling/types.js";

function employee(
  id: number,
  overrides: Partial<SchedulingEmployee> = {},
): SchedulingEmployee {
  return {
    id,
    preferredWeeklyMinutes: 2400,
    maxWeeklyMinutes: 2400,
    skills: [{ skillId: 1, level: 3 }],
    availability: [{
      dayOfWeek: "MONDAY",
      startMinute: 540,
      endMinute: 1020,
    }],
    ...overrides,
  };
}

function requirement(
  id: number,
  overrides: Partial<SchedulingRequirement> = {},
): SchedulingRequirement {
  return {
    id,
    projectId: id,
    dayOfWeek: "MONDAY",
    startMinute: 540,
    endMinute: 1020,
    requiredEmployees: 1,
    requiredSkillId: 1,
    minimumSkillLevel: 3,
    priority: "NORMAL",
    ...overrides,
  };
}

function input(overrides: Partial<SchedulingInput> = {}): SchedulingInput {
  return {
    employees: [employee(1)],
    requirements: [requirement(1)],
    existingShifts: [],
    ...overrides,
  };
}

describe("scheduling engine", () => {
  it("creates a fully covered schedule", () => {
    const result = generateSchedule(input());

    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0]?.employeeId).toBe(1);
    expect(result.metrics.coveragePercent).toBe(100);
    expect(result.metrics.hardConflicts).toBe(0);
  });

  it("reports an unavailable employee", () => {
    const result = generateSchedule(input({
      employees: [employee(1, { availability: [] })],
    }));

    expect(result.assignments).toHaveLength(0);
    expect(result.unfilledPositions[0]?.rejectionCounts.NOT_AVAILABLE).toBe(1);
  });

  it("reports a missing required skill", () => {
    const result = generateSchedule(input({
      employees: [employee(1, { skills: [{ skillId: 1, level: 2 }] })],
    }));

    expect(result.unfilledPositions[0]?.rejectionCounts.MISSING_SKILL).toBe(1);
  });

  it("does not overlap an existing shift", () => {
    const result = generateSchedule(input({
      existingShifts: [{
        employeeId: 1,
        projectId: 99,
        dayOfWeek: "MONDAY",
        startMinute: 600,
        endMinute: 720,
      }],
    }));

    expect(result.assignments).toHaveLength(0);
    expect(result.unfilledPositions[0]?.rejectionCounts.OVERLAP).toBe(1);
  });

  it("respects the maximum weekly minutes", () => {
    const result = generateSchedule(input({
      employees: [employee(1, { maxWeeklyMinutes: 600 })],
      existingShifts: [{
        employeeId: 1,
        projectId: 99,
        dayOfWeek: "TUESDAY",
        startMinute: 540,
        endMinute: 780,
      }],
    }));

    expect(result.assignments).toHaveLength(0);
    expect(result.unfilledPositions[0]?.rejectionCounts.WEEKLY_LIMIT).toBe(1);
  });

  it("fills a critical requirement before a low-priority conflict", () => {
    const result = generateSchedule(input({
      requirements: [
        requirement(1, { priority: "LOW" }),
        requirement(2, { priority: "CRITICAL" }),
      ],
    }));

    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0]?.requirementId).toBe(2);
    expect(result.unfilledPositions[0]?.requirementId).toBe(1);
  });

  it("distributes compatible work between employees", () => {
    const result = generateSchedule(input({
      employees: [employee(1), employee(2)],
      requirements: [
        requirement(1, { startMinute: 540, endMinute: 780 }),
        requirement(2, { startMinute: 780, endMinute: 1020 }),
      ],
    }));

    expect(new Set(result.assignments.map((item) => item.employeeId)).size).toBe(2);
  });

  it("returns a stable result for identical input", () => {
    const schedulingInput = input({
      employees: [employee(2), employee(1)],
      requirements: [
        requirement(2, { startMinute: 780, endMinute: 1020 }),
        requirement(1, { startMinute: 540, endMinute: 780 }),
      ],
    });

    expect(generateSchedule(schedulingInput)).toEqual(generateSchedule(schedulingInput));
  });

  it("does not mutate its input", () => {
    const schedulingInput = input();
    const before = structuredClone(schedulingInput);

    generateSchedule(schedulingInput);

    expect(schedulingInput).toEqual(before);
  });

  it("reports when the configured search limit is reached", () => {
    const result = generateSchedule(input({
      employees: [employee(1), employee(2)],
      requirements: [requirement(1)],
      maxSearchNodes: 1,
    }));

    expect(result.metrics.searchLimitReached).toBe(true);
    expect(result.assignments.length).toBeGreaterThan(0);
  });
});
