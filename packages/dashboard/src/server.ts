import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { timingSafeEqual } from "crypto";
import { existsSync, readFileSync, statSync } from "fs";
import { extname, relative, resolve } from "path";
import { fileURLToPath } from "url";
import { Pool } from "pg";

const here = fileURLToPath(new URL(".", import.meta.url));
const publicDirCandidates = [
  resolve(here, "../public"),
  resolve(here, "../../public"),
];
const publicDir =
  publicDirCandidates.find((candidate) => existsSync(candidate)) ??
  publicDirCandidates[0]!;
const port = Number(process.env.PORT ?? 4173);
const maxActions = Number(process.env.GITAGENTS_DASHBOARD_MAX_ACTIONS ?? 5000);
const maxBodyBytes = Number(process.env.GITAGENTS_DASHBOARD_MAX_BODY_BYTES ?? 1_000_000);
const dashboardToken = process.env.GITAGENTS_DASHBOARD_TOKEN?.trim() ?? "";
const startedAt = new Date().toISOString();
const pricingSource =
  "https://github.com/szilagyib/GitAgents/blob/main/packages/core/src/llm/pricing.ts";

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

interface TelemetryAction {
  id: string;
  runId: string;
  agent: string;
  action: string;
  startedAt?: string;
  [key: string]: unknown;
}

interface TelemetryArtifact {
  version: 1;
  generatedAt: string;
  currency: "USD";
  pricingSource: string;
  actions: TelemetryAction[];
  dashboardSource: {
    mode: "memory" | "postgres";
    startedAt: string;
    actionCount: number;
  };
}

interface TelemetryStore {
  readonly mode: "memory" | "postgres";
  countActions(): Promise<number>;
  listActions(limit: number): Promise<TelemetryAction[]>;
  recordAction(action: TelemetryAction): Promise<number>;
  clearActions(): Promise<void>;
}

async function main(): Promise<void> {
  const store = await createTelemetryStore();
  const server = createServer((request, response) => {
    void handleRequest(store, request, response);
  });

  server.listen(port, () => {
    console.log(`GitAgents dashboard: http://localhost:${port}`);
    console.log(`Telemetry storage: ${store.mode}`);
  });
}

async function createTelemetryStore(): Promise<TelemetryStore> {
  const databaseUrl = process.env.GITAGENTS_DASHBOARD_DATABASE_URL || process.env.DATABASE_URL;
  if (!databaseUrl) return new MemoryTelemetryStore(maxActions);

  const store = new PostgresTelemetryStore(databaseUrl);
  await store.initialize();
  return store;
}

async function handleRequest(
  store: TelemetryStore,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host}`);

  try {
    if (requestUrl.pathname.startsWith("/api/") && !hasValidApiToken(request)) {
      response.writeHead(401, {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
        "www-authenticate": 'Bearer realm="GitAgents Dashboard"',
      });
      response.end(JSON.stringify({ error: "A valid dashboard token is required." }));
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/telemetry") {
      sendJson(response, 200, await buildTelemetryArtifact(store));
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/telemetry/actions") {
      await handleTelemetryAction(store, request, response);
      return;
    }

    if (request.method === "DELETE" && requestUrl.pathname === "/api/telemetry/actions") {
      await store.clearActions();
      sendJson(response, 200, await buildTelemetryArtifact(store));
      return;
    }

    serveStaticFile(requestUrl, response);
  } catch (error) {
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : "Dashboard request failed.",
    });
  }
}

function hasValidApiToken(request: IncomingMessage): boolean {
  if (!dashboardToken) return true;
  const authorization = request.headers.authorization ?? "";
  if (!authorization.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(authorization.slice("Bearer ".length));
  const expected = Buffer.from(dashboardToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function serveStaticFile(requestUrl: URL, response: ServerResponse): void {
  const relativePath = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const filePath = resolve(publicDir, `.${relativePath}`);

  if (!isInsideDirectory(publicDir, filePath) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  const ext = extname(filePath);
  response.writeHead(200, { "content-type": contentTypes[ext] ?? "application/octet-stream" });
  response.end(readFileSync(filePath));
}

async function buildTelemetryArtifact(store: TelemetryStore): Promise<TelemetryArtifact> {
  const [actions, actionCount] = await Promise.all([
    store.listActions(maxActions),
    store.countActions(),
  ]);

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    currency: "USD",
    pricingSource,
    actions,
    dashboardSource: {
      mode: store.mode,
      startedAt,
      actionCount,
    },
  };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function handleTelemetryAction(
  store: TelemetryStore,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    const payload = await readJsonBody(request);
    const action = readTelemetryAction(payload);
    if (!action) {
      sendJson(response, 400, { error: "Expected JSON body with an action object." });
      return;
    }

    const actionCount = await store.recordAction(action);
    sendJson(response, 202, { ok: true, actionCount, storage: store.mode });
  } catch (error) {
    const status = error instanceof PayloadTooLargeError
      ? 413
      : error instanceof SyntaxError
        ? 400
        : 500;
    sendJson(response, status, {
      error: error instanceof Error ? error.message : "Could not ingest telemetry.",
    });
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBodyBytes) {
      throw new PayloadTooLargeError(`Request body too large. Max ${maxBodyBytes} bytes.`);
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf-8").trim();
  return text ? JSON.parse(text) : {};
}

function readTelemetryAction(payload: unknown): TelemetryAction | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const action = record.action;
  if (typeof action !== "object" || action === null) return null;
  const actionRecord = action as Record<string, unknown>;
  if (typeof actionRecord.id !== "string") return null;
  if (typeof actionRecord.runId !== "string") return null;
  if (typeof actionRecord.agent !== "string") return null;
  if (typeof actionRecord.action !== "string") return null;
  return {
    ...actionRecord,
    id: actionRecord.id,
    runId: actionRecord.runId,
    agent: actionRecord.agent,
    action: actionRecord.action,
    startedAt: typeof actionRecord.startedAt === "string" ? actionRecord.startedAt : undefined,
    dashboardMetadata: typeof record.metadata === "object" && record.metadata !== null
      ? record.metadata
      : undefined,
  };
}

function isInsideDirectory(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !path.startsWith("/") && !path.match(/^[A-Za-z]:/));
}

class MemoryTelemetryStore implements TelemetryStore {
  readonly mode = "memory" as const;
  private readonly actions: TelemetryAction[] = [];

  constructor(private readonly limit: number) {}

  async countActions(): Promise<number> {
    return this.actions.length;
  }

  async listActions(limit: number): Promise<TelemetryAction[]> {
    return this.actions.slice(Math.max(0, this.actions.length - limit));
  }

  async recordAction(action: TelemetryAction): Promise<number> {
    const existingIndex = this.actions.findIndex((existing) => existing.id === action.id);
    if (existingIndex >= 0) {
      this.actions.splice(existingIndex, 1, action);
    } else {
      this.actions.push(action);
    }

    if (this.actions.length > this.limit) {
      this.actions.splice(0, this.actions.length - this.limit);
    }
    return this.actions.length;
  }

  async clearActions(): Promise<void> {
    this.actions.splice(0);
  }
}

class PostgresTelemetryStore implements TelemetryStore {
  readonly mode = "postgres" as const;
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      application_name: "gitagents-dashboard",
    });
  }

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS gitagents_telemetry_actions (
        id text PRIMARY KEY,
        run_id text NOT NULL,
        agent text NOT NULL,
        action_name text NOT NULL,
        started_at timestamptz NULL,
        received_at timestamptz NOT NULL DEFAULT now(),
        payload jsonb NOT NULL
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS gitagents_telemetry_actions_received_idx
      ON gitagents_telemetry_actions (received_at DESC)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS gitagents_telemetry_actions_run_idx
      ON gitagents_telemetry_actions (run_id)
    `);
  }

  async countActions(): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM gitagents_telemetry_actions",
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async listActions(limit: number): Promise<TelemetryAction[]> {
    const result = await this.pool.query<{ payload: TelemetryAction }>(
      `
        SELECT payload
        FROM (
          SELECT payload, received_at
          FROM gitagents_telemetry_actions
          ORDER BY received_at DESC
          LIMIT $1
        ) recent
        ORDER BY received_at ASC
      `,
      [limit],
    );
    return result.rows.map((row) => row.payload);
  }

  async recordAction(action: TelemetryAction): Promise<number> {
    await this.pool.query(
      `
        INSERT INTO gitagents_telemetry_actions (
          id,
          run_id,
          agent,
          action_name,
          started_at,
          payload
        )
        VALUES ($1, $2, $3, $4, $5, $6::jsonb)
        ON CONFLICT (id) DO UPDATE SET
          run_id = EXCLUDED.run_id,
          agent = EXCLUDED.agent,
          action_name = EXCLUDED.action_name,
          started_at = EXCLUDED.started_at,
          received_at = now(),
          payload = EXCLUDED.payload
      `,
      [
        action.id,
        action.runId,
        action.agent,
        action.action,
        parseOptionalDate(action.startedAt),
        JSON.stringify(action),
      ],
    );
    return this.countActions();
  }

  async clearActions(): Promise<void> {
    await this.pool.query("DELETE FROM gitagents_telemetry_actions");
  }
}

function parseOptionalDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

class PayloadTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayloadTooLargeError";
  }
}

void main();
