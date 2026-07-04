/**
 * Small storage adapter. The HTTP layer does not need to know whether data
 * lives in PostgreSQL or in a local SQLite file.
 *
 * Use STORAGE_BACKEND=sqlite for a single-machine install. PostgreSQL is the
 * default when DATABASE_URL is present, which is the recommended VPS setup.
 */
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const { Pool } = pg;

const schema = `
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS pages (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 1,
    scene TEXT NOT NULL DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS page_files (
    id TEXT PRIMARY KEY,
    page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    mime_type TEXT,
    created_at BIGINT,
    width INTEGER,
    height INTEGER,
    data_url TEXT NOT NULL
  );
`;

function parseScene(value) {
  if (!value) return {};
  return typeof value === "string" ? JSON.parse(value) : value;
}

function fileObject(row) {
  return {
    id: row.id,
    mimeType: row.mimeType ?? row.mime_type,
    created: Number(row.created ?? row.created_at ?? Date.now()),
    width: row.width ?? null,
    height: row.height ?? null,
    dataURL: row.dataURL ?? row.data_url,
  };
}

export async function createStorage(env = process.env) {
  const backend = (
    env.STORAGE_BACKEND || (env.DATABASE_URL ? "postgres" : "sqlite")
  ).toLowerCase();
  if (backend === "sqlite")
    return createSqliteStorage(env.SQLITE_PATH || "./data/draw.sqlite3");
  if (backend !== "postgres")
    throw new Error(`Unsupported STORAGE_BACKEND: ${backend}`);
  if (!env.DATABASE_URL)
    throw new Error("DATABASE_URL is required for PostgreSQL storage");
  return createPostgresStorage(env.DATABASE_URL);
}

async function createPostgresStorage(connectionString) {
  const pool = new Pool({ connectionString });
  await pool.query(
    "ALTER TABLE pages ADD COLUMN IF NOT EXISTS position INTEGER",
  );
  await pool.query("UPDATE pages SET position = id WHERE position IS NULL");
  await pool.query(
    schema
      .replace(/INTEGER PRIMARY KEY/g, "SERIAL PRIMARY KEY")
      .replace(
        /scene TEXT NOT NULL DEFAULT '\{\}'/g,
        "scene JSONB NOT NULL DEFAULT '{}'::jsonb",
      )
      .replace(/TIMESTAMP/g, "TIMESTAMPTZ"),
  );
  await migrateEmbeddedFiles({
    query: (text, values) => pool.query(text, values),
    postgres: true,
  });
  await pool.query("INSERT INTO projects(name) SELECT 'Inbox' WHERE NOT EXISTS (SELECT 1 FROM projects)");
  await pool.query("INSERT INTO pages(project_id,name,position) SELECT id,'Untitled canvas',1 FROM projects WHERE name='Inbox' AND NOT EXISTS (SELECT 1 FROM pages)");
  return postgresMethods(pool);
}

async function migrateEmbeddedFiles(db) {
  const rows = (
    await db.query(
      "SELECT id, scene->'files' AS files FROM pages WHERE scene ? 'files'",
      [],
    )
  ).rows;
  for (const row of rows) {
    const files = row.files || {};
    for (const [id, file] of Object.entries(files)) {
      await db.query(
        "INSERT INTO page_files(id,page_id,mime_type,created_at,width,height,data_url) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING",
        [
          id,
          row.id,
          file.mimeType,
          file.created || Date.now(),
          file.width || null,
          file.height || null,
          file.dataURL,
        ],
      );
    }
    await db.query("UPDATE pages SET scene = scene - 'files' WHERE id = $1", [
      row.id,
    ]);
  }
}

function postgresMethods(pool) {
  return {
    async listProjects() {
      return (
        await pool.query(
          "SELECT p.id,p.name,COALESCE(json_agg(json_build_object('id',g.id,'name',g.name,'position',g.position) ORDER BY g.position,g.created_at) FILTER(WHERE g.id IS NOT NULL),'[]') pages FROM projects p LEFT JOIN pages g ON g.project_id=p.id GROUP BY p.id ORDER BY p.created_at",
        )
      ).rows;
    },
    async createProject(name) {
      return (
        await pool.query(
          "INSERT INTO projects(name) VALUES($1) RETURNING id,name",
          [name],
        )
      ).rows[0];
    },
    async createPage(projectId, name) {
      return (
        await pool.query(
          "INSERT INTO pages(project_id,name,position) VALUES($1,$2,COALESCE((SELECT max(position)+1 FROM pages WHERE project_id=$1),1)) RETURNING id,name,position",
          [projectId, name],
        )
      ).rows[0];
    },
    async renamePage(id, name) {
      return (
        await pool.query(
          "UPDATE pages SET name=$1,updated_at=now() WHERE id=$2 RETURNING id,name,position",
          [name, id],
        )
      ).rows[0];
    },
    async deletePage(id) {
      await pool.query("DELETE FROM pages WHERE id=$1", [id]);
    },
    async reorderPages(projectId, ids) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (const [index, id] of ids.entries())
          await client.query(
            "UPDATE pages SET position=$1 WHERE id=$2 AND project_id=$3",
            [index + 1, id, projectId],
          );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async getPage(id) {
      const scene =
        (await pool.query("SELECT scene FROM pages WHERE id=$1", [id])).rows[0]
          ?.scene || {};
      const files = (
        await pool.query(
          'SELECT id,mime_type AS "mimeType",created_at AS created,width,height,data_url AS "dataURL" FROM page_files WHERE page_id=$1',
          [id],
        )
      ).rows;
      return {
        ...scene,
        files: Object.fromEntries(files.map((file) => [file.id, file])),
      };
    },
    async saveFile(pageId, file) {
      await pool.query(
        "INSERT INTO page_files(id,page_id,mime_type,created_at,width,height,data_url) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET data_url=excluded.data_url,mime_type=excluded.mime_type,width=excluded.width,height=excluded.height",
        [
          file.id,
          pageId,
          file.mimeType,
          file.created || Date.now(),
          file.width || null,
          file.height || null,
          file.dataURL,
        ],
      );
    },
    async saveScene(id, elements, view) {
      await pool.query(
        "UPDATE pages SET scene=jsonb_build_object('elements',$1::jsonb,'view',$2::jsonb),updated_at=now() WHERE id=$3",
        [JSON.stringify(elements || []), JSON.stringify(view || {}), id],
      );
    },
    async close() {
      await pool.end();
    },
  };
}

async function createSqliteStorage(filename) {
  const { default: Database } = await import("better-sqlite3");
  const absolute = path.resolve(filename);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const db = new Database(absolute);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(schema);
  migrateSqliteEmbeddedFiles(db);
  if (db.prepare("SELECT count(*) AS count FROM projects").get().count === 0) {
    const project = db.prepare("INSERT INTO projects(name) VALUES(?) RETURNING id").get("Inbox");
    db.prepare("INSERT INTO pages(project_id,name,position) VALUES(?,?,1)").run(project.id, "Untitled canvas");
  }
  return sqliteMethods(db);
}

function migrateSqliteEmbeddedFiles(db) {
  const pages = db
    .prepare("SELECT id, scene FROM pages WHERE scene LIKE '%\\\"files\\\"%'")
    .all();
  const insert = db.prepare(
    "INSERT OR IGNORE INTO page_files(id,page_id,mime_type,created_at,width,height,data_url) VALUES(?,?,?,?,?,?,?)",
  );
  const update = db.prepare("UPDATE pages SET scene=? WHERE id=?");
  for (const page of pages) {
    const scene = parseScene(page.scene);
    for (const file of Object.values(scene.files || {}))
      insert.run(
        file.id,
        page.id,
        file.mimeType,
        file.created || Date.now(),
        file.width || null,
        file.height || null,
        file.dataURL,
      );
    delete scene.files;
    update.run(JSON.stringify(scene), page.id);
  }
}

function sqliteMethods(db) {
  return {
    async listProjects() {
      return db
        .prepare(
          "SELECT p.id,p.name,COALESCE(json_group_array(json_object('id',g.id,'name',g.name,'position',g.position)),json('[]')) pages FROM projects p LEFT JOIN pages g ON g.project_id=p.id GROUP BY p.id ORDER BY p.created_at",
        )
        .all()
        .map((row) => ({
          ...row,
          pages: JSON.parse(row.pages).filter((page) => page.id !== null),
        }));
    },
    async createProject(name) {
      return db
        .prepare("INSERT INTO projects(name) VALUES(?) RETURNING id,name")
        .get(name);
    },
    async createPage(projectId, name) {
      return db
        .prepare(
          "INSERT INTO pages(project_id,name,position) VALUES(?,?,COALESCE((SELECT max(position)+1 FROM pages WHERE project_id=?),1)) RETURNING id,name,position",
        )
        .get(projectId, name, projectId);
    },
    async renamePage(id, name) {
      return db
        .prepare(
          "UPDATE pages SET name=?,updated_at=CURRENT_TIMESTAMP WHERE id=? RETURNING id,name,position",
        )
        .get(name, id);
    },
    async deletePage(id) {
      db.prepare("DELETE FROM pages WHERE id=?").run(id);
    },
    async reorderPages(projectId, ids) {
      const update = db.prepare(
        "UPDATE pages SET position=? WHERE id=? AND project_id=?",
      );
      db.transaction(() =>
        ids.forEach((id, index) => update.run(index + 1, id, projectId)),
      )();
    },
    async getPage(id) {
      const scene = parseScene(
        db.prepare("SELECT scene FROM pages WHERE id=?").get(id)?.scene,
      );
      const files = db
        .prepare(
          "SELECT id,mime_type AS mimeType,created_at AS created,width,height,data_url AS dataURL FROM page_files WHERE page_id=?",
        )
        .all(id);
      return {
        ...scene,
        files: Object.fromEntries(
          files.map((file) => [file.id, fileObject(file)]),
        ),
      };
    },
    async saveFile(pageId, file) {
      db.prepare(
        "INSERT INTO page_files(id,page_id,mime_type,created_at,width,height,data_url) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data_url=excluded.data_url,mime_type=excluded.mime_type,width=excluded.width,height=excluded.height",
      ).run(
        file.id,
        pageId,
        file.mimeType,
        file.created || Date.now(),
        file.width || null,
        file.height || null,
        file.dataURL,
      );
    },
    async saveScene(id, elements, view) {
      db.prepare(
        "UPDATE pages SET scene=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",
      ).run(JSON.stringify({ elements: elements || [], view: view || {} }), id);
    },
    async close() {
      db.close();
    },
  };
}
