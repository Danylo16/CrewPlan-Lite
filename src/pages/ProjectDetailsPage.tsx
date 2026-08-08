import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { apiRequest } from "../api/client";
import type {
  Employee,
  FixedCoverageRequirement,
  ProjectDetails,
  ProjectStatus,
  Skill,
  WorkLog,
  WorkPackage,
} from "../types";

interface WorkPackageForm {
  name: string;
  description: string;
  requiredSkillId: string;
  minimumSkillLevel: number;
  estimatedHours: string;
  maxParallelEmployees: number;
  earliestStartDate: string;
  targetEndDate: string;
  predecessorIds: number[];
}

interface WorkLogForm {
  employeeId: string;
  workPackageId: string;
  startedAt: string;
  endedAt: string;
  note: string;
}

interface CoverageForm {
  dayOfWeek: string;
  startTime: string;
  endTime: string;
  requiredEmployees: number;
  requiredSkillId: string;
  minimumSkillLevel: number;
  priority: string;
}

const emptyPackage: WorkPackageForm = {
  name: "",
  description: "",
  requiredSkillId: "",
  minimumSkillLevel: 1,
  estimatedHours: "8",
  maxParallelEmployees: 1,
  earliestStartDate: "",
  targetEndDate: "",
  predecessorIds: [],
};

function localDateTime(offsetHours = 0) {
  const date = new Date(Date.now() + offsetHours * 3_600_000);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

const emptyLog = (): WorkLogForm => ({
  employeeId: "",
  workPackageId: "",
  startedAt: localDateTime(-1),
  endedAt: localDateTime(),
  note: "",
});

const emptyCoverage: CoverageForm = { dayOfWeek: "MONDAY", startTime: "09:00", endTime: "17:00", requiredEmployees: 1, requiredSkillId: "", minimumSkillLevel: 1, priority: "NORMAL" };

function minuteOfDay(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function clockTime(minutes: number) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

const transitions: Record<ProjectStatus, ProjectStatus[]> = {
  DRAFT: ["PLANNED", "CANCELLED"],
  PLANNED: ["DRAFT", "ACTIVE", "CANCELLED"],
  ACTIVE: ["ON_HOLD", "COMPLETED", "CANCELLED"],
  ON_HOLD: ["ACTIVE", "COMPLETED", "CANCELLED"],
  COMPLETED: ["ARCHIVED"],
  CANCELLED: ["ARCHIVED"],
  ARCHIVED: [],
};

function hours(minutes: number) {
  return `${Math.round((minutes / 60) * 10) / 10}h`;
}

export function ProjectDetailsPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const projectId = Number(id);
  const [project, setProject] = useState<ProjectDetails | null>(null);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [workLogs, setWorkLogs] = useState<WorkLog[]>([]);
  const [coverage, setCoverage] = useState<FixedCoverageRequirement[]>([]);
  const [packageForm, setPackageForm] = useState<WorkPackageForm>(emptyPackage);
  const [logForm, setLogForm] = useState<WorkLogForm>(emptyLog);
  const [coverageForm, setCoverageForm] = useState<CoverageForm>(emptyCoverage);
  const [showPackageForm, setShowPackageForm] = useState(false);
  const [showLogForm, setShowLogForm] = useState(false);
  const [showCoverageForm, setShowCoverageForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const loadData = useCallback(async () => {
    if (!Number.isInteger(projectId)) return;
    try {
      const [projectData, skillData, employeeData, logData, coverageData] = await Promise.all([
        apiRequest<ProjectDetails>(`/projects/${projectId}`),
        apiRequest<Skill[]>("/skills"),
        apiRequest<Employee[]>("/employees"),
        apiRequest<WorkLog[]>(`/work-logs?projectId=${projectId}`),
        apiRequest<FixedCoverageRequirement[]>(`/project-requirements?projectId=${projectId}`),
      ]);
      setProject(projectData);
      setSkills(skillData);
      setEmployees(employeeData);
      setWorkLogs(logData);
      setCoverage(coverageData);
      setLogForm((current) => ({
        ...current,
        employeeId: current.employeeId || String(employeeData[0]?.id ?? ""),
        workPackageId: current.workPackageId || String(projectData.workPackages[0]?.id ?? ""),
      }));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load project");
    }
  }, [projectId]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadData(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadData]);

  async function createCoverage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsBusy(true);
    setError(null);
    try {
      await apiRequest("/project-requirements", { method: "POST", body: JSON.stringify({ projectId, dayOfWeek: coverageForm.dayOfWeek, startMinute: minuteOfDay(coverageForm.startTime), endMinute: minuteOfDay(coverageForm.endTime), requiredEmployees: coverageForm.requiredEmployees, requiredSkillId: coverageForm.requiredSkillId ? Number(coverageForm.requiredSkillId) : null, minimumSkillLevel: coverageForm.requiredSkillId ? coverageForm.minimumSkillLevel : 1, priority: coverageForm.priority }) });
      setCoverageForm(emptyCoverage);
      setShowCoverageForm(false);
      await loadData();
    } catch (coverageError) {
      setError(coverageError instanceof Error ? coverageError.message : "Failed to create fixed coverage");
    } finally { setIsBusy(false); }
  }

  async function deleteCoverage(requirement: FixedCoverageRequirement) {
    if (!window.confirm("Delete this fixed coverage requirement?")) return;
    try {
      await apiRequest<void>(`/project-requirements/${requirement.id}`, { method: "DELETE" });
      await loadData();
    } catch (coverageError) { setError(coverageError instanceof Error ? coverageError.message : "Failed to delete fixed coverage"); }
  }

  async function transition(status: ProjectStatus) {
    setIsBusy(true);
    setError(null);
    try {
      await apiRequest(`/projects/${projectId}/transition`, {
        method: "POST",
        body: JSON.stringify({ status }),
      });
      await loadData();
      if (status === "ARCHIVED") navigate("/projects");
    } catch (transitionError) {
      setError(transitionError instanceof Error ? transitionError.message : "Transition failed");
    } finally {
      setIsBusy(false);
    }
  }

  async function createWorkPackage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsBusy(true);
    setError(null);
    try {
      const workPackage = await apiRequest<WorkPackage>(`/projects/${projectId}/work-packages`, {
        method: "POST",
        body: JSON.stringify({
          name: packageForm.name,
          description: packageForm.description || null,
          requiredSkillId: Number(packageForm.requiredSkillId),
          minimumSkillLevel: packageForm.minimumSkillLevel,
          estimatedMinutes: Math.round(Number(packageForm.estimatedHours) * 60),
          maxParallelEmployees: packageForm.maxParallelEmployees,
          earliestStartDate: packageForm.earliestStartDate || null,
          targetEndDate: packageForm.targetEndDate || null,
        }),
      });
      if (packageForm.predecessorIds.length > 0) {
        await apiRequest(`/work-packages/${workPackage.id}/dependencies`, {
          method: "PUT",
          body: JSON.stringify({
            predecessors: packageForm.predecessorIds.map((workPackageId) => ({
              workPackageId,
              lagMinutes: 0,
            })),
          }),
        });
      }
      setPackageForm(emptyPackage);
      setShowPackageForm(false);
      await loadData();
    } catch (packageError) {
      setError(packageError instanceof Error ? packageError.message : "Failed to create work package");
    } finally {
      setIsBusy(false);
    }
  }

  async function updatePackage(workPackage: WorkPackage, data: Record<string, unknown>) {
    setIsBusy(true);
    setError(null);
    try {
      await apiRequest(`/work-packages/${workPackage.id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      });
      await loadData();
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "Failed to update work package");
    } finally {
      setIsBusy(false);
    }
  }

  async function deletePackage(workPackage: WorkPackage) {
    if (!window.confirm(`Delete work package “${workPackage.name}”?`)) return;
    try {
      await apiRequest<void>(`/work-packages/${workPackage.id}`, { method: "DELETE" });
      await loadData();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Failed to delete work package");
    }
  }

  async function recordWork(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsBusy(true);
    setError(null);
    try {
      const draft = await apiRequest<WorkLog>("/work-logs", {
        method: "POST",
        body: JSON.stringify({
          employeeId: Number(logForm.employeeId),
          projectId,
          workPackageId: Number(logForm.workPackageId),
          startedAt: new Date(logForm.startedAt).toISOString(),
          endedAt: new Date(logForm.endedAt).toISOString(),
          note: logForm.note || null,
        }),
      });
      await apiRequest(`/work-logs/${draft.id}/confirm`, { method: "POST" });
      setLogForm(emptyLog());
      setShowLogForm(false);
      await loadData();
    } catch (logError) {
      setError(logError instanceof Error ? logError.message : "Failed to record actual work");
    } finally {
      setIsBusy(false);
    }
  }

  async function voidLog(workLog: WorkLog) {
    if (!window.confirm("Void this confirmed work log?")) return;
    try {
      await apiRequest(`/work-logs/${workLog.id}/void`, { method: "POST" });
      await loadData();
    } catch (voidError) {
      setError(voidError instanceof Error ? voidError.message : "Failed to void work log");
    }
  }

  if (!project) return <section><Link to="/projects">← Portfolio</Link>{error ? <div className="error-message">{error}</div> : <p className="muted-text">Loading project…</p>}</section>;

  return <section>
    <div className="page-header project-detail-header">
      <div>
        <Link className="back-link" to="/projects">← Project portfolio</Link>
        <div className="title-with-status"><h2>{project.name}</h2><span className={`status-badge ${project.status.toLowerCase()}`}>{project.status}</span></div>
        <p>{project.optimizationStrategy.replaceAll("_", " ")} · {project.priority} priority</p>
      </div>
      <div className="card-actions">
        {transitions[project.status].map((status) => <button className={status === "CANCELLED" || status === "ARCHIVED" ? "danger-button" : "secondary-button"} disabled={isBusy} key={status} type="button" onClick={() => void transition(status)}>{status.replaceAll("_", " ")}</button>)}
      </div>
    </div>
    {error && <div className="error-message portfolio-error">{error}</div>}

    <div className="portfolio-metrics">
      <div><span>Progress</span><strong>{project.progress.completionPercent}%</strong><small>{hours(project.progress.completedMinutes)} completed</small></div>
      <div><span>Remaining scope</span><strong>{hours(project.progress.remainingMinutes)}</strong><small>{hours(project.progress.forecastMinutes)} forecast total</small></div>
      <div><span>Actual cost</span><strong>€{(project.progress.actualCostCents / 100).toLocaleString()}</strong><small>{project.totalLaborBudgetCents === null ? "No budget" : `of €${(project.totalLaborBudgetCents / 100).toLocaleString()}`}</small></div>
      <div><span>Deadline</span><strong>{project.targetEndDate ? new Date(project.targetEndDate).toLocaleDateString() : "None"}</strong><small>{project.deadlineType}</small></div>
    </div>

    <div className="portfolio-section-heading"><div><h3>Work packages</h3><p>Scope, dependencies, skill demand and parallelism.</p></div><button className="primary-button" type="button" onClick={() => setShowPackageForm((value) => !value)}>+ Work package</button></div>
    {showPackageForm && <form className="panel portfolio-form" onSubmit={createWorkPackage}>
      <div className="form-row two-columns"><label>Name<input required minLength={2} value={packageForm.name} onChange={(event) => setPackageForm({ ...packageForm, name: event.target.value })} /></label><label>Required skill<select required value={packageForm.requiredSkillId} onChange={(event) => setPackageForm({ ...packageForm, requiredSkillId: event.target.value })}><option value="">Select skill</option>{skills.map((skill) => <option key={skill.id} value={skill.id}>{skill.name}</option>)}</select></label></div>
      <label>Description<textarea value={packageForm.description} onChange={(event) => setPackageForm({ ...packageForm, description: event.target.value })} /></label>
      <div className="form-row three-columns"><label>Estimated hours<input required type="number" min="0.5" step="0.5" value={packageForm.estimatedHours} onChange={(event) => setPackageForm({ ...packageForm, estimatedHours: event.target.value })} /></label><label>Minimum level<select value={packageForm.minimumSkillLevel} onChange={(event) => setPackageForm({ ...packageForm, minimumSkillLevel: Number(event.target.value) })}>{[1,2,3,4,5].map((level) => <option key={level} value={level}>L{level}+</option>)}</select></label><label>Parallel employees<input type="number" min="1" max="20" value={packageForm.maxParallelEmployees} onChange={(event) => setPackageForm({ ...packageForm, maxParallelEmployees: Number(event.target.value) })} /></label></div>
      <div className="form-row two-columns"><label>Earliest start<input type="date" value={packageForm.earliestStartDate} onChange={(event) => setPackageForm({ ...packageForm, earliestStartDate: event.target.value })} /></label><label>Target end<input type="date" value={packageForm.targetEndDate} onChange={(event) => setPackageForm({ ...packageForm, targetEndDate: event.target.value })} /></label></div>
      {project.workPackages.length > 0 && <fieldset className="dependency-picker"><legend>Depends on</legend>{project.workPackages.map((item) => <label key={item.id}><input type="checkbox" checked={packageForm.predecessorIds.includes(item.id)} onChange={(event) => setPackageForm({ ...packageForm, predecessorIds: event.target.checked ? [...packageForm.predecessorIds, item.id] : packageForm.predecessorIds.filter((id) => id !== item.id) })} />{item.name}</label>)}</fieldset>}
      <div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setShowPackageForm(false)}>Cancel</button><button className="primary-button" disabled={isBusy}>Create package</button></div>
    </form>}

    <div className="work-package-grid">{project.workPackages.map((workPackage) => {
      const progress = workPackage.completedMinutes + workPackage.remainingMinutes === 0 ? 0 : Math.round((workPackage.completedMinutes / (workPackage.completedMinutes + workPackage.remainingMinutes)) * 100);
      return <article className="panel work-package-card" key={workPackage.id}>
        <div className="work-package-header"><div><span className={`status-badge ${workPackage.status.toLowerCase()}`}>{workPackage.status}</span><h4>{workPackage.name}</h4></div><strong>{progress}%</strong></div>
        <div className="progress-track"><span style={{ width: `${progress}%` }} /></div>
        <p>{workPackage.description || "No description"}</p>
        <div className="package-facts"><span>{workPackage.requiredSkill.name} · L{workPackage.minimumSkillLevel}+</span><span>{hours(workPackage.completedMinutes)} / {hours(workPackage.estimatedMinutes)} baseline</span><span>{hours(workPackage.remainingMinutes)} remaining</span><span>Up to {workPackage.maxParallelEmployees} parallel</span></div>
        {workPackage.incomingDependencies.length > 0 && <p className="dependency-text">Depends on {workPackage.incomingDependencies.map((dependency) => project.workPackages.find((item) => item.id === dependency.predecessorId)?.name).filter(Boolean).join(", ")}</p>}
        <div className="card-actions">{workPackage.status === "TODO" && <button className="secondary-button" type="button" onClick={() => void updatePackage(workPackage, { status: "IN_PROGRESS" })}>Start</button>}{workPackage.remainingMinutes === 0 && workPackage.status !== "COMPLETED" && <button className="secondary-button" type="button" onClick={() => void updatePackage(workPackage, { status: "COMPLETED" })}>Complete</button>}<button className="danger-button" type="button" onClick={() => void deletePackage(workPackage)}>Delete</button></div>
      </article>;
    })}</div>

    <div className="portfolio-section-heading"><div><h3>Fixed coverage</h3><p>Recurring day and time commitments remain separate from project scope.</p></div><button className="secondary-button" type="button" onClick={() => setShowCoverageForm((value) => !value)}>+ Coverage</button></div>
    {showCoverageForm && <form className="panel portfolio-form" onSubmit={createCoverage}>
      <div className="form-row three-columns"><label>Day<select value={coverageForm.dayOfWeek} onChange={(event) => setCoverageForm({ ...coverageForm, dayOfWeek: event.target.value })}>{["MONDAY","TUESDAY","WEDNESDAY","THURSDAY","FRIDAY","SATURDAY","SUNDAY"].map((day) => <option key={day}>{day}</option>)}</select></label><label>Start<input required type="time" value={coverageForm.startTime} onChange={(event) => setCoverageForm({ ...coverageForm, startTime: event.target.value })} /></label><label>End<input required type="time" value={coverageForm.endTime} onChange={(event) => setCoverageForm({ ...coverageForm, endTime: event.target.value })} /></label></div>
      <div className="form-row three-columns"><label>Employees<input type="number" min="1" max="100" value={coverageForm.requiredEmployees} onChange={(event) => setCoverageForm({ ...coverageForm, requiredEmployees: Number(event.target.value) })} /></label><label>Skill<select value={coverageForm.requiredSkillId} onChange={(event) => setCoverageForm({ ...coverageForm, requiredSkillId: event.target.value })}><option value="">Any skill</option>{skills.map((skill) => <option key={skill.id} value={skill.id}>{skill.name}</option>)}</select></label><label>Minimum level<select disabled={!coverageForm.requiredSkillId} value={coverageForm.minimumSkillLevel} onChange={(event) => setCoverageForm({ ...coverageForm, minimumSkillLevel: Number(event.target.value) })}>{[1,2,3,4,5].map((level) => <option key={level} value={level}>L{level}+</option>)}</select></label></div>
      <label>Priority<select value={coverageForm.priority} onChange={(event) => setCoverageForm({ ...coverageForm, priority: event.target.value })}>{["LOW","NORMAL","HIGH","CRITICAL"].map((priority) => <option key={priority}>{priority}</option>)}</select></label>
      <div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setShowCoverageForm(false)}>Cancel</button><button className="primary-button" disabled={isBusy}>Create coverage</button></div>
    </form>}
    <div className="panel coverage-list">{coverage.length === 0 ? <p className="muted-text">No fixed coverage requirements.</p> : coverage.map((requirement) => <div className="coverage-row" key={requirement.id}><div><strong>{requirement.dayOfWeek}</strong><span>{clockTime(requirement.startMinute)}–{clockTime(requirement.endMinute)}</span></div><span>{requirement.requiredEmployees} employee{requirement.requiredEmployees === 1 ? "" : "s"}</span><span>{requirement.requiredSkill ? `${requirement.requiredSkill.name} · L${requirement.minimumSkillLevel}+` : "Any skill"}</span><span className={`status-badge ${requirement.priority.toLowerCase()}`}>{requirement.priority}</span><button className="danger-button" type="button" onClick={() => void deleteCoverage(requirement)}>Delete</button></div>)}</div>

    <div className="portfolio-section-heading actuals-heading"><div><h3>Actual work</h3><p>Confirmed time drives progress and actual project cost.</p></div><button className="primary-button" disabled={project.workPackages.length === 0} type="button" onClick={() => setShowLogForm((value) => !value)}>+ Record work</button></div>
    {showLogForm && <form className="panel portfolio-form" onSubmit={recordWork}><div className="form-row two-columns"><label>Employee<select required value={logForm.employeeId} onChange={(event) => setLogForm({ ...logForm, employeeId: event.target.value })}>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label><label>Work package<select required value={logForm.workPackageId} onChange={(event) => setLogForm({ ...logForm, workPackageId: event.target.value })}>{project.workPackages.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div><div className="form-row two-columns"><label>Started<input required type="datetime-local" value={logForm.startedAt} onChange={(event) => setLogForm({ ...logForm, startedAt: event.target.value })} /></label><label>Ended<input required type="datetime-local" value={logForm.endedAt} onChange={(event) => setLogForm({ ...logForm, endedAt: event.target.value })} /></label></div><label>Note<textarea value={logForm.note} onChange={(event) => setLogForm({ ...logForm, note: event.target.value })} /></label><div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setShowLogForm(false)}>Cancel</button><button className="primary-button" disabled={isBusy}>Record and confirm</button></div></form>}
    <div className="panel actuals-table">{workLogs.length === 0 ? <p className="muted-text">No actual work recorded.</p> : workLogs.map((log) => <div className="actual-row" key={log.id}><div><strong>{log.employee.name}</strong><span>{log.workPackage.name} · {new Date(log.startedAt).toLocaleString()}</span></div><span>{hours(log.minutes)}</span><span>{log.actualCostCents === null ? "Draft" : `€${(log.actualCostCents / 100).toFixed(2)}`}</span><span className={`status-badge ${log.status.toLowerCase()}`}>{log.status}</span>{log.status === "CONFIRMED" && <button className="danger-button" type="button" onClick={() => void voidLog(log)}>Void</button>}</div>)}</div>
  </section>;
}
