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

export interface AllocationCostBreakdown {
  regularMinutes: number;
  overtimeMinutes: number;
  regularCostCents: number;
  overtimeCostCents: number;
  totalCostCents: number;
}

export function allocationCostBreakdown(
  employee: Pick<
    SchedulingEmployee,
    | "hourlyCostCents"
    | "overtimeRateBasisPoints"
    | "preferredWeeklyMinutes"
  >,
  previousMinutes: number,
  addedMinutes: number,
): AllocationCostBreakdown {
  const regularMinutes = Math.max(
    0,
    Math.min(
      addedMinutes,
      employee.preferredWeeklyMinutes - previousMinutes,
    ),
  );
  const overtimeMinutes = addedMinutes - regularMinutes;
  const regularCostCents = Math.round(
    (employee.hourlyCostCents * regularMinutes) / 60,
  );
  const overtimeCostCents = Math.round(
    (employee.hourlyCostCents
      * overtimeMinutes
      * employee.overtimeRateBasisPoints)
      / 600_000,
  );

  return {
    regularMinutes,
    overtimeMinutes,
    regularCostCents,
    overtimeCostCents,
    totalCostCents: regularCostCents + overtimeCostCents,
  };
}

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
