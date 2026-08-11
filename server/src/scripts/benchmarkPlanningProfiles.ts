import { performance } from "node:perf_hooks";
import { DateTime } from "luxon";
import {
  allocatePortfolioScenarioPlans,
  allocatePortfolioWork,
} from "../planning/portfolioPlacementOptimizer.js";
import type {
  OptimizerEmployee,
  OptimizerProject,
  PlanningProfile,
  PortfolioOptimizerInput,
} from "../planning/portfolioOptimizer.js";
import { SCHEDULE_TIME_ZONE } from "../scheduling/timeAdapter.js";

const profiles: PlanningProfile[] = [
  "BALANCED",
  "COST_FIRST",
  "DEADLINE_FIRST",
  "RESILIENCE_FIRST",
];
const weekdays = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"];

function employee(
  id: number,
  name: string,
  hourlyCostCents: number,
  days = weekdays,
  maxWeeklyMinutes = 960,
): OptimizerEmployee {
  return {
    id,
    name,
    hourlyCostCents,
    overtimeRateBasisPoints: 15_000,
    preferredWeeklyMinutes: maxWeeklyMinutes,
    maxWeeklyMinutes,
    skills: [{ skillId: 1, level: 5 }],
    availability: days.map((dayOfWeek) => ({
      dayOfWeek,
      startMinute: 9 * 60,
      endMinute: 17 * 60,
    })),
  };
}

function benchmarkInput(
  planningProfile: PlanningProfile,
  scenario: "COST_VS_DEADLINE" | "COST_VS_RESILIENCE",
): PortfolioOptimizerInput {
  const deadline = new Date("2026-08-10T00:00:00.000Z");
  const project: OptimizerProject = {
    id: 1,
    name: "Planning profile benchmark",
    priority: "HIGH",
    optimizationStrategy: "BALANCED",
    startDate: deadline,
    targetEndDate: scenario === "COST_VS_DEADLINE" ? deadline : null,
    deadlineType: scenario === "COST_VS_DEADLINE" ? "SOFT" : "NONE",
    workPackages: [{
      id: 10,
      name: "Release scope",
      remainingMinutes: scenario === "COST_VS_DEADLINE" ? 480 : 960,
      requiredSkillId: 1,
      minimumSkillLevel: 3,
      maxParallelEmployees: 1,
      sortOrder: 0,
      earliestStartDate: null,
      targetEndDate: scenario === "COST_VS_DEADLINE" ? deadline : null,
      incomingDependencies: [],
    }],
  };
  return {
    start: DateTime.fromISO("2026-08-10", { zone: SCHEDULE_TIME_ZONE }),
    end: DateTime.fromISO("2026-08-17", { zone: SCHEDULE_TIME_ZONE }),
    employees: scenario === "COST_VS_DEADLINE" ? [
      employee(1, "Expensive early", 8_000, ["MONDAY"], 480),
      employee(2, "Cheap after deadline", 3_000, ["TUESDAY", "WEDNESDAY"], 480),
    ] : [
      employee(1, "Cheap primary", 3_000, weekdays, 960),
      employee(2, "Backup A", 5_000, weekdays, 480),
      employee(3, "Backup B", 5_000, weekdays, 480),
    ],
    projects: [project],
    occupiedIntervals: [],
    futurePlannedByPackage: new Map(),
    futurePlannedIntervalsByPackage: new Map(),
    planningProfile,
  };
}

const scenarios = ["COST_VS_DEADLINE", "COST_VS_RESILIENCE"] as const;
const report = scenarios.flatMap((scenario) => profiles.map((planningProfile) => {
  const startedAt = performance.now();
  const result = allocatePortfolioWork(benchmarkInput(planningProfile, scenario));
  const employeeIds = [...new Set(result.assignments.map((assignment) => assignment.employeeId))];
  return {
    scenario,
    profile: planningProfile,
    plannedMin: result.optimizerDiagnostics.optimized.plannedMinutes,
    costEuro: result.optimizerDiagnostics.optimized.laborCostCents / 100,
    deadlineExposureMin:
      result.optimizerDiagnostics.objectiveVector.softDeadlineExposureMinutes,
    concentrationBps:
      result.optimizerDiagnostics.objectiveVector.skillConcentrationBasisPoints,
    employees: employeeIds.join(","),
    runtimeMs: Math.round((performance.now() - startedAt) * 100) / 100,
    deterministic: result.optimizerDiagnostics.searchLimitReached === false,
  };
}));

for (const scenario of scenarios) {
  const outcomes = report.filter((item) => item.scenario === scenario);
  if (new Set(outcomes.map((item) =>
    `${item.costEuro}:${item.deadlineExposureMin}:${item.concentrationBps}:${item.employees}`))
    .size < 2) {
    throw new Error(`${scenario}: planning profiles collapsed to the same outcome`);
  }
}

const byKey = new Map(report.map((item) => [`${item.scenario}:${item.profile}`, item]));
const costTradeoff = byKey.get("COST_VS_DEADLINE:COST_FIRST")!;
const deadlineTradeoff = byKey.get("COST_VS_DEADLINE:DEADLINE_FIRST")!;
if (
  costTradeoff.costEuro >= deadlineTradeoff.costEuro
  || costTradeoff.deadlineExposureMin <= deadlineTradeoff.deadlineExposureMin
) throw new Error("Cost/deadline profiles did not expose the expected trade-off");
const cheapConcentrated = byKey.get("COST_VS_RESILIENCE:COST_FIRST")!;
const resilient = byKey.get("COST_VS_RESILIENCE:RESILIENCE_FIRST")!;
if (
  resilient.concentrationBps >= cheapConcentrated.concentrationBps
  || resilient.costEuro <= cheapConcentrated.costEuro
) throw new Error("Resilience profile did not pay for lower concentration risk");

const sharedReport = scenarios.flatMap((scenario) => {
  const startedAt = performance.now();
  const results = allocatePortfolioScenarioPlans(
    benchmarkInput("BALANCED", scenario),
    profiles,
  );
  const runtimeMs = Math.round((performance.now() - startedAt) * 100) / 100;
  return profiles.map((profile) => {
    const result = results.get(profile)!;
    return {
      scenario,
      profile,
      costEuro: result.optimizerDiagnostics.optimized.laborCostCents / 100,
      deadlineExposureMin:
        result.optimizerDiagnostics.objectiveVector.softDeadlineExposureMinutes,
      concentrationBps:
        result.optimizerDiagnostics.objectiveVector.skillConcentrationBasisPoints,
      runtimeMs,
      candidates: result.optimizerDiagnostics.evaluatedPlans,
    };
  });
});
const sharedByKey = new Map(
  sharedReport.map((item) => [`${item.scenario}:${item.profile}`, item]),
);
if (
  sharedByKey.get("COST_VS_DEADLINE:COST_FIRST")!.costEuro
    >= sharedByKey.get("COST_VS_DEADLINE:DEADLINE_FIRST")!.costEuro
  || sharedByKey.get("COST_VS_DEADLINE:COST_FIRST")!.deadlineExposureMin
    <= sharedByKey.get("COST_VS_DEADLINE:DEADLINE_FIRST")!.deadlineExposureMin
) throw new Error("Shared Pareto search lost the cost/deadline trade-off");
if (
  sharedByKey.get("COST_VS_RESILIENCE:RESILIENCE_FIRST")!.concentrationBps
    >= sharedByKey.get("COST_VS_RESILIENCE:COST_FIRST")!.concentrationBps
  || sharedByKey.get("COST_VS_RESILIENCE:RESILIENCE_FIRST")!.costEuro
    <= sharedByKey.get("COST_VS_RESILIENCE:COST_FIRST")!.costEuro
) throw new Error("Shared Pareto search lost the cost/resilience trade-off");

if (process.argv.includes("--json")) console.log(JSON.stringify({ report, sharedReport }, null, 2));
else {
  console.table(report);
  console.log("Shared Pareto frontier");
  console.table(sharedReport);
}
