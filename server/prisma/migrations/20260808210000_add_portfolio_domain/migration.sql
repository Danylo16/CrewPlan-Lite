-- Portfolio planning enums
CREATE TYPE "ProjectStatus" AS ENUM (
    'DRAFT',
    'PLANNED',
    'ACTIVE',
    'ON_HOLD',
    'COMPLETED',
    'CANCELLED',
    'ARCHIVED'
);

CREATE TYPE "DeadlineType" AS ENUM ('NONE', 'SOFT', 'HARD');
CREATE TYPE "ProjectPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'CRITICAL');
CREATE TYPE "OptimizationStrategy" AS ENUM (
    'BALANCED',
    'EARLIEST_COMPLETION',
    'MINIMIZE_COST',
    'MAXIMIZE_THROUGHPUT'
);
CREATE TYPE "WorkPackageStatus" AS ENUM (
    'TODO',
    'IN_PROGRESS',
    'COMPLETED',
    'CANCELLED'
);
CREATE TYPE "AllocationKind" AS ENUM (
    'GENERAL',
    'WORK_PACKAGE',
    'FIXED_COVERAGE'
);
CREATE TYPE "AllocationOrigin" AS ENUM ('MANUAL', 'SOLVER', 'LEGACY');
CREATE TYPE "AllocationStatus" AS ENUM ('COMMITTED', 'CANCELLED');
CREATE TYPE "WorkLogStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'VOID');
CREATE TYPE "PlanningRunStatus" AS ENUM ('APPLIED', 'SUPERSEDED');
CREATE TYPE "PlanningReplaceMode" AS ENUM ('KEEP_EXISTING', 'REPLACE_GENERATED');

-- Existing employees remain active. Archiving is deliberately non-destructive.
ALTER TABLE "Employee"
ADD COLUMN "archivedAt" TIMESTAMP(3),
ADD COLUMN "archiveReason" TEXT;

CREATE INDEX "Employee_archivedAt_idx" ON "Employee"("archivedAt");

-- Existing projects are live projects, while newly created projects default to DRAFT.
ALTER TABLE "Project"
ADD COLUMN "status" "ProjectStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN "startDate" DATE,
ADD COLUMN "targetEndDate" DATE,
ADD COLUMN "completedAt" TIMESTAMP(3),
ADD COLUMN "archivedAt" TIMESTAMP(3),
ADD COLUMN "deadlineType" "DeadlineType" NOT NULL DEFAULT 'NONE',
ADD COLUMN "priority" "ProjectPriority" NOT NULL DEFAULT 'NORMAL',
ADD COLUMN "optimizationStrategy" "OptimizationStrategy" NOT NULL DEFAULT 'BALANCED',
ADD COLUMN "totalLaborBudgetCents" INTEGER;

ALTER TABLE "Project"
ALTER COLUMN "status" SET DEFAULT 'DRAFT';

ALTER TABLE "Project"
ADD CONSTRAINT "Project_date_range_check"
CHECK (
    "startDate" IS NULL
    OR "targetEndDate" IS NULL
    OR "startDate" <= "targetEndDate"
),
ADD CONSTRAINT "Project_deadline_check"
CHECK (
    ("deadlineType" = 'NONE' AND "targetEndDate" IS NULL)
    OR ("deadlineType" <> 'NONE' AND "targetEndDate" IS NOT NULL)
),
ADD CONSTRAINT "Project_total_budget_check"
CHECK ("totalLaborBudgetCents" IS NULL OR "totalLaborBudgetCents" >= 0);

CREATE INDEX "Project_status_archivedAt_idx" ON "Project"("status", "archivedAt");
CREATE INDEX "Project_startDate_targetEndDate_idx" ON "Project"("startDate", "targetEndDate");

-- Recurring fixed coverage can be bounded without changing existing recurrence.
ALTER TABLE "ProjectRequirement"
ADD COLUMN "activeFrom" DATE,
ADD COLUMN "activeUntil" DATE,
ADD CONSTRAINT "ProjectRequirement_active_range_check"
CHECK (
    "activeFrom" IS NULL
    OR "activeUntil" IS NULL
    OR "activeFrom" <= "activeUntil"
);

ALTER TABLE "ProjectRequirement"
DROP CONSTRAINT "ProjectRequirement_requiredSkillId_fkey";

ALTER TABLE "ProjectRequirement"
ADD CONSTRAINT "ProjectRequirement_requiredSkillId_fkey"
FOREIGN KEY ("requiredSkillId") REFERENCES "Skill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Work packages contain planned scope. Completed minutes are derived from confirmed WorkLog rows.
CREATE TABLE "WorkPackage" (
    "id" SERIAL NOT NULL,
    "projectId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "WorkPackageStatus" NOT NULL DEFAULT 'TODO',
    "requiredSkillId" INTEGER NOT NULL,
    "minimumSkillLevel" INTEGER NOT NULL DEFAULT 1,
    "estimatedMinutes" INTEGER NOT NULL,
    "remainingMinutes" INTEGER NOT NULL,
    "maxParallelEmployees" INTEGER NOT NULL DEFAULT 1,
    "earliestStartDate" DATE,
    "targetEndDate" DATE,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkPackage_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "WorkPackage_skill_level_check" CHECK ("minimumSkillLevel" BETWEEN 1 AND 5),
    CONSTRAINT "WorkPackage_minutes_check" CHECK (
        "estimatedMinutes" > 0 AND "remainingMinutes" >= 0
    ),
    CONSTRAINT "WorkPackage_parallelism_check" CHECK ("maxParallelEmployees" BETWEEN 1 AND 20),
    CONSTRAINT "WorkPackage_date_range_check" CHECK (
        "earliestStartDate" IS NULL
        OR "targetEndDate" IS NULL
        OR "earliestStartDate" <= "targetEndDate"
    )
);

CREATE INDEX "WorkPackage_projectId_status_idx" ON "WorkPackage"("projectId", "status");
CREATE INDEX "WorkPackage_requiredSkillId_minimumSkillLevel_idx"
ON "WorkPackage"("requiredSkillId", "minimumSkillLevel");

ALTER TABLE "WorkPackage"
ADD CONSTRAINT "WorkPackage_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "WorkPackage_requiredSkillId_fkey"
FOREIGN KEY ("requiredSkillId") REFERENCES "Skill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "WorkPackageDependency" (
    "predecessorId" INTEGER NOT NULL,
    "successorId" INTEGER NOT NULL,
    "lagMinutes" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "WorkPackageDependency_pkey" PRIMARY KEY ("predecessorId", "successorId"),
    CONSTRAINT "WorkPackageDependency_not_self_check" CHECK ("predecessorId" <> "successorId"),
    CONSTRAINT "WorkPackageDependency_lag_check" CHECK ("lagMinutes" >= 0)
);

CREATE INDEX "WorkPackageDependency_successorId_idx"
ON "WorkPackageDependency"("successorId");

ALTER TABLE "WorkPackageDependency"
ADD CONSTRAINT "WorkPackageDependency_predecessorId_fkey"
FOREIGN KEY ("predecessorId") REFERENCES "WorkPackage"("id") ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "WorkPackageDependency_successorId_fkey"
FOREIGN KEY ("successorId") REFERENCES "WorkPackage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A planning run is written only when a preview is applied.
CREATE TABLE "PlanningRun" (
    "id" UUID NOT NULL,
    "previewId" CHAR(64) NOT NULL,
    "inputVersion" CHAR(64) NOT NULL,
    "horizonStart" DATE NOT NULL,
    "horizonEndExclusive" DATE NOT NULL,
    "replaceMode" "PlanningReplaceMode" NOT NULL,
    "status" "PlanningRunStatus" NOT NULL DEFAULT 'APPLIED',
    "configuration" JSONB NOT NULL,
    "metrics" JSONB NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededAt" TIMESTAMP(3),

    CONSTRAINT "PlanningRun_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PlanningRun_horizon_check" CHECK ("horizonStart" < "horizonEndExclusive")
);

CREATE UNIQUE INDEX "PlanningRun_previewId_key" ON "PlanningRun"("previewId");
CREATE INDEX "PlanningRun_horizonStart_horizonEndExclusive_idx"
ON "PlanningRun"("horizonStart", "horizonEndExclusive");

-- Expand Shift in place. The physical table and every existing row are preserved.
ALTER TABLE "Shift"
ADD COLUMN "workPackageId" INTEGER,
ADD COLUMN "projectRequirementId" INTEGER,
ADD COLUMN "planningRunId" UUID,
ADD COLUMN "kind" "AllocationKind" NOT NULL DEFAULT 'GENERAL',
ADD COLUMN "origin" "AllocationOrigin" NOT NULL DEFAULT 'LEGACY',
ADD COLUMN "status" "AllocationStatus" NOT NULL DEFAULT 'COMMITTED',
ADD COLUMN "plannedCostCents" INTEGER,
ADD COLUMN "cancelledAt" TIMESTAMP(3);

UPDATE "Shift"
SET "origin" = 'SOLVER'
WHERE "note" = 'Generated by CrewPlan scheduler';

ALTER TABLE "Shift"
ADD CONSTRAINT "Shift_time_range_check" CHECK ("startAt" < "endAt"),
ADD CONSTRAINT "Shift_planned_cost_check" CHECK (
    "plannedCostCents" IS NULL OR "plannedCostCents" >= 0
),
ADD CONSTRAINT "Shift_allocation_kind_check" CHECK (
    ("kind" = 'GENERAL' AND "workPackageId" IS NULL AND "projectRequirementId" IS NULL)
    OR ("kind" = 'WORK_PACKAGE' AND "workPackageId" IS NOT NULL AND "projectRequirementId" IS NULL)
    OR ("kind" = 'FIXED_COVERAGE' AND "workPackageId" IS NULL AND "projectRequirementId" IS NOT NULL)
);

DROP INDEX "Shift_projectId_idx";
CREATE INDEX "Shift_projectId_startAt_idx" ON "Shift"("projectId", "startAt");
CREATE INDEX "Shift_workPackageId_idx" ON "Shift"("workPackageId");
CREATE INDEX "Shift_projectRequirementId_idx" ON "Shift"("projectRequirementId");
CREATE INDEX "Shift_planningRunId_idx" ON "Shift"("planningRunId");

ALTER TABLE "Shift" DROP CONSTRAINT "Shift_employeeId_fkey";
ALTER TABLE "Shift" DROP CONSTRAINT "Shift_projectId_fkey";

ALTER TABLE "Shift"
ADD CONSTRAINT "Shift_employeeId_fkey"
FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
ADD CONSTRAINT "Shift_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
ADD CONSTRAINT "Shift_workPackageId_fkey"
FOREIGN KEY ("workPackageId") REFERENCES "WorkPackage"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
ADD CONSTRAINT "Shift_projectRequirementId_fkey"
FOREIGN KEY ("projectRequirementId") REFERENCES "ProjectRequirement"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
ADD CONSTRAINT "Shift_planningRunId_fkey"
FOREIGN KEY ("planningRunId") REFERENCES "PlanningRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Actual work is separate from planned allocations.
CREATE TABLE "WorkLog" (
    "id" SERIAL NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "projectId" INTEGER NOT NULL,
    "workPackageId" INTEGER NOT NULL,
    "plannedAllocationId" INTEGER,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3) NOT NULL,
    "status" "WorkLogStatus" NOT NULL DEFAULT 'DRAFT',
    "note" TEXT,
    "actualCostCents" INTEGER,
    "remainingMinutesApplied" INTEGER,
    "confirmedAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkLog_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "WorkLog_time_range_check" CHECK ("startedAt" < "endedAt"),
    CONSTRAINT "WorkLog_cost_check" CHECK ("actualCostCents" IS NULL OR "actualCostCents" >= 0),
    CONSTRAINT "WorkLog_remaining_applied_check" CHECK (
        "remainingMinutesApplied" IS NULL OR "remainingMinutesApplied" >= 0
    ),
    CONSTRAINT "WorkLog_confirmation_check" CHECK (
        "status" <> 'CONFIRMED'
        OR (
            "confirmedAt" IS NOT NULL
            AND "actualCostCents" IS NOT NULL
            AND "remainingMinutesApplied" IS NOT NULL
        )
    ),
    CONSTRAINT "WorkLog_void_check" CHECK ("status" <> 'VOID' OR "voidedAt" IS NOT NULL)
);

CREATE INDEX "WorkLog_employeeId_startedAt_idx" ON "WorkLog"("employeeId", "startedAt");
CREATE INDEX "WorkLog_projectId_status_idx" ON "WorkLog"("projectId", "status");
CREATE INDEX "WorkLog_workPackageId_status_idx" ON "WorkLog"("workPackageId", "status");

ALTER TABLE "WorkLog"
ADD CONSTRAINT "WorkLog_employeeId_fkey"
FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
ADD CONSTRAINT "WorkLog_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
ADD CONSTRAINT "WorkLog_workPackageId_fkey"
FOREIGN KEY ("workPackageId") REFERENCES "WorkPackage"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
ADD CONSTRAINT "WorkLog_plannedAllocationId_fkey"
FOREIGN KEY ("plannedAllocationId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;
