import { Router, type Response } from "express";
import { z } from "zod";
import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import {
  buildPortfolioPlanPreview,
  buildPortfolioScenarioComparison,
} from "../planning/portfolioPlan.js";
import { buildPortfolioResilienceReport } from "../planning/portfolioResilience.js";
import { getWeekWindowUtc, parseWeekStart } from "../scheduling/timeAdapter.js";
import {
  preventDecisionCaching,
  recordServerTiming,
  type ServerTimingMetric,
} from "../lib/httpObservability.js";

export const portfolioPlanRouter = Router();

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const planningProfileSchema = z.enum([
  "BALANCED",
  "COST_FIRST",
  "DEADLINE_FIRST",
  "RESILIENCE_FIRST",
]);
const requestSchema = z.object({
  horizonStart: z.string(),
  horizonWeeks: z.number().int().min(1).max(12).default(6),
  replaceGenerated: z.boolean().default(true),
  planningProfile: planningProfileSchema.default("BALANCED"),
});
const applySchema = requestSchema.extend({ previewId: hashSchema, inputVersion: hashSchema });
const resilienceSchema = applySchema;

function planningError(error: unknown, response: Parameters<Parameters<typeof portfolioPlanRouter.post>[1]>[1]) {
  const code = error instanceof Error ? error.message : "INTERNAL_SERVER_ERROR";
  if (["HORIZON_START_INVALID", "HORIZON_START_NOT_MONDAY", "HORIZON_WEEKS_INVALID"].includes(code)) {
    return response.status(400).json({ code, message: code === "HORIZON_START_NOT_MONDAY" ? "Horizon start must be a Monday" : "Invalid planning horizon" });
  }
  if (code === "PLANNING_INPUT_TOO_LARGE") {
    return response.status(422).json({ code, message: "Portfolio exceeds the planner limits" });
  }
  throw error;
}

function finishPlanningResponse(
  response: Response,
  operation: string,
  startedAt: number,
  metrics: ServerTimingMetric[] = [],
) {
  preventDecisionCaching(response);
  recordServerTiming(response, operation, startedAt, metrics);
}

function stalePreviewResponse(
  response: Response,
  operation: string,
  startedAt: number,
) {
  response.status(409);
  response.setHeader("X-CrewPlan-Recovery", "regenerate-preview");
  finishPlanningResponse(response, operation, startedAt);
  return response.json({
    code: "PORTFOLIO_PREVIEW_STALE",
    message: "Portfolio data changed after preview; generate a new preview",
    retryable: true,
    recovery: "REGENERATE_PREVIEW",
  });
}

portfolioPlanRouter.post("/preview", async (request, response) => {
  const startedAt = performance.now();
  const result = requestSchema.safeParse(request.body);
  if (!result.success) return response.status(400).json({ code: "VALIDATION_ERROR", message: "Invalid portfolio plan request", errors: result.error.issues });
  try {
    const preview = await buildPortfolioPlanPreview(prisma, result.data);
    finishPlanningResponse(response, "preview", startedAt, [{
      name: "optimizer",
      durationMs: preview.optimizerDiagnostics.runtimeMs,
    }]);
    return response.json(preview);
  } catch (error) {
    return planningError(error, response);
  }
});

portfolioPlanRouter.post("/scenarios", async (request, response) => {
  const startedAt = performance.now();
  const result = requestSchema.omit({ planningProfile: true }).safeParse(request.body);
  if (!result.success) return response.status(400).json({ code: "VALIDATION_ERROR", message: "Invalid scenario comparison request", errors: result.error.issues });
  try {
    const comparison = await buildPortfolioScenarioComparison(prisma, result.data);
    finishPlanningResponse(response, "scenarios", startedAt, [
      { name: "pre_optimizer", durationMs: comparison.runtimeBreakdown.preOptimizerMs },
      { name: "optimizer", durationMs: comparison.runtimeBreakdown.optimizerMs },
      { name: "post_optimizer", durationMs: comparison.runtimeBreakdown.postOptimizerMs },
    ]);
    return response.json(comparison);
  } catch (error) {
    return planningError(error, response);
  }
});

portfolioPlanRouter.post("/resilience", async (request, response) => {
  const startedAt = performance.now();
  const result = resilienceSchema.safeParse(request.body);
  if (!result.success) return response.status(400).json({ code: "VALIDATION_ERROR", message: "Invalid resilience request", errors: result.error.issues });
  try {
    const resilience = await buildPortfolioResilienceReport(prisma, result.data);
    finishPlanningResponse(response, "resilience", startedAt, [
      { name: "baseline", durationMs: resilience.runtimeBreakdown.baselineMs },
      { name: "preparation", durationMs: resilience.runtimeBreakdown.preparationMs },
      { name: "repair", durationMs: resilience.runtimeBreakdown.repairMs },
    ]);
    return response.json(resilience);
  } catch (error) {
    if (error instanceof Error && error.message === "PORTFOLIO_PREVIEW_STALE") {
      return stalePreviewResponse(response, "resilience", startedAt);
    }
    return planningError(error, response);
  }
});

portfolioPlanRouter.post("/apply", async (request, response) => {
  const startedAt = performance.now();
  const result = applySchema.safeParse(request.body);
  if (!result.success) return response.status(400).json({ code: "VALIDATION_ERROR", message: "Invalid portfolio plan apply request", errors: result.error.issues });
  try {
    const applied = await prisma.$transaction(async (transaction) => {
      const preview = await buildPortfolioPlanPreview(transaction, {
        horizonStart: result.data.horizonStart,
        horizonWeeks: result.data.horizonWeeks,
        replaceGenerated: result.data.replaceGenerated,
        planningProfile: result.data.planningProfile,
      });
      if (preview.previewId !== result.data.previewId || preview.inputVersion !== result.data.inputVersion) {
        throw new Error("PORTFOLIO_PREVIEW_STALE");
      }
      const start = parseWeekStart(result.data.horizonStart);
      const firstWindow = getWeekWindowUtc(start);
      const horizonStart = firstWindow.startAt;
      const horizonEndExclusive = start.plus({ weeks: result.data.horizonWeeks }).toUTC().toJSDate();
      let deletedShifts = 0;
      if (result.data.replaceGenerated) {
        const deletion = await transaction.shift.deleteMany({
          where: { origin: "SOLVER", status: "COMMITTED", startAt: { lt: horizonEndExclusive }, endAt: { gt: horizonStart } },
        });
        deletedShifts = deletion.count;
        await transaction.planningRun.updateMany({
          where: { status: "APPLIED", horizonStart: { lt: horizonEndExclusive }, horizonEndExclusive: { gt: horizonStart } },
          data: { status: "SUPERSEDED", supersededAt: new Date() },
        });
      }
      const run = await transaction.planningRun.create({
        data: {
          previewId: preview.previewId,
          inputVersion: preview.inputVersion,
          horizonStart,
          horizonEndExclusive,
          replaceMode: result.data.replaceGenerated ? "REPLACE_GENERATED" : "KEEP_EXISTING",
          configuration: {
            horizonWeeks: result.data.horizonWeeks,
            timezone: preview.timezone,
            planningProfile: result.data.planningProfile,
          },
          metrics: preview.metrics,
        },
      });
      const workData = preview.assignments.map((assignment) => ({
        employeeId: assignment.employeeId,
        projectId: assignment.projectId,
        workPackageId: assignment.workPackageId,
        planningRunId: run.id,
        startAt: new Date(assignment.startAt),
        endAt: new Date(assignment.endAt),
        kind: "WORK_PACKAGE" as const,
        origin: "SOLVER" as const,
        status: "COMMITTED" as const,
        plannedCostCents: assignment.plannedCostCents,
        note: "Generated by CrewPlan portfolio planner",
      }));
      const fixedData = preview.fixedCoverageAssignments.map((assignment) => ({
        employeeId: assignment.employeeId,
        projectId: assignment.projectId,
        projectRequirementId: assignment.projectRequirementId,
        planningRunId: run.id,
        startAt: new Date(assignment.startAt),
        endAt: new Date(assignment.endAt),
        kind: "FIXED_COVERAGE" as const,
        origin: "SOLVER" as const,
        status: "COMMITTED" as const,
        plannedCostCents: assignment.plannedCostCents,
        note: "Generated by CrewPlan portfolio planner",
      }));
      const creation = workData.length + fixedData.length === 0
        ? { count: 0 }
        : await transaction.shift.createMany({ data: [...workData, ...fixedData] });
      return { planningRunId: run.id, previewId: preview.previewId, createdShifts: creation.count, deletedShifts, metrics: preview.metrics };
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 10_000,
      timeout: 30_000,
    });
    response.status(201);
    finishPlanningResponse(response, "apply", startedAt);
    return response.json(applied);
  } catch (error) {
    if (error instanceof Error && error.message === "PORTFOLIO_PREVIEW_STALE") {
      return stalePreviewResponse(response, "apply", startedAt);
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      return response.status(409).json({ code: "PLANNING_CONCURRENT_MODIFICATION", message: "Portfolio changed concurrently; generate a new preview" });
    }
    return planningError(error, response);
  }
});

portfolioPlanRouter.get("/runs", async (_request, response) => {
  const runs = await prisma.planningRun.findMany({ orderBy: { appliedAt: "desc" }, take: 20 });
  return response.json(runs);
});
