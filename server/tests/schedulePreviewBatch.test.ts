import { describe, expect, it, vi } from "vitest";
import {
  buildSchedulePreview,
  buildSchedulePreviews,
} from "../src/scheduling/schedulePreview.js";

function database() {
  const employees = [{
    id: 1,
    name: "Anna",
    email: "anna@example.com",
    role: "Engineer",
    preferredWeeklyMinutes: 2_400,
    maxWeeklyMinutes: 2_400,
    hourlyCostCents: 5_000,
    overtimeRateBasisPoints: 15_000,
    archivedAt: null,
    archiveReason: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    skills: [{ employeeId: 1, skillId: 1, level: 5 }],
    availability: [{
      id: 1,
      employeeId: 1,
      dayOfWeek: "MONDAY",
      startMinute: 9 * 60,
      endMinute: 17 * 60,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    }],
  }];
  const requirements = [{
    id: 10,
    projectId: 1,
    dayOfWeek: "MONDAY",
    startMinute: 9 * 60,
    endMinute: 17 * 60,
    requiredEmployees: 1,
    requiredSkillId: 1,
    minimumSkillLevel: 3,
    priority: "HIGH",
    activeFrom: null,
    activeUntil: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
  }];
  return {
    employee: { findMany: vi.fn().mockResolvedValue(employees) },
    projectRequirement: { findMany: vi.fn().mockResolvedValue(requirements) },
    shift: { findMany: vi.fn().mockResolvedValue([]) },
  } as never;
}

describe("batched schedule previews", () => {
  it("matches sequential previews with one snapshot read", async () => {
    const weekStarts = ["2026-08-10", "2026-08-17"];
    const batchedDatabase = database();
    const sequentialDatabase = database();

    const batched = await buildSchedulePreviews(
      batchedDatabase,
      weekStarts,
      true,
    );
    const sequential = await Promise.all(weekStarts.map((weekStart) =>
      buildSchedulePreview(sequentialDatabase, weekStart, true),
    ));

    expect(batched).toEqual(sequential);
    expect(batchedDatabase.employee.findMany).toHaveBeenCalledTimes(1);
    expect(batchedDatabase.projectRequirement.findMany).toHaveBeenCalledTimes(1);
    expect(batchedDatabase.shift.findMany).toHaveBeenCalledTimes(1);
    expect(sequentialDatabase.employee.findMany).toHaveBeenCalledTimes(2);
    expect(sequentialDatabase.projectRequirement.findMany).toHaveBeenCalledTimes(2);
    expect(sequentialDatabase.shift.findMany).toHaveBeenCalledTimes(2);
  });
});
