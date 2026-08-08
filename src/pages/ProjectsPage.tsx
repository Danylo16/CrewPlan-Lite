import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { apiRequest } from "../api/client";
import type {
  DeadlineType,
  OptimizationStrategy,
  ProjectPriority,
  ProjectWithCount,
} from "../types";

interface ProjectForm {
  name: string;
  color: string;
  startDate: string;
  targetEndDate: string;
  deadlineType: DeadlineType;
  priority: ProjectPriority;
  optimizationStrategy: OptimizationStrategy;
  totalBudget: string;
  weeklyBudget: string;
}

const emptyForm: ProjectForm = {
  name: "",
  color: "#5267DF",
  startDate: "",
  targetEndDate: "",
  deadlineType: "NONE",
  priority: "NORMAL",
  optimizationStrategy: "BALANCED",
  totalBudget: "",
  weeklyBudget: "",
};

function cents(value: string) {
  return value === "" ? null : Math.round(Number(value) * 100);
}

function projectForm(project: ProjectWithCount): ProjectForm {
  return {
    name: project.name,
    color: project.color,
    startDate: project.startDate?.slice(0, 10) ?? "",
    targetEndDate: project.targetEndDate?.slice(0, 10) ?? "",
    deadlineType: project.deadlineType,
    priority: project.priority,
    optimizationStrategy: project.optimizationStrategy,
    totalBudget: project.totalLaborBudgetCents === null
      ? ""
      : String(project.totalLaborBudgetCents / 100),
    weeklyBudget: project.weeklyLaborBudgetCents === null
      ? ""
      : String(project.weeklyLaborBudgetCents / 100),
  };
}

export function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectWithCount[]>([]);
  const [form, setForm] = useState<ProjectForm>(emptyForm);
  const [editingProject, setEditingProject] = useState<ProjectWithCount | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadProjects() {
    try {
      setProjects(await apiRequest<ProjectWithCount[]>("/projects"));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load projects");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadProjects(); }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  function openCreate() {
    setEditingProject(null);
    setForm(emptyForm);
    setError(null);
    setIsModalOpen(true);
  }

  function openEdit(project: ProjectWithCount) {
    setEditingProject(project);
    setForm(projectForm(project));
    setError(null);
    setIsModalOpen(true);
  }

  async function submitProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);
    try {
      const project = await apiRequest<ProjectWithCount>(
        editingProject ? `/projects/${editingProject.id}` : "/projects",
        {
          method: editingProject ? "PATCH" : "POST",
          body: JSON.stringify({
            name: form.name,
            color: form.color,
            startDate: form.startDate || null,
            targetEndDate: form.deadlineType === "NONE"
              ? null
              : form.targetEndDate || null,
            deadlineType: form.deadlineType,
            priority: form.priority,
            optimizationStrategy: form.optimizationStrategy,
            totalLaborBudgetCents: cents(form.totalBudget),
            weeklyLaborBudgetCents: cents(form.weeklyBudget),
          }),
        },
      );
      setProjects((current) => editingProject
        ? current.map((item) => item.id === project.id ? project : item)
        : [project, ...current]);
      setIsModalOpen(false);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Failed to save project");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function deleteProject(project: ProjectWithCount) {
    if (!window.confirm(`Delete draft project “${project.name}”?`)) return;
    try {
      await apiRequest<void>(`/projects/${project.id}`, { method: "DELETE" });
      setProjects((current) => current.filter((item) => item.id !== project.id));
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Failed to delete project");
    }
  }

  const activeProjects = projects.filter((project) => project.status === "ACTIVE").length;
  const totalRemainingMinutes = projects.reduce(
    (total, project) => total + project.workPackageCount,
    0,
  );

  return <section>
    <div className="page-header projects-header">
      <div>
        <h2>Project portfolio</h2>
        <p>Control scope, deadlines, budgets and delivery capacity.</p>
      </div>
      <button className="primary-button" type="button" onClick={openCreate}>+ New project</button>
    </div>

    <div className="project-stats">
      <div className="stat-card"><span>Active</span><strong>{activeProjects}</strong></div>
      <div className="stat-card"><span>Total projects</span><strong>{projects.length}</strong></div>
      <div className="stat-card"><span>Work packages</span><strong>{totalRemainingMinutes}</strong></div>
    </div>
    {error && !isModalOpen && <div className="error-message">{error}</div>}
    {isLoading ? <p className="muted-text">Loading portfolio…</p> :
      <div className="projects-grid">
        {projects.map((project) => <article className="project-tile portfolio-card" key={project.id}>
          <div className="project-tile-accent" style={{ backgroundColor: project.color }} />
          <div className="project-tile-header">
            <span className={`status-badge ${project.status.toLowerCase()}`}>{project.status}</span>
            <span className={`priority-badge ${project.priority.toLowerCase()}`}>{project.priority}</span>
          </div>
          <div className="project-tile-content">
            <h3>{project.name}</h3>
            <p>{project.workPackageCount} work packages · {project.shiftCount} allocations</p>
            <p>{project.startDate ? `Starts ${new Date(project.startDate).toLocaleDateString()}` : "Start date not set"}</p>
            <p>{project.targetEndDate ? `${project.deadlineType} deadline ${new Date(project.targetEndDate).toLocaleDateString()}` : "No deadline"}</p>
            <p>{project.totalLaborBudgetCents === null ? "No total budget" : `€${(project.totalLaborBudgetCents / 100).toLocaleString()} total budget`}</p>
          </div>
          <div className="card-actions">
            <Link className="primary-button button-link" to={`/projects/${project.id}`}>Open</Link>
            <button className="secondary-button" type="button" onClick={() => openEdit(project)}>Edit</button>
            {project.status === "DRAFT" && <button className="danger-button" type="button" onClick={() => void deleteProject(project)}>Delete</button>}
          </div>
        </article>)}
      </div>}

    {isModalOpen && <div className="modal-backdrop" role="presentation" onMouseDown={() => setIsModalOpen(false)}>
      <div className="project-modal portfolio-modal" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div><h3>{editingProject ? "Edit project" : "Create project"}</h3><p>Business constraints used by portfolio planning.</p></div>
          <button className="modal-close" type="button" onClick={() => setIsModalOpen(false)}>×</button>
        </div>
        <form className="modal-form" onSubmit={submitProject}>
          <div className="form-row two-columns">
            <label>Project name<input required minLength={2} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
            <label>Color<input type="color" value={form.color} onChange={(event) => setForm({ ...form, color: event.target.value.toUpperCase() })} /></label>
          </div>
          <div className="form-row three-columns">
            <label>Start date<input type="date" value={form.startDate} onChange={(event) => setForm({ ...form, startDate: event.target.value })} /></label>
            <label>Deadline type<select value={form.deadlineType} onChange={(event) => setForm({ ...form, deadlineType: event.target.value as DeadlineType, targetEndDate: event.target.value === "NONE" ? "" : form.targetEndDate })}><option>NONE</option><option>SOFT</option><option>HARD</option></select></label>
            <label>Target end<input type="date" disabled={form.deadlineType === "NONE"} required={form.deadlineType !== "NONE"} value={form.targetEndDate} onChange={(event) => setForm({ ...form, targetEndDate: event.target.value })} /></label>
          </div>
          <div className="form-row two-columns">
            <label>Priority<select value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value as ProjectPriority })}>{["LOW", "NORMAL", "HIGH", "CRITICAL"].map((value) => <option key={value}>{value}</option>)}</select></label>
            <label>Optimization<select value={form.optimizationStrategy} onChange={(event) => setForm({ ...form, optimizationStrategy: event.target.value as OptimizationStrategy })}><option value="BALANCED">Balanced</option><option value="EARLIEST_COMPLETION">Earliest completion</option><option value="MINIMIZE_COST">Minimize cost</option><option value="MAXIMIZE_THROUGHPUT">Maximize throughput</option></select></label>
          </div>
          <div className="form-row two-columns">
            <label>Total labor budget (€)<input type="number" min="0" step="0.01" value={form.totalBudget} onChange={(event) => setForm({ ...form, totalBudget: event.target.value })} /></label>
            <label>Weekly burn cap (€)<input type="number" min="0" step="0.01" value={form.weeklyBudget} onChange={(event) => setForm({ ...form, weeklyBudget: event.target.value })} /></label>
          </div>
          {error && <div className="error-message">{error}</div>}
          <div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setIsModalOpen(false)}>Cancel</button><button className="primary-button" disabled={isSubmitting}>{isSubmitting ? "Saving…" : "Save project"}</button></div>
        </form>
      </div>
    </div>}
  </section>;
}
