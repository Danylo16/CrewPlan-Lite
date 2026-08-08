import { useEffect, useState, type FormEvent } from "react";
import { apiRequest } from "../api/client";
import type {
  AppliedSchedule,
  Employee,
  Holiday,
  Project,
  ProposedAssignment,
  SchedulePreview,
  Shift,
  UnfilledRequirement,
} from "../types";

interface ShiftForm {
  employeeId: string;
  projectId: string;
  startAt: string;
  endAt: string;
  note: string;
}

function startOfWeek(date: Date) {
  const result = new Date(date);
  const day = result.getDay();
  const difference = day === 0 ? -6 : 1 - day;

  result.setDate(result.getDate() + difference);
  result.setHours(0, 0, 0, 0);

  return result;
}

function addDays(date: Date, amount: number) {
  const result = new Date(date);
  result.setDate(result.getDate() + amount);
  return result;
}

function toDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function toLocalInputValue(date: Date) {
  const timezoneOffset = date.getTimezoneOffset() * 60_000;

  return new Date(date.getTime() - timezoneOffset)
    .toISOString()
    .slice(0, 16);
}

function createInitialForm(referenceDate = new Date()): ShiftForm {
  const start = new Date(referenceDate);

  if (
    start.getHours() === 0 &&
    start.getMinutes() === 0 &&
    start.getSeconds() === 0
  ) {
    start.setHours(9, 0, 0, 0);
  } else {
    start.setMinutes(0, 0, 0);
  }

  const end = new Date(start);
  end.setHours(end.getHours() + 4);

  return {
    employeeId: "",
    projectId: "",
    startAt: toLocalInputValue(start),
    endAt: toLocalInputValue(end),
    note: "",
  };
}

function formatTime(date: string) {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(date));
}

function formatMinutes(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = String(minutes % 60).padStart(2, "0");

  return `${hours}:${remainingMinutes}`;
}

function describeRejections(requirement: UnfilledRequirement) {
  const labels = {
    NOT_AVAILABLE: "unavailable",
    MISSING_SKILL: "missing skill",
    OVERLAP: "overlap",
    WEEKLY_LIMIT: "weekly limit",
  } as const;

  return Object.entries(requirement.rejectionCounts)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) =>
      `${count} ${labels[reason as keyof typeof labels]}`,
    )
    .join(" · ");
}

export function SchedulePage() {
  const [employeeFilter, setEmployeeFilter] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [holidayWarning, setHolidayWarning] = useState(false);

  const [weekStart, setWeekStart] = useState(() =>
    startOfWeek(new Date()),
  );

  const [employees, setEmployees] = useState<Employee[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [editingShift, setEditingShift] = useState<Shift | null>(
    null,
  );

  const [form, setForm] = useState<ShiftForm>(() =>
    createInitialForm(),
  );

  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [preview, setPreview] = useState<SchedulePreview | null>(null);
  const [scheduleReloadKey, setScheduleReloadKey] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const days = Array.from({ length: 7 }, (_, index) =>
    addDays(weekStart, index),
  );

  const weekEnd = addDays(weekStart, 7);

  const filteredShifts = shifts.filter((shift) => {
    const matchesEmployee =
      !employeeFilter ||
      shift.employeeId === Number(employeeFilter);

    const matchesProject =
      !projectFilter ||
      shift.projectId === Number(projectFilter);

    return matchesEmployee && matchesProject;
  });

  const filteredAssignments = (preview?.assignments ?? []).filter(
    (assignment) => {
      const matchesEmployee =
        !employeeFilter ||
        assignment.employeeId === Number(employeeFilter);
      const matchesProject =
        !projectFilter ||
        assignment.projectId === Number(projectFilter);

      return matchesEmployee && matchesProject;
    },
  );

  const visiblePersistedShifts = preview?.replaceExisting
    ? []
    : filteredShifts;

  useEffect(() => {
    async function loadSchedule() {
      setIsLoading(true);
      setError(null);
      setHolidayWarning(false);

      try {
        const from = encodeURIComponent(weekStart.toISOString());
        const to = encodeURIComponent(weekEnd.toISOString());

        const holidayFrom = toDateKey(weekStart);
        const holidayTo = toDateKey(addDays(weekStart, 6));

        let holidayRequestFailed = false;

        const holidayRequest = apiRequest<Holiday[]>(
          `/holidays?from=${holidayFrom}&to=${holidayTo}`,
        ).catch((holidayError) => {
          console.warn("Holiday service unavailable:", holidayError);
          holidayRequestFailed = true;
          return [] as Holiday[];
        });

        const [
          employeeData,
          projectData,
          shiftData,
          holidayData,
        ] = await Promise.all([
          apiRequest<Employee[]>("/employees"),
          apiRequest<Project[]>("/projects"),
          apiRequest<Shift[]>(
            `/shifts?from=${from}&to=${to}`,
          ),
          holidayRequest,
        ]);

        setEmployees(employeeData);
        setProjects(projectData);
        setShifts(shiftData);
        setHolidays(holidayData);
        setHolidayWarning(holidayRequestFailed);

        setForm((currentForm) => ({
          ...currentForm,
          employeeId:
            currentForm.employeeId ||
            String(employeeData[0]?.id ?? ""),
          projectId:
            currentForm.projectId ||
            String(projectData[0]?.id ?? ""),
        }));
      } catch (loadError) {
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Failed to load schedule",
        );
      } finally {
        setIsLoading(false);
      }
    }

    void loadSchedule();
  }, [weekStart, scheduleReloadKey]);

  function resetShiftForm() {
    setForm((currentForm) => ({
      ...createInitialForm(weekStart),
      employeeId: currentForm.employeeId,
      projectId: currentForm.projectId,
    }));

    setEditingShift(null);
    setError(null);
  }

  function startEditingShift(shift: Shift) {
    setEditingShift(shift);
    setError(null);

    setForm({
      employeeId: String(shift.employeeId),
      projectId: String(shift.projectId),
      startAt: toLocalInputValue(new Date(shift.startAt)),
      endAt: toLocalInputValue(new Date(shift.endAt)),
      note: shift.note ?? "",
    });

    window.scrollTo({
      top: 0,
      behavior: "smooth",
    });
  }

  function belongsToVisibleWeek(shift: Shift) {
    return (
      new Date(shift.endAt) > weekStart &&
      new Date(shift.startAt) < weekEnd
    );
  }

  function changeWeek(amount: number) {
    const nextWeek = addDays(weekStart, amount);

    setWeekStart(nextWeek);
    setEditingShift(null);
    setError(null);
    setPreview(null);

    setForm((currentForm) => ({
      ...createInitialForm(nextWeek),
      employeeId: currentForm.employeeId,
      projectId: currentForm.projectId,
    }));
  }

  function goToCurrentWeek() {
    const now = new Date();

    setWeekStart(startOfWeek(now));
    setEditingShift(null);
    setError(null);
    setPreview(null);

    setForm((currentForm) => ({
      ...createInitialForm(now),
      employeeId: currentForm.employeeId,
      projectId: currentForm.projectId,
    }));
  }

  async function handleSubmit(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const shift = await apiRequest<Shift>(
        editingShift
          ? `/shifts/${editingShift.id}`
          : "/shifts",
        {
          method: editingShift ? "PATCH" : "POST",
          body: JSON.stringify({
            employeeId: Number(form.employeeId),
            projectId: Number(form.projectId),
            startAt: new Date(form.startAt).toISOString(),
            endAt: new Date(form.endAt).toISOString(),
            note: form.note.trim()
              ? form.note.trim()
              : editingShift
                ? null
                : undefined,
          }),
        },
      );

      setShifts((currentShifts) => {
        const withoutSavedShift = currentShifts.filter(
          (currentShift) => currentShift.id !== shift.id,
        );

        if (!belongsToVisibleWeek(shift)) {
          return withoutSavedShift;
        }

        return [...withoutSavedShift, shift].sort(
          (first, second) =>
            new Date(first.startAt).getTime() -
            new Date(second.startAt).getTime(),
        );
      });

      resetShiftForm();
      setPreview(null);
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Failed to save shift",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleDeleteShift() {
    if (!editingShift) {
      return;
    }

    const confirmed = window.confirm(
      `Delete the shift for ${editingShift.employee.name}?`,
    );

    if (!confirmed) {
      return;
    }

    setError(null);
    setIsSubmitting(true);

    try {
      await apiRequest<void>(`/shifts/${editingShift.id}`, {
        method: "DELETE",
      });

      setShifts((currentShifts) =>
        currentShifts.filter(
          (shift) => shift.id !== editingShift.id,
        ),
      );

      resetShiftForm();
      setPreview(null);
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "Failed to delete shift",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleGenerateSchedule() {
    setError(null);
    setIsGenerating(true);
    setEditingShift(null);

    try {
      const generatedPreview = await apiRequest<SchedulePreview>(
        "/schedule/generate",
        {
          method: "POST",
          body: JSON.stringify({
            weekStart: toDateKey(weekStart),
            replaceExisting,
          }),
        },
      );

      setPreview(generatedPreview);
    } catch (generateError) {
      setError(
        generateError instanceof Error
          ? generateError.message
          : "Failed to generate schedule",
      );
    } finally {
      setIsGenerating(false);
    }
  }

  async function handleApplySchedule() {
    if (!preview) {
      return;
    }

    setError(null);
    setIsApplying(true);

    try {
      await apiRequest<AppliedSchedule>("/schedule/apply", {
        method: "POST",
        body: JSON.stringify({
          weekStart: preview.weekStart,
          replaceExisting: preview.replaceExisting,
          previewId: preview.previewId,
          inputVersion: preview.inputVersion,
        }),
      });

      setPreview(null);
      setScheduleReloadKey((current) => current + 1);
    } catch (applyError) {
      setError(
        applyError instanceof Error
          ? applyError.message
          : "Failed to apply schedule",
      );
    } finally {
      setIsApplying(false);
    }
  }

  function assignmentEmployee(assignment: ProposedAssignment) {
    return employees.find((employee) => employee.id === assignment.employeeId);
  }

  function assignmentProject(assignment: ProposedAssignment) {
    return projects.find((project) => project.id === assignment.projectId);
  }

  return (
    <section>
      <div className="page-header schedule-header">
        <div>
          <h2>Schedule</h2>
          <p>
            Plan employee assignments and prevent overlapping
            shifts.
          </p>
        </div>

        <div className="week-navigation">
          <button
            type="button"
            aria-label="Previous week"
            onClick={() => changeWeek(-7)}
          >
            ←
          </button>

          <strong>
            {weekStart.toLocaleDateString("en-GB", {
              day: "numeric",
              month: "short",
            })}
            {" – "}
            {addDays(weekStart, 6).toLocaleDateString("en-GB", {
              day: "numeric",
              month: "short",
              year: "numeric",
            })}
          </strong>

          <button
            type="button"
            aria-label="Next week"
            onClick={() => changeWeek(7)}
          >
            →
          </button>

          <button
            type="button"
            className="today-button"
            onClick={goToCurrentWeek}
          >
            Today
          </button>
        </div>
      </div>

      {editingShift && (
        <div className="editing-notice">
          <div>
            <strong>Editing shift</strong>
            <span>
              {editingShift.employee.name} ·{" "}
              {editingShift.project.name}
            </span>
          </div>

          <button
            type="button"
            className="secondary-button"
            onClick={resetShiftForm}
          >
            Cancel editing
          </button>
        </div>
      )}

      <form className="panel shift-form" onSubmit={handleSubmit}>
        <label>
          Employee
          <select
            value={form.employeeId}
            required
            onChange={(event) =>
              setForm({
                ...form,
                employeeId: event.target.value,
              })
            }
          >
            <option value="">Select employee</option>

            {employees.map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.name}
              </option>
            ))}
          </select>
        </label>

        <label>
          Project
          <select
            value={form.projectId}
            required
            onChange={(event) =>
              setForm({
                ...form,
                projectId: event.target.value,
              })
            }
          >
            <option value="">Select project</option>

            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>

        <label>
          Start
          <input
            type="datetime-local"
            value={form.startAt}
            required
            onChange={(event) =>
              setForm({
                ...form,
                startAt: event.target.value,
              })
            }
          />
        </label>

        <label>
          End
          <input
            type="datetime-local"
            value={form.endAt}
            required
            onChange={(event) =>
              setForm({
                ...form,
                endAt: event.target.value,
              })
            }
          />
        </label>

        <label>
          Note
          <input
            type="text"
            value={form.note}
            placeholder="Optional"
            maxLength={500}
            onChange={(event) =>
              setForm({
                ...form,
                note: event.target.value,
              })
            }
          />
        </label>

        <div className="shift-form-actions">
          {editingShift && (
            <button
              className="danger-button"
              type="button"
              disabled={isSubmitting}
              onClick={handleDeleteShift}
            >
              Delete
            </button>
          )}

          <button
            className="primary-button shift-submit"
            disabled={
              isSubmitting ||
              employees.length === 0 ||
              projects.length === 0
            }
          >
            {isSubmitting
              ? "Saving…"
              : editingShift
                ? "Save changes"
                : "Create shift"}
          </button>
        </div>
      </form>

      {error && (
        <div className="error-message schedule-error">
          {error}
        </div>
      )}

      <div className="panel schedule-generator">
        <div className="generator-heading">
          <div>
            <span className="generator-eyebrow">Constraint solver</span>
            <h3>Generate weekly schedule</h3>
            <p>
              Assign employees by availability, skills, project priority,
              and weekly hour limits.
            </p>
          </div>

          <div className="generator-controls">
            <label className="replace-toggle">
              <input
                type="checkbox"
                checked={replaceExisting}
                disabled={isGenerating || isApplying}
                onChange={(event) => {
                  setReplaceExisting(event.target.checked);
                  setPreview(null);
                }}
              />
              Replace existing shifts
            </label>

            <button
              type="button"
              className="primary-button"
              disabled={isGenerating || isApplying || isLoading}
              onClick={handleGenerateSchedule}
            >
              {isGenerating ? "Optimizing…" : "Generate schedule"}
            </button>
          </div>
        </div>

        {preview && (
          <div className="schedule-preview-summary">
            <div className="preview-metrics">
              <div>
                <span>Coverage</span>
                <strong>{preview.metrics.coveragePercent}%</strong>
              </div>
              <div>
                <span>Assigned</span>
                <strong>
                  {preview.metrics.assignedPositions}/
                  {preview.metrics.requestedPositions}
                </strong>
              </div>
              <div>
                <span>Hours</span>
                <strong>
                  {(preview.metrics.assignedMinutes / 60).toFixed(1)}
                </strong>
              </div>
              <div>
                <span>Conflicts</span>
                <strong>{preview.metrics.hardConflicts}</strong>
              </div>
            </div>

            {preview.unfilledRequirements.length > 0 && (
              <div className="unfilled-requirements">
                <strong>
                  {preview.unfilledRequirements.length} unfilled position
                  {preview.unfilledRequirements.length === 1 ? "" : "s"}
                </strong>

                {preview.unfilledRequirements.map((requirement) => {
                  const project = projects.find(
                    (item) => item.id === requirement.projectId,
                  );

                  return (
                    <div
                      className="unfilled-item"
                      key={`${requirement.requirementId}-${requirement.positionIndex}`}
                    >
                      <span className={`priority-badge ${requirement.priority.toLowerCase()}`}>
                        {requirement.priority}
                      </span>
                      <div>
                        <strong>{project?.name ?? "Unknown project"}</strong>
                        <span>
                          {requirement.dayOfWeek.toLowerCase()} ·{" "}
                          {formatMinutes(requirement.startMinute)}–
                          {formatMinutes(requirement.endMinute)}
                        </span>
                        <small>{describeRejections(requirement)}</small>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="preview-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={isApplying}
                onClick={() => setPreview(null)}
              >
                Discard
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={isApplying}
                onClick={handleApplySchedule}
              >
                {isApplying ? "Applying…" : "Apply schedule"}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="schedule-toolbar">
        <div className="schedule-filters">
          <label>
            Employee
            <select
              value={employeeFilter}
              onChange={(event) =>
                setEmployeeFilter(event.target.value)
              }
            >
              <option value="">All employees</option>

              {employees.map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {employee.name}
                </option>
              ))}
            </select>
          </label>

          <label>
            Project
            <select
              value={projectFilter}
              onChange={(event) =>
                setProjectFilter(event.target.value)
              }
            >
              <option value="">All projects</option>

              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>

          {(employeeFilter || projectFilter) && (
            <button
              type="button"
              className="clear-filters"
              onClick={() => {
                setEmployeeFilter("");
                setProjectFilter("");
              }}
            >
              Clear filters
            </button>
          )}
        </div>

        <span className="visible-shifts-count">
         {visiblePersistedShifts.length + filteredAssignments.length}{" "}
         {visiblePersistedShifts.length + filteredAssignments.length === 1
           ? "visible shift"
           : "visible shifts"}
        </span>
      </div>

      {holidayWarning && (
        <div className="warning-message">
          Public holidays are temporarily unavailable. Shifts are
          still displayed.
        </div>
      )}

      {isLoading ? (
        <p className="muted-text">Loading schedule…</p>
      ) : (
        <div className="calendar">
          {days.map((day) => {
            const dayShifts = visiblePersistedShifts.filter((shift) => {
              const shiftDate = new Date(shift.startAt);

              return (
                shiftDate.getFullYear() === day.getFullYear() &&
                shiftDate.getMonth() === day.getMonth() &&
                shiftDate.getDate() === day.getDate()
              );
            });

            const dayAssignments = filteredAssignments.filter((assignment) => {
              const assignmentDate = new Date(assignment.startAt);

              return (
                assignmentDate.getFullYear() === day.getFullYear() &&
                assignmentDate.getMonth() === day.getMonth() &&
                assignmentDate.getDate() === day.getDate()
              );
            });

            const dayHolidays = holidays.filter(
              (holiday) =>
                holiday.date === toDateKey(day) &&
                holiday.nationwide,
            );

            const isToday =
              day.toDateString() === new Date().toDateString();

            return (
              <div
                className="calendar-day"
                key={day.toISOString()}
              >
                <header className={isToday ? "today" : undefined}>
                  <span>
                    {day.toLocaleDateString("en-GB", {
                      weekday: "short",
                    })}
                  </span>

                  <strong>{day.getDate()}</strong>
                </header>

                {dayHolidays.map((holiday) => (
                  <div
                    className="holiday-label"
                    key={holiday.id}
                  >
                    <span>Public holiday</span>
                    <strong>{holiday.name}</strong>
                  </div>
                ))}

                <div className="day-shifts">
                  {dayShifts.length === 0 && dayAssignments.length === 0 && (
                    <span className="no-shifts">No shifts</span>
                  )}

                  {dayShifts.map((shift) => (
                    <button
                      className="shift-card"
                      key={shift.id}
                      type="button"
                      title="Edit shift"
                      style={{
                        borderLeftColor: shift.project.color,
                      }}
                      onClick={() => startEditingShift(shift)}
                    >
                      <strong>{shift.project.name}</strong>

                      <span>
                        {formatTime(shift.startAt)}
                        {" – "}
                        {formatTime(shift.endAt)}
                      </span>

                      <p>{shift.employee.name}</p>

                      {shift.note && <small>{shift.note}</small>}
                    </button>
                  ))}

                  {dayAssignments.map((assignment) => {
                    const employee = assignmentEmployee(assignment);
                    const project = assignmentProject(assignment);

                    return (
                      <div
                        className="shift-card proposed-shift"
                        key={`preview-${assignment.requirementId}-${assignment.positionIndex}`}
                        style={{
                          borderLeftColor: project?.color ?? "#5267df",
                        }}
                      >
                        <small className="preview-label">Proposed</small>
                        <strong>{project?.name ?? "Unknown project"}</strong>
                        <span>
                          {formatTime(assignment.startAt)}
                          {" – "}
                          {formatTime(assignment.endAt)}
                        </span>
                        <p>{employee?.name ?? "Unknown employee"}</p>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
