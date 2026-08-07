import type {
  RequirementPriority,
  SchedulingEmployee,
} from "./types.js";

export const UNFILLED_PENALTY: Record<RequirementPriority, number> = {
  LOW: 500,
  NORMAL: 1000,
  HIGH: 5000,
  CRITICAL: 10000,
};

export const PREFERRED_OVERTIME_PENALTY_PER_MINUTE = 2;
export const WORKLOAD_IMBALANCE_MINUTES_PER_PENALTY_POINT = 10;

export function preferredOvertimePenalty(
  employee: SchedulingEmployee,
  previousMinutes: number,
  nextMinutes: number,
) {
  const previousOvertime = Math.max(
    0,
    previousMinutes - employee.preferredWeeklyMinutes,
  );
  const nextOvertime = Math.max(
    0,
    nextMinutes - employee.preferredWeeklyMinutes,
  );

  return (nextOvertime - previousOvertime)
    * PREFERRED_OVERTIME_PENALTY_PER_MINUTE;
}

export function workloadImbalancePenalty(
  employees: SchedulingEmployee[],
  weeklyMinutesByEmployee: ReadonlyMap<number, number>,
) {
  if (employees.length < 2) {
    return 0;
  }

  const workloads = employees.map((employee) =>
    weeklyMinutesByEmployee.get(employee.id) ?? 0,
  );

  return Math.round(
    (Math.max(...workloads) - Math.min(...workloads))
      / WORKLOAD_IMBALANCE_MINUTES_PER_PENALTY_POINT,
  );
}
