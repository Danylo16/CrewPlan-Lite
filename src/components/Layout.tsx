import { NavLink, Outlet } from "react-router-dom";

export function Layout() {
  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div>
          <h1>CrewPlan</h1>
          <p>Portfolio capacity planning</p>
        </div>

        <nav>
          <NavLink to="/" end>Portfolio plan</NavLink>
          <NavLink to="/allocations">Allocation calendar</NavLink>
          <NavLink to="/employees">Employees</NavLink>
          <NavLink to="/projects">Projects</NavLink>
        </nav>
      </aside>

      <main className="main-content">
        <Outlet />
      </main>
    </div>
  );
}
