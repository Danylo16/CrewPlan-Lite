-- CreateEnum
CREATE TYPE "DayOfWeek" AS ENUM (
    'MONDAY',
    'TUESDAY',
    'WEDNESDAY',
    'THURSDAY',
    'FRIDAY',
    'SATURDAY',
    'SUNDAY'
);

-- CreateEnum
CREATE TYPE "RequirementPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'CRITICAL');

-- AlterTable
ALTER TABLE "Employee"
ADD COLUMN "preferredWeeklyMinutes" INTEGER NOT NULL DEFAULT 1920,
ADD COLUMN "maxWeeklyMinutes" INTEGER NOT NULL DEFAULT 2400;

ALTER TABLE "Employee"
ADD CONSTRAINT "Employee_weekly_minutes_check"
CHECK (
    "preferredWeeklyMinutes" >= 0
    AND "maxWeeklyMinutes" > 0
    AND "preferredWeeklyMinutes" <= "maxWeeklyMinutes"
);

-- CreateTable
CREATE TABLE "Skill" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Skill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeSkill" (
    "employeeId" INTEGER NOT NULL,
    "skillId" INTEGER NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployeeSkill_pkey" PRIMARY KEY ("employeeId", "skillId"),
    CONSTRAINT "EmployeeSkill_level_check" CHECK ("level" BETWEEN 1 AND 5)
);

-- CreateTable
CREATE TABLE "EmployeeAvailability" (
    "id" SERIAL NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "dayOfWeek" "DayOfWeek" NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployeeAvailability_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EmployeeAvailability_time_check" CHECK (
        "startMinute" >= 0
        AND "startMinute" < 1440
        AND "endMinute" > 0
        AND "endMinute" <= 1440
        AND "startMinute" < "endMinute"
    )
);

-- CreateTable
CREATE TABLE "ProjectRequirement" (
    "id" SERIAL NOT NULL,
    "projectId" INTEGER NOT NULL,
    "dayOfWeek" "DayOfWeek" NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "requiredEmployees" INTEGER NOT NULL DEFAULT 1,
    "requiredSkillId" INTEGER,
    "minimumSkillLevel" INTEGER NOT NULL DEFAULT 1,
    "priority" "RequirementPriority" NOT NULL DEFAULT 'NORMAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectRequirement_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProjectRequirement_time_check" CHECK (
        "startMinute" >= 0
        AND "startMinute" < 1440
        AND "endMinute" > 0
        AND "endMinute" <= 1440
        AND "startMinute" < "endMinute"
    ),
    CONSTRAINT "ProjectRequirement_count_check" CHECK ("requiredEmployees" BETWEEN 1 AND 100),
    CONSTRAINT "ProjectRequirement_skill_level_check" CHECK ("minimumSkillLevel" BETWEEN 1 AND 5)
);

-- CreateIndex
CREATE UNIQUE INDEX "Skill_name_key" ON "Skill"("name");

-- CreateIndex
CREATE INDEX "EmployeeSkill_skillId_level_idx" ON "EmployeeSkill"("skillId", "level");

-- CreateIndex
CREATE INDEX "EmployeeAvailability_employeeId_dayOfWeek_idx"
ON "EmployeeAvailability"("employeeId", "dayOfWeek");

-- CreateIndex
CREATE INDEX "ProjectRequirement_projectId_dayOfWeek_idx"
ON "ProjectRequirement"("projectId", "dayOfWeek");

-- CreateIndex
CREATE INDEX "ProjectRequirement_requiredSkillId_minimumSkillLevel_idx"
ON "ProjectRequirement"("requiredSkillId", "minimumSkillLevel");

-- AddForeignKey
ALTER TABLE "EmployeeSkill"
ADD CONSTRAINT "EmployeeSkill_employeeId_fkey"
FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeSkill"
ADD CONSTRAINT "EmployeeSkill_skillId_fkey"
FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeAvailability"
ADD CONSTRAINT "EmployeeAvailability_employeeId_fkey"
FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectRequirement"
ADD CONSTRAINT "ProjectRequirement_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectRequirement"
ADD CONSTRAINT "ProjectRequirement_requiredSkillId_fkey"
FOREIGN KEY ("requiredSkillId") REFERENCES "Skill"("id") ON DELETE SET NULL ON UPDATE CASCADE;
