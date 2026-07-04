import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createStorage } from "./storage.mjs";

const app = express();
const root = path.dirname(fileURLToPath(import.meta.url));
const storage = await createStorage();

// File uploads are allowed to be large. All other JSON requests stay small.
app.use("/api/pages/:id/files", express.json({ limit: "64mb" }));
app.use(express.json({ limit: "8mb" }));
app.set("trust proxy", true);

const signature = (value) =>
  crypto
    .createHmac("sha256", process.env.SESSION_SECRET)
    .update(value)
    .digest("hex");
const attempts = new Map();

function clientIp(request) {
  return request.ip || request.socket.remoteAddress || "unknown";
}

function allowed(key, maximum, windowMs) {
  const now = Date.now();
  const current = attempts.get(key) || { count: 0, started: now };
  const bucket =
    now - current.started > windowMs ? { count: 0, started: now } : current;
  bucket.count += 1;
  attempts.set(key, bucket);
  if (attempts.size > 20_000) {
    for (const [id, item] of attempts)
      if (now - item.started > windowMs) attempts.delete(id);
  }
  return bucket.count <= maximum;
}

function requireLogin(request, response, next) {
  if (!allowed(`api:${clientIp(request)}`, 240, 60_000)) {
    return response
      .status(429)
      .set("Retry-After", "60")
      .send("Too many requests");
  }
  const cookie = request.headers.cookie?.match(/draw=([^;]+)/)?.[1];
  const expected = signature("ok");
  if (
    cookie &&
    cookie.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(cookie), Buffer.from(expected))
  )
    return next();
  return response.status(401).end();
}

app.post("/api/login", (request, response) => {
  if (!allowed(`login:${clientIp(request)}`, 10, 15 * 60_000))
    return response
      .status(429)
      .set("Retry-After", "900")
      .send("Too many login attempts; try again later");
  if (request.body.password !== process.env.DRAW_PASSWORD)
    return response.status(403).end();
  response.setHeader(
    "Set-Cookie",
    `draw=${signature("ok")}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`,
  );
  return response.end();
});

app.get("/api/me", requireLogin, (request, response) =>
  response.json({ ok: true }),
);
app.get("/api/pages", requireLogin, async (request, response) =>
  response.json(await storage.listProjects()),
);
app.post("/api/projects", requireLogin, async (request, response) =>
  response.json(await storage.createProject(request.body.name)),
);
app.post("/api/pages", requireLogin, async (request, response) =>
  response.json(
    await storage.createPage(request.body.projectId, request.body.name),
  ),
);
app.post("/api/pages/reorder", requireLogin, async (request, response) => {
  await storage.reorderPages(request.body.projectId, request.body.pageIds);
  response.json({ ok: true });
});
app.patch("/api/pages/:id", requireLogin, async (request, response) =>
  response.json(await storage.renamePage(request.params.id, request.body.name)),
);
app.delete("/api/pages/:id", requireLogin, async (request, response) => {
  await storage.deletePage(request.params.id);
  response.json({ ok: true });
});
app.get("/api/pages/:id", requireLogin, async (request, response) =>
  response.json(await storage.getPage(request.params.id)),
);
app.post("/api/pages/:id/files", requireLogin, async (request, response) => {
  const file = request.body.file;
  if (!file?.id || !file.dataURL)
    return response.status(400).send("Invalid file");
  await storage.saveFile(request.params.id, file);
  response.json({ ok: true, id: file.id });
});
app.put("/api/pages/:id", requireLogin, async (request, response) => {
  await storage.saveScene(
    request.params.id,
    request.body.elements,
    request.body.view,
  );
  response.json({ ok: true });
});

app.use(express.static(path.join(root, "dist")));
app.use((request, response) =>
  response.sendFile(path.join(root, "dist", "index.html")),
);

const port = Number(process.env.PORT || 3000);
app.listen(port, () =>
  console.log(
    `Draw workspace listening on port ${port} using ${process.env.STORAGE_BACKEND || (process.env.DATABASE_URL ? "postgres" : "sqlite")} storage`,
  ),
);

for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, async () => {
    await storage.close();
    process.exit(0);
  });
