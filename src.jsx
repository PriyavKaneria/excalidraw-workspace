import React, { Component, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Excalidraw } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import "./style.css";
const api = (url, options = {}) =>
  fetch(url, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    ...options,
  }).then(async (response) => {
    if (!response.ok)
      throw Error((await response.text()) || response.statusText);
    return response.json();
  });
const view = (state) => ({
  scrollX: state.scrollX,
  scrollY: state.scrollY,
  zoom: state.zoom,
  viewBackgroundColor: state.viewBackgroundColor,
  theme: state.theme,
});
class CanvasBoundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    return this.state.error ? (
      <div className="canvas-error">
        The canvas could not load. Refresh the page to retry.
      </div>
    ) : (
      this.props.children
    );
  }
}
function Login() {
  const [password, setPassword] = useState(""),
    [error, setError] = useState("");
  return (
    <main className="login">
      <div className="paper">
        <h1>りょういきてんかい</h1>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api("/api/login", {
                method: "POST",
                body: JSON.stringify({ password }),
              });
              window.location.replace("/");
            } catch {
              setError("Incorrect password");
            }
          }}
        >
          <input
            autoFocus
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button>Enter workspace →</button>
          {error && <small>{error}</small>}
        </form>
      </div>
    </main>
  );
}
function App() {
  const [auth, setAuth] = useState(null),
    [projects, setProjects] = useState([]),
    [page, setPage] = useState(null),
    [scene, setScene] = useState(null),
    [open, setOpen] = useState(true),
    [error, setError] = useState(""),
    pending = useRef(null),
    saving = useRef(false),
    timer = useRef(),
    knownFiles = useRef(new Set()),
    drag = useRef();
  const select = (next) => {
    localStorage.setItem("last-draw-page", next.id);
    knownFiles.current = new Set();
    setScene(null);
    setPage(next);
  };
  const load = async () => {
    let data = await api("/api/pages");
    setProjects(data);
    let all = data.flatMap((p) => p.pages || []),
      saved =
        all.find(
          (x) => String(x.id) === localStorage.getItem("last-draw-page"),
        ) || all[0];
    if (!page && saved) select(saved);
  };
  useEffect(() => {
    api("/api/me")
      .then(() => setAuth(true))
      .catch(() => setAuth(false));
  }, []);
  useEffect(() => {
    if (auth) load().catch(() => setError("Could not load your projects."));
  }, [auth]);
  useEffect(() => {
    if (page)
      api("/api/pages/" + page.id)
        .then((data) => {
          knownFiles.current = new Set(Object.keys(data.files || {}));
          let cached = localStorage.getItem("draw-view-" + page.id);
          if (cached && !data.view) data.view = JSON.parse(cached);
          setScene(data);
        })
        .catch(() => setError("Could not load this canvas."));
  }, [page]);
  const flush = async () => {
    if (saving.current || !pending.current) return;
    saving.current = true;
    let next = pending.current;
    pending.current = null;
    try {
      for (const file of Object.values(next.files || {}))
        if (!knownFiles.current.has(file.id)) {
          await api("/api/pages/" + page.id + "/files", {
            method: "POST",
            body: JSON.stringify({ file }),
          });
          knownFiles.current.add(file.id);
        }
      await api("/api/pages/" + page.id, {
        method: "PUT",
        body: JSON.stringify({ elements: next.elements, view: next.view }),
      });
      try {
        localStorage.setItem("draw-view-" + page.id, JSON.stringify(next.view));
      } catch {}
    } catch {
      setError("Saving failed; the latest changes will retry automatically.");
      pending.current = next;
    } finally {
      saving.current = false;
      if (pending.current) flush();
    }
  };
  const queue = (elements, state, files) => {
    pending.current = { elements, view: view(state), files };
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, 900);
  };
  const rename = async (item) => {
    let name = prompt("Rename page", item.name);
    if (name?.trim()) {
      await api("/api/pages/" + item.id, {
        method: "PATCH",
        body: JSON.stringify({ name: name.trim() }),
      });
      setProjects((list) =>
        list.map((p) => ({
          ...p,
          pages: p.pages.map((x) =>
            x.id === item.id ? { ...x, name: name.trim() } : x,
          ),
        })),
      );
    }
  };
  const remove = async (item) => {
    if (!confirm(`Delete “${item.name}”? This cannot be undone.`)) return;
    await api("/api/pages/" + item.id, { method: "DELETE" });
    setProjects((list) =>
      list.map((p) => ({
        ...p,
        pages: p.pages.filter((x) => x.id !== item.id),
      })),
    );
    if (page?.id === item.id) {
      let next = projects.flatMap((p) => p.pages).find((x) => x.id !== item.id);
      next ? select(next) : (setPage(null), setScene(null));
    }
  };
  const reorder = async (project, item) => {
    let pages = project.pages.filter((x) => x.id !== item.id);
    pages.splice(drag.current.targetIndex, 0, item);
    setProjects((list) =>
      list.map((p) => (p.id === project.id ? { ...p, pages } : p)),
    );
    await api("/api/pages/reorder", {
      method: "POST",
      body: JSON.stringify({
        projectId: project.id,
        pageIds: pages.map((x) => x.id),
      }),
    });
  };
  if (auth === null) return <div className="loading">Opening sketchbook…</div>;
  if (!auth) return <Login />;
  return (
    <div className={"shell " + (!open ? "collapsed" : "")}>
      <aside>
        <button className="collapse" onClick={() => setOpen(!open)}>
          {open ? "‹" : "›"}
        </button>
        {open && (
          <>
            <div className="brand">
              <h1>りょういきてんかい</h1>
            </div>
            <button
              className="add project"
              onClick={async () => {
                let name = prompt("New project name");
                if (name) {
                  await api("/api/projects", {
                    method: "POST",
                    body: JSON.stringify({ name }),
                  });
                  load();
                }
              }}
            >
              + New project
            </button>
            {projects.map((project) => (
              <section key={project.id}>
                <h2>{project.name}</h2>
                {project.pages.map((item, index) => (
                  <div
                    key={item.id}
                    draggable
                    onDragStart={() =>
                      (drag.current = { item, targetIndex: index })
                    }
                    onDragOver={(e) => {
                      e.preventDefault();
                      drag.current.targetIndex = index;
                    }}
                    onDrop={() => reorder(project, item)}
                    className={
                      "page-row " + (page?.id === item.id ? "active" : "")
                    }
                  >
                    <button className="page" onClick={() => select(item)}>
                      <i>⠿</i>
                      {item.name}
                    </button>
                    <button title="Rename" onClick={() => rename(item)}>
                      ✎
                    </button>
                    <button title="Delete" onClick={() => remove(item)}>
                      ×
                    </button>
                  </div>
                ))}
                <button
                  className="add page-add"
                  onClick={async () => {
                    let name = prompt("New page name");
                    if (name) {
                      let made = await api("/api/pages", {
                        method: "POST",
                        body: JSON.stringify({ projectId: project.id, name }),
                      });
                      await load();
                      select(made);
                    }
                  }}
                >
                  + Add page
                </button>
              </section>
            ))}
          </>
        )}
      </aside>
      <main className="canvas">
        {error ? (
          <div className="canvas-error">{error}</div>
        ) : !page || scene === null ? (
          <div className="loading">Loading last canvas…</div>
        ) : (
          <CanvasBoundary>
            <Excalidraw
              key={page.id}
              initialData={{ ...scene, appState: scene.view }}
              onChange={(elements, state, files) =>
                queue(elements, state, files)
              }
            />
          </CanvasBoundary>
        )}
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")).render(<App />);
