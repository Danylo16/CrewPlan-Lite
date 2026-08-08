ALTER TABLE "Employee"
ADD COLUMN "hourlyCostCents" INTEGER NOT NULL DEFAULT 3500,
ADD COLUMN "overtimeRateBasisPoints" INTEGER NOT NULL DEFAULT 15000;

ALTER TABLE "Project"
ADD COLUMN "weeklyLaborBudgetCents" INTEGER;

ALTER TABLE "Employee"
ADD CONSTRAINT "Employee_hourlyCostCents_check"
CHECK ("hourlyCostCents" >= 0),
ADD CONSTRAINT "Employee_overtimeRateBasisPoints_check"
CHECK ("overtimeRateBasisPoints" >= 10000 AND "overtimeRateBasisPoints" <= 50000);

ALTER TABLE "Project"
ADD CONSTRAINT "Project_weeklyLaborBudgetCents_check"
CHECK ("weeklyLaborBudgetCents" IS NULL OR "weeklyLaborBudgetCents" >= 0);
