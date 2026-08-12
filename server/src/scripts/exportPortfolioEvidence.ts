import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

type PlanningProfile = "BALANCED" | "COST_FIRST" | "DEADLINE_FIRST" | "RESILIENCE_FIRST";
type EvidenceMode = "controlled-v2" | "production-observation";

const CONTROLLED_V2_CONTRACT = {
  BALANCED: { workPackageCostCents: 1_271_400, softDeadlineExposureMinutes: 0, skillConcentrationBasisPoints: 7_771 },
  COST_FIRST: { workPackageCostCents: 1_249_800, softDeadlineExposureMinutes: 480, skillConcentrationBasisPoints: 7_771 },
  DEADLINE_FIRST: { workPackageCostCents: 1_271_400, softDeadlineExposureMinutes: 0, skillConcentrationBasisPoints: 7_771 },
  RESILIENCE_FIRST: { workPackageCostCents: 1_414_600, softDeadlineExposureMinutes: 0, skillConcentrationBasisPoints: 5_029 },
} as const;

interface Scenario {
  planningProfile: PlanningProfile;
  algorithmVersion: string;
  strategy: string;
  previewId: string;
  inputVersion: string;
  proposedWorkMinutes: number;
  unplannedWorkPackages: number;
  unplannedMinutes: number;
  workPackageCostCents: number;
  hardDeadlineExposureMinutes: number;
  softDeadlineExposureMinutes: number;
  weeklyBudgetOverrunCents: number;
  totalBudgetOverrunCents: number;
  skillConcentrationBasisPoints: number;
  optimizerRuntimeMs: number;
  orderExploredStates: number;
  placementExploredStates: number;
  candidateCount: number;
  searchLimitReached: boolean;
}

interface Comparison {
  comparisonId: string;
  runtimeMs: number;
  runtimeBreakdown: {
    preOptimizerMs: number;
    optimizerMs: number;
    postOptimizerMs: number;
  };
  scenarios: Scenario[];
}

interface Preview {
  previewId: string;
  inputVersion: string;
  horizonStart: string;
  horizonWeeks: number;
  replaceGenerated: boolean;
  planningProfile: PlanningProfile;
  resilienceCandidates: Array<{ employeeId: number }>;
  optimizerDiagnostics: {
    algorithmVersion: string;
    strategy: string;
    runtimeMs: number;
    searchLimitReached: boolean;
    objectiveVector: {
      hardDeadlineExposureMinutes: number;
      softDeadlineExposureMinutes: number;
      weeklyBudgetOverrunCents: number;
      totalBudgetOverrunCents: number;
      skillConcentrationBasisPoints: number;
    };
    optimized: {
      plannedMinutes: number;
      unplannedMinutes: number;
      laborCostCents: number;
    };
  };
  metrics: {
    workPackageCostCents: number;
    plannedCostCents: number;
    unplannedWorkPackages: number;
  };
}

interface ResilienceReport {
  algorithmVersion: string;
  testedAbsences: number;
  recoverableAbsences: number;
  averageCoveragePercent: number;
  worstCaseCoveragePercent: number;
  criticalGapsAtRisk: number;
  maxRequiredReassignments: number;
  runtimeMs: number;
}

interface TimedResponse<T> {
  httpMs: number;
  serverMs: number | null;
  requestId: string | null;
  serverTiming: string | null;
  body: T;
}

function argument(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
}

function positiveInteger(value: string | undefined, fallback: number, name: string) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function evidenceMode(value: string | undefined): EvidenceMode {
  const mode = value ?? "controlled-v2";
  if (mode !== "controlled-v2" && mode !== "production-observation") {
    throw new Error("mode must be controlled-v2 or production-observation");
  }
  return mode;
}

const apiUrl = (argument("api") ?? process.env.CREWPLAN_API_URL ?? "http://localhost:3000/api")
  .replace(/\/$/, "");
const horizonStart = argument("horizon-start") ?? process.env.EVIDENCE_HORIZON_START ?? "2026-08-17";
const horizonWeeks = positiveInteger(argument("horizon-weeks") ?? process.env.EVIDENCE_HORIZON_WEEKS, 6, "horizon-weeks");
const repeats = positiveInteger(argument("repeats") ?? process.env.EVIDENCE_REPEATS, 5, "repeats");
const mode = evidenceMode(argument("mode") ?? process.env.EVIDENCE_MODE);
const outputDirectory = path.resolve(
  argument("output") ?? process.env.EVIDENCE_OUTPUT_DIR ?? path.join(process.cwd(), "..", "artifacts"),
);

function round(value: number) {
  return Math.round(value * 100) / 100;
}

function percentile(values: number[], quantile: number) {
  const sorted = [...values].sort((first, second) => first - second);
  if (sorted.length === 1) return sorted[0]!;
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = sorted[lower]!;
  const upperValue = sorted[upper]!;
  return round(lowerValue + (upperValue - lowerValue) * (position - lower));
}

function timing(values: number[]) {
  return {
    minMs: Math.min(...values),
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: Math.max(...values),
  };
}

function signature(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function scenarioSignature(scenarios: Scenario[]) {
  return signature(scenarios.map((scenario) => ({
    ...scenario,
    optimizerRuntimeMs: undefined,
  })));
}

function serverDuration(header: string | null) {
  const match = header?.match(/(?:^|,\s*)total;dur=([0-9.]+)/);
  return match === undefined || match === null ? null : Number(match[1]);
}

async function jsonRequest<T>(endpoint: string, body?: unknown): Promise<TimedResponse<T>> {
  const startedAt = performance.now();
  const request: RequestInit = body === undefined
    ? { method: "GET", signal: AbortSignal.timeout(120_000) }
    : {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      };
  const response = await fetch(`${apiUrl}${endpoint}`, request);
  const httpMs = Math.round(performance.now() - startedAt);
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`${endpoint} returned ${response.status}: ${responseText}`);
  }
  const serverTiming = response.headers.get("server-timing");
  return {
    httpMs,
    serverMs: serverDuration(serverTiming),
    requestId: response.headers.get("x-request-id"),
    serverTiming,
    body: JSON.parse(responseText) as T,
  };
}

function scenarioByProfile(comparison: Comparison, profile: PlanningProfile) {
  const scenario = comparison.scenarios.find((item) => item.planningProfile === profile);
  if (scenario === undefined) throw new Error(`Comparison omitted ${profile}`);
  return scenario;
}

function matchesControlledV2(comparison: Comparison) {
  return (Object.entries(CONTROLLED_V2_CONTRACT) as Array<[
    PlanningProfile,
    (typeof CONTROLLED_V2_CONTRACT)[PlanningProfile],
  ]>).every(([profile, expected]) => {
    const actual = scenarioByProfile(comparison, profile);
    return actual.proposedWorkMinutes === 16_860
      && actual.unplannedMinutes === 0
      && actual.workPackageCostCents === expected.workPackageCostCents
      && actual.softDeadlineExposureMinutes === expected.softDeadlineExposureMinutes
      && actual.skillConcentrationBasisPoints === expected.skillConcentrationBasisPoints
      && actual.candidateCount === 11
      && !actual.searchLimitReached;
  });
}

function controlledV2Mismatch(comparison: Comparison) {
  return comparison.scenarios.map((scenario) => ({
    planningProfile: scenario.planningProfile,
    proposedWorkMinutes: scenario.proposedWorkMinutes,
    workPackageCostCents: scenario.workPackageCostCents,
    softDeadlineExposureMinutes: scenario.softDeadlineExposureMinutes,
    skillConcentrationBasisPoints: scenario.skillConcentrationBasisPoints,
    candidateCount: scenario.candidateCount,
  }));
}

function reviewSummary(response: TimedResponse<Preview>) {
  const preview = response.body;
  return {
    planningProfile: preview.planningProfile,
    previewId: preview.previewId,
    inputVersion: preview.inputVersion,
    algorithmVersion: preview.optimizerDiagnostics.algorithmVersion,
    strategy: preview.optimizerDiagnostics.strategy,
    httpMs: response.httpMs,
    serverMs: response.serverMs,
    optimizerMs: preview.optimizerDiagnostics.runtimeMs,
    workPackageCostCents: preview.metrics.workPackageCostCents,
    plannedCostCents: preview.metrics.plannedCostCents,
    plannedMinutes: preview.optimizerDiagnostics.optimized.plannedMinutes,
    unplannedMinutes: preview.optimizerDiagnostics.optimized.unplannedMinutes,
    unplannedWorkPackages: preview.metrics.unplannedWorkPackages,
    objectiveVector: preview.optimizerDiagnostics.objectiveVector,
    resilienceCandidates: preview.resilienceCandidates.length,
    searchLimitReached: preview.optimizerDiagnostics.searchLimitReached,
  };
}

function markdown(report: EvidenceReport) {
  const compareRows = report.compare.referenceScenarios.map((scenario) =>
    `| ${scenario.planningProfile} | €${(scenario.workPackageCostCents / 100).toFixed(0)} | ${scenario.unplannedMinutes} | ${scenario.softDeadlineExposureMinutes} | ${scenario.skillConcentrationBasisPoints} | ${scenario.candidateCount} | ${scenario.searchLimitReached} |`,
  ).join("\n");
  const reviewRows = report.fullReviews.map((review) =>
    `| ${review.planningProfile} | €${(review.workPackageCostCents / 100).toFixed(0)} | ${review.unplannedMinutes} | ${review.objectiveVector.softDeadlineExposureMinutes} | ${review.objectiveVector.skillConcentrationBasisPoints} | ${review.httpMs} |`,
  ).join("\n");
  const resilienceRows = report.resilience.map((item) =>
    `| ${item.planningProfile} | ${item.report.testedAbsences} | ${item.report.recoverableAbsences} | ${item.report.averageCoveragePercent}% | ${item.report.worstCaseCoveragePercent}% | ${item.httpMs} |`,
  ).join("\n");
  const gateRows = Object.entries(report.gates).map(([name, passed]) =>
    `| ${name} | ${passed ? "PASS" : "FAIL"} |`,
  ).join("\n");
  return `# CrewPlan portfolio evidence

- Generated: ${report.generatedAt}
- API: ${report.source.apiUrl}
- Commit: ${report.source.commit}
- Mode: ${report.source.mode}
- Dataset: ${report.source.dataset}
- Horizon: ${report.source.horizonStart}, ${report.source.horizonWeeks} weeks
- Result: **${report.passed ? "PASS" : "FAIL"}**

## Compare strategies timing

| Metric | HTTP | Server | Optimizer |
| --- | ---: | ---: | ---: |
| min | ${report.compare.httpTiming.minMs} ms | ${report.compare.serverTiming.minMs} ms | ${report.compare.optimizerTiming.minMs} ms |
| p50 | ${report.compare.httpTiming.p50Ms} ms | ${report.compare.serverTiming.p50Ms} ms | ${report.compare.optimizerTiming.p50Ms} ms |
| p95 | ${report.compare.httpTiming.p95Ms} ms | ${report.compare.serverTiming.p95Ms} ms | ${report.compare.optimizerTiming.p95Ms} ms |
| max | ${report.compare.httpTiming.maxMs} ms | ${report.compare.serverTiming.maxMs} ms | ${report.compare.optimizerTiming.maxMs} ms |

| Phase | min | p50 | p95 | max |
| --- | ---: | ---: | ---: | ---: |
| Pre-optimizer | ${report.compare.preOptimizerTiming.minMs} ms | ${report.compare.preOptimizerTiming.p50Ms} ms | ${report.compare.preOptimizerTiming.p95Ms} ms | ${report.compare.preOptimizerTiming.maxMs} ms |
| Optimizer | ${report.compare.optimizerTiming.minMs} ms | ${report.compare.optimizerTiming.p50Ms} ms | ${report.compare.optimizerTiming.p95Ms} ms | ${report.compare.optimizerTiming.maxMs} ms |
| Post-optimizer | ${report.compare.postOptimizerTiming.minMs} ms | ${report.compare.postOptimizerTiming.p50Ms} ms | ${report.compare.postOptimizerTiming.p95Ms} ms | ${report.compare.postOptimizerTiming.maxMs} ms |

Deterministic signature: \`${report.compare.signature}\`

## Observed decision trade-offs

| Observation | Present |
| --- | --- |
| Cost vs deadline | ${report.observations.costDeadlineTradeoff ? "YES" : "NO"} |
| Cost vs resilience | ${report.observations.costResilienceTradeoff ? "YES" : "NO"} |
| Full-review resilience | ${report.observations.fullReviewResilienceTradeoff ? "YES" : "NO"} |

## Shared Pareto shortlist

| Profile | Cost | Unplanned min | Soft deadline min | Concentration bps | Candidates | Limit reached |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
${compareRows}

## Full review

| Profile | Cost | Unplanned min | Soft deadline min | Concentration bps | HTTP ms |
| --- | ---: | ---: | ---: | ---: | ---: |
${reviewRows}

## N−1 resilience

| Profile | Tested | Fully recoverable | Average coverage | Worst coverage | HTTP ms |
| --- | ---: | ---: | ---: | ---: | ---: |
${resilienceRows}

## Acceptance gates

| Gate | Result |
| --- | --- |
${gateRows}
`;
}

interface EvidenceReport {
  schemaVersion: "crewplan-portfolio-evidence-v2";
  generatedAt: string;
  source: {
    apiUrl: string;
    commit: string;
    environment: string;
    mode: EvidenceMode;
    dataset: "V2" | "UNCONTROLLED_PRODUCTION";
    horizonStart: string;
    horizonWeeks: number;
    repeats: number;
  };
  compare: {
    runs: Array<{
      run: number;
      httpMs: number;
      serverMs: number;
      preOptimizerMs: number;
      optimizerMs: number;
      postOptimizerMs: number;
      requestId: string | null;
      signature: string;
    }>;
    httpTiming: ReturnType<typeof timing>;
    serverTiming: ReturnType<typeof timing>;
    preOptimizerTiming: ReturnType<typeof timing>;
    optimizerTiming: ReturnType<typeof timing>;
    postOptimizerTiming: ReturnType<typeof timing>;
    signature: string;
    referenceScenarios: Scenario[];
  };
  fullReviews: Array<ReturnType<typeof reviewSummary>>;
  shortlistVsReview: Array<{
    planningProfile: PlanningProfile;
    costDeltaCents: number;
    unplannedMinutesDelta: number;
    softDeadlineExposureDelta: number;
    concentrationDeltaBasisPoints: number;
  }>;
  resilience: Array<{
    planningProfile: PlanningProfile;
    httpMs: number;
    serverMs: number | null;
    requestId: string | null;
    report: ResilienceReport;
  }>;
  observations: {
    costDeadlineTradeoff: boolean;
    costResilienceTradeoff: boolean;
    fullReviewResilienceTradeoff: boolean;
  };
  gates: Record<string, boolean>;
  passed: boolean;
}

async function main() {
  const version = await jsonRequest<{ commit: string; environment: string }>("/version");
  const compareResponses: Array<TimedResponse<Comparison>> = [await jsonRequest<Comparison>("/portfolio-plan/scenarios", {
    horizonStart,
    horizonWeeks,
    replaceGenerated: true,
  })];
  if (mode === "controlled-v2" && !matchesControlledV2(compareResponses[0]!.body)) {
    throw new Error(
      "The API does not expose the controlled V2 fixture. Refusing to label this run as V2. "
      + "Use a clean benchmark database seeded with seed:demo and seed:optimizer-demo, "
      + "or use --mode=production-observation for non-V2 production measurements.\n"
      + JSON.stringify(controlledV2Mismatch(compareResponses[0]!.body), null, 2),
    );
  }
  for (let run = 1; run < repeats; run += 1) {
    compareResponses.push(await jsonRequest<Comparison>("/portfolio-plan/scenarios", {
      horizonStart,
      horizonWeeks,
      replaceGenerated: true,
    }));
  }
  const compareRuns = compareResponses.map((response, index) => ({
    run: index + 1,
    httpMs: response.httpMs,
    serverMs: Math.round(response.serverMs ?? response.body.runtimeMs),
    preOptimizerMs: response.body.runtimeBreakdown.preOptimizerMs,
    optimizerMs: response.body.runtimeBreakdown.optimizerMs,
    postOptimizerMs: response.body.runtimeBreakdown.postOptimizerMs,
    requestId: response.requestId,
    signature: scenarioSignature(response.body.scenarios),
  }));
  const reference = compareResponses.at(-1)!.body;

  const reviewResponses: Array<TimedResponse<Preview>> = [];
  for (const planningProfile of ["BALANCED", "RESILIENCE_FIRST"] as const) {
    reviewResponses.push(await jsonRequest<Preview>("/portfolio-plan/preview", {
      horizonStart,
      horizonWeeks,
      replaceGenerated: true,
      planningProfile,
    }));
  }
  const fullReviews = reviewResponses.map(reviewSummary);
  const shortlistVsReview = fullReviews.map((review) => {
    const shortlist = scenarioByProfile(reference, review.planningProfile);
    return {
      planningProfile: review.planningProfile,
      costDeltaCents: review.workPackageCostCents - shortlist.workPackageCostCents,
      unplannedMinutesDelta: review.unplannedMinutes - shortlist.unplannedMinutes,
      softDeadlineExposureDelta: review.objectiveVector.softDeadlineExposureMinutes
        - shortlist.softDeadlineExposureMinutes,
      concentrationDeltaBasisPoints: review.objectiveVector.skillConcentrationBasisPoints
        - shortlist.skillConcentrationBasisPoints,
    };
  });

  const resilience = [];
  for (const reviewResponse of reviewResponses) {
    const preview = reviewResponse.body;
    const response = await jsonRequest<ResilienceReport>("/portfolio-plan/resilience", {
      horizonStart: preview.horizonStart,
      horizonWeeks: preview.horizonWeeks,
      replaceGenerated: preview.replaceGenerated,
      planningProfile: preview.planningProfile,
      previewId: preview.previewId,
      inputVersion: preview.inputVersion,
    });
    resilience.push({
      planningProfile: preview.planningProfile,
      httpMs: response.httpMs,
      serverMs: response.serverMs,
      requestId: response.requestId,
      report: response.body,
    });
  }

  const cost = scenarioByProfile(reference, "COST_FIRST");
  const deadline = scenarioByProfile(reference, "DEADLINE_FIRST");
  const balanced = scenarioByProfile(reference, "BALANCED");
  const resilient = scenarioByProfile(reference, "RESILIENCE_FIRST");
  const reviewedBalanced = fullReviews.find((item) => item.planningProfile === "BALANCED")!;
  const reviewedResilient = fullReviews.find((item) => item.planningProfile === "RESILIENCE_FIRST")!;
  const signatures = new Set(compareRuns.map((item) => item.signature));
  const observations = {
    costDeadlineTradeoff: cost.workPackageCostCents < deadline.workPackageCostCents
      && cost.softDeadlineExposureMinutes > deadline.softDeadlineExposureMinutes,
    costResilienceTradeoff: resilient.workPackageCostCents > balanced.workPackageCostCents
      && resilient.skillConcentrationBasisPoints < balanced.skillConcentrationBasisPoints,
    fullReviewResilienceTradeoff:
      reviewedResilient.workPackageCostCents > reviewedBalanced.workPackageCostCents
      && reviewedResilient.objectiveVector.skillConcentrationBasisPoints
        < reviewedBalanced.objectiveVector.skillConcentrationBasisPoints,
  };
  const commonGates = {
    repeatCount: compareRuns.length >= 5,
    correctAlgorithmVersion: reference.scenarios.every(
      (scenario) => scenario.algorithmVersion === "portfolio-pareto-beam-v4",
    ),
    compareRuntimeUnder10s: compareRuns.every((run) => run.httpMs < 10_000),
    deterministicReplay: signatures.size === 1,
    searchCompleted: reference.scenarios.every((scenario) => !scenario.searchLimitReached),
    fullCoverage: reference.scenarios.every((scenario) => scenario.unplannedMinutes === 0),
    candidatePoolPreserved: reference.scenarios.every((scenario) => scenario.candidateCount >= 2),
    fullReviewsCompleted: fullReviews.every(
      (review) => !review.searchLimitReached && review.unplannedMinutes === 0,
    ),
    nMinusOneRuntimeUnder20s: resilience.every((item) => item.report.runtimeMs < 20_000),
    nMinusOneAllEmployeesTested: resilience.every((item) => {
      const review = fullReviews.find((candidate) => candidate.planningProfile === item.planningProfile)!;
      return item.report.testedAbsences === review.resilienceCandidates;
    }),
  };
  const gates = mode === "controlled-v2"
    ? {
        ...commonGates,
        controlledV2Contract: matchesControlledV2(reference),
        ...observations,
      }
    : commonGates;
  const report: EvidenceReport = {
    schemaVersion: "crewplan-portfolio-evidence-v2",
    generatedAt: new Date().toISOString(),
    source: {
      apiUrl,
      commit: version.body.commit,
      environment: version.body.environment,
      mode,
      dataset: mode === "controlled-v2" ? "V2" : "UNCONTROLLED_PRODUCTION",
      horizonStart,
      horizonWeeks,
      repeats,
    },
    compare: {
      runs: compareRuns,
      httpTiming: timing(compareRuns.map((item) => item.httpMs)),
      serverTiming: timing(compareRuns.map((item) => item.serverMs)),
      preOptimizerTiming: timing(compareRuns.map((item) => item.preOptimizerMs)),
      optimizerTiming: timing(compareRuns.map((item) => item.optimizerMs)),
      postOptimizerTiming: timing(compareRuns.map((item) => item.postOptimizerMs)),
      signature: compareRuns[0]!.signature,
      referenceScenarios: reference.scenarios,
    },
    fullReviews,
    shortlistVsReview,
    resilience,
    observations,
    gates,
    passed: Object.values(gates).every(Boolean),
  };

  await mkdir(outputDirectory, { recursive: true });
  const jsonPath = path.join(outputDirectory, "portfolio-evidence.json");
  const markdownPath = path.join(outputDirectory, "portfolio-evidence.md");
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
    writeFile(markdownPath, markdown(report), "utf8"),
  ]);
  console.table(compareRuns);
  console.table(observations);
  console.table(gates);
  console.log(`Evidence JSON: ${jsonPath}`);
  console.log(`Evidence Markdown: ${markdownPath}`);
  if (!report.passed) throw new Error("Portfolio evidence acceptance failed");
}

await main();
