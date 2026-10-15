import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Engine, type RunEvent } from "./engine.ts";
import { MotiveError, toErrorInfo } from "./errors.ts";
import { RecordingManager, RecordSpec } from "./recording.ts";
import { parseWorkflow } from "./workflow.ts";

const MAX_BODY = 1_000_000;

function digest(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

export interface ServerHandle {
  port: number;
  close(): Promise<void>;
}

/** Local API (ADR 0003): loopback only, bearer token, no browser origins, no CORS. */
export async function startServer(engine: Engine, token: string, port = 0, recordings = new RecordingManager(engine.store)): Promise<ServerHandle> {
  const tokenDigest = digest(token);
  const store = engine.store;

  const server = http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(JSON.stringify(body));
    };
    try {
      const actualPort = (server.address() as AddressInfo).port;
      const host = (req.headers.host ?? "").toLowerCase();
      if (!["127.0.0.1", "localhost", "[::1]"].map((h) => `${h}:${actualPort}`).includes(host)) {
        store.audit("api", "denied", { reason: "host", host });
        return send(403, { error: { code: "permission_denied", message: "unexpected Host header" } });
      }
      if (req.headers.origin !== undefined) {
        store.audit("api", "denied", { reason: "origin", origin: req.headers.origin });
        return send(403, { error: { code: "permission_denied", message: "browser-origin requests are not accepted" } });
      }
      const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
      if (!auth || !timingSafeEqual(digest(auth[1]!), tokenDigest)) {
        store.audit("api", "denied", { reason: "token" });
        res.setHeader("www-authenticate", "Bearer");
        return send(401, { error: { code: "permission_denied", message: "missing or wrong token" } });
      }

      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] !== "v1") return send(404, { error: { code: "not_found", message: "no such route" } });
      const m = req.method ?? "GET";
      const body = async (): Promise<any> => {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const c of req) {
          size += (c as Buffer).length;
          if (size > MAX_BODY) throw new MotiveError("invalid_args", "request body too large");
          chunks.push(c as Buffer);
        }
        try {
          return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
        } catch {
          throw new MotiveError("invalid_args", "body is not valid JSON");
        }
      };

      if (m === "GET" && parts[1] === "capabilities") return send(200, { version: 1, adapters: await engine.capabilities() });
      if (parts[1] === "workflows") {
        if (m === "GET" && parts.length === 2) return send(200, { workflows: store.listWorkflows() });
        const name = parts[2];
        if (name && m === "GET") {
          const w = store.getWorkflow(name);
          return w ? send(200, w) : send(404, { error: { code: "not_found", message: "no such workflow" } });
        }
        if (name && m === "PUT") {
          const w = parseWorkflow(await body());
          if (w.name !== name) throw new MotiveError("invalid_workflow", "name in the body must match the URL");
          store.saveWorkflow(w);
          store.audit("api", "workflow.save", { name });
          return send(200, { saved: name });
        }
        if (name && m === "DELETE") {
          store.audit("api", "workflow.delete", { name });
          return send(200, { deleted: store.deleteWorkflow(name) });
        }
      }
      if (parts[1] === "runs") {
        if (m === "POST" && parts.length === 2) {
          const b = await body();
          const w = typeof b.workflow === "string" ? store.getWorkflow(b.workflow) : undefined;
          if (!w) throw new MotiveError("not_found", "no such workflow");
          const run = engine.start(w, b.inputs ?? {}, { actor: "api" });
          return send(202, { id: run.id });
        }
        if (m === "GET" && parts.length === 2) return send(200, { runs: store.listRuns() });
        const id = parts[2];
        if (id && m === "GET" && parts.length === 3) {
          const r = store.getRun(id);
          return r ? send(200, r) : send(404, { error: { code: "not_found", message: "no such run" } });
        }
        if (id && m === "POST" && parts[3] === "cancel") {
          const active = engine.activeRuns().includes(id);
          if (active) engine.stopRun(id, "cancelled through the API");
          return send(200, { cancelled: active });
        }
        if (id && m === "GET" && parts[3] === "events") {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
          const on = (e: RunEvent) => {
            res.write(`data: ${JSON.stringify(e)}\n\n`);
            if (e.type === "run.end") {
              engine.events.off(`run:${id}`, on);
              res.end();
            }
          };
          if (!engine.activeRuns().includes(id)) {
            const r = store.getRun(id);
            res.write(`data: ${JSON.stringify({ type: "run.end", runId: id, run: r })}\n\n`);
            return res.end();
          }
          engine.events.on(`run:${id}`, on);
          req.on("close", () => engine.events.off(`run:${id}`, on));
          return;
        }
      }
      if (parts[1] === "record") {
        if (m === "POST" && parts.length === 2) {
          const spec = RecordSpec.safeParse(await body());
          if (!spec.success) throw new MotiveError("invalid_args", `${spec.error.issues[0]?.path.join(".") || "body"}: ${spec.error.issues[0]?.message}`);
          return send(202, { id: recordings.start(spec.data).id });
        }
        const id = parts[2];
        if (id && m === "GET" && parts.length === 3) {
          const s = recordings.get(id);
          return s ? send(200, s) : send(404, { error: { code: "not_found", message: "no such recording" } });
        }
        if (id && m === "POST" && parts[3] === "finish") return send(200, await recordings.finish(id));
        if (id && m === "POST" && parts[3] === "save") return send(200, { saved: recordings.save(id).name });
        if (id && m === "DELETE" && parts.length === 3) {
          await recordings.discard(id);
          return send(200, { discarded: true });
        }
      }
      if (m === "POST" && parts[1] === "stop") {
        const n = engine.stopAll("emergency stop through the API");
        await recordings.stopAll();
        store.audit("api", "stop", { cancelled: n });
        return send(200, { cancelled: n });
      }
      if (m === "GET" && parts[1] === "audit") return send(200, { audit: store.listAudit() });
      return send(404, { error: { code: "not_found", message: "no such route" } });
    } catch (e) {
      const info = toErrorInfo(e);
      const status = info.code === "not_found" ? 404 : info.code === "precondition_failed" ? 409 : info.code === "internal" ? 500 : 400;
      if (!res.headersSent) send(status, { error: info });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
