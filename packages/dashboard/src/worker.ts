interface AssetBinding {
  fetch(request: Request): Promise<Response>;
}

interface D1Result<T> {
  results?: T[];
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T>(): Promise<D1Result<T>>;
  first<T>(): Promise<T | null>;
  run(): Promise<unknown>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

interface DashboardEnv {
  ASSETS: AssetBinding;
  DB: D1Database;
  DASHBOARD_TOKEN?: string;
  GITAGENTS_DASHBOARD_MAX_ACTIONS?: string;
  GITAGENTS_DASHBOARD_MAX_BODY_BYTES?: string;
}

interface TelemetryAction {
  id: string;
  runId: string;
  agent: string;
  action: string;
  startedAt?: string;
  [key: string]: unknown;
}

const DEFAULT_MAX_ACTIONS = 5_000;
const DEFAULT_MAX_BODY_BYTES = 1_000_000;
const MAX_CONFIGURED_ACTIONS = 100_000;
const PRICING_SOURCE =
  "https://github.com/szilagyib/GitAgents/blob/main/packages/core/src/llm/pricing.ts";
const startedAt = new Date().toISOString();

export default {
  async fetch(request: Request, env: DashboardEnv): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    if (!env.DASHBOARD_TOKEN) {
      return jsonResponse(503, {
        error: "Dashboard authentication is not configured.",
      });
    }
    if (!(await hasValidBearerToken(request, env.DASHBOARD_TOKEN))) {
      return jsonResponse(
        401,
        { error: "A valid dashboard token is required." },
        { "www-authenticate": 'Bearer realm="GitAgents Dashboard"' },
      );
    }

    try {
      if (request.method === "GET" && url.pathname === "/api/telemetry") {
        return jsonResponse(200, await buildTelemetryArtifact(env));
      }
      if (request.method === "POST" && url.pathname === "/api/telemetry/actions") {
        return recordTelemetryAction(request, env);
      }
      if (request.method === "DELETE" && url.pathname === "/api/telemetry/actions") {
        await env.DB.prepare("DELETE FROM gitagents_telemetry_actions").run();
        return jsonResponse(200, await buildTelemetryArtifact(env));
      }
      return jsonResponse(404, { error: "Not found." });
    } catch (error) {
      return jsonResponse(500, {
        error: error instanceof Error ? error.message : "Dashboard request failed.",
      });
    }
  },
};

async function buildTelemetryArtifact(env: DashboardEnv): Promise<Record<string, unknown>> {
  const limit = readPositiveInteger(
    env.GITAGENTS_DASHBOARD_MAX_ACTIONS,
    DEFAULT_MAX_ACTIONS,
    MAX_CONFIGURED_ACTIONS,
  );
  const [rows, countRow] = await Promise.all([
    env.DB.prepare(
      `
        SELECT payload
        FROM (
          SELECT payload, received_at
          FROM gitagents_telemetry_actions
          ORDER BY received_at DESC
          LIMIT ?
        ) recent
        ORDER BY received_at ASC
      `,
    )
      .bind(limit)
      .all<{ payload: string }>(),
    env.DB.prepare(
      "SELECT COUNT(*) AS count FROM gitagents_telemetry_actions",
    ).first<{ count: number }>(),
  ]);

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    currency: "USD",
    pricingSource: PRICING_SOURCE,
    actions: (rows.results ?? []).flatMap((row) => {
      try {
        return [JSON.parse(row.payload) as TelemetryAction];
      } catch {
        return [];
      }
    }),
    dashboardSource: {
      mode: "d1",
      startedAt,
      actionCount: Number(countRow?.count ?? 0),
    },
  };
}

async function recordTelemetryAction(
  request: Request,
  env: DashboardEnv,
): Promise<Response> {
  const maxBodyBytes = readPositiveInteger(
    env.GITAGENTS_DASHBOARD_MAX_BODY_BYTES,
    DEFAULT_MAX_BODY_BYTES,
    DEFAULT_MAX_BODY_BYTES * 10,
  );
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > maxBodyBytes) {
    return jsonResponse(413, { error: `Request body exceeds ${maxBodyBytes} bytes.` });
  }

  const body = await readRequestText(request, maxBodyBytes);
  if (body === null) {
    return jsonResponse(413, { error: `Request body exceeds ${maxBodyBytes} bytes.` });
  }

  let payload: unknown;
  try {
    payload = body.trim() ? JSON.parse(body) : {};
  } catch {
    return jsonResponse(400, { error: "Request body must be valid JSON." });
  }

  const action = readTelemetryAction(payload);
  if (!action) {
    return jsonResponse(400, { error: "Expected JSON body with an action object." });
  }

  await env.DB.prepare(
    `
      INSERT INTO gitagents_telemetry_actions (
        id, run_id, agent, action_name, started_at, received_at, payload
      ) VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?)
      ON CONFLICT(id) DO UPDATE SET
        run_id = excluded.run_id,
        agent = excluded.agent,
        action_name = excluded.action_name,
        started_at = excluded.started_at,
        received_at = excluded.received_at,
        payload = excluded.payload
    `,
  )
    .bind(
      action.id,
      action.runId,
      action.agent,
      action.action,
      readOptionalDate(action.startedAt),
      JSON.stringify(action),
    )
    .run();

  const maxActions = readPositiveInteger(
    env.GITAGENTS_DASHBOARD_MAX_ACTIONS,
    DEFAULT_MAX_ACTIONS,
    MAX_CONFIGURED_ACTIONS,
  );
  await env.DB.prepare(
    `
      DELETE FROM gitagents_telemetry_actions
      WHERE id IN (
        SELECT id
        FROM gitagents_telemetry_actions
        ORDER BY received_at DESC
        LIMIT -1 OFFSET ?
      )
    `,
  )
    .bind(maxActions)
    .run();

  const countRow = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM gitagents_telemetry_actions",
  ).first<{ count: number }>();
  return jsonResponse(202, {
    ok: true,
    actionCount: Number(countRow?.count ?? 0),
    storage: "d1",
  });
}

export async function readRequestText(
  request: Request,
  maxBytes: number,
): Promise<string | null> {
  if (!request.body) return "";

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export function readTelemetryAction(payload: unknown): TelemetryAction | null {
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
    startedAt:
      typeof actionRecord.startedAt === "string" ? actionRecord.startedAt : undefined,
    dashboardMetadata:
      typeof record.metadata === "object" && record.metadata !== null
        ? record.metadata
        : undefined,
  };
}

export async function hasValidBearerToken(
  request: Request,
  expectedToken: string,
): Promise<boolean> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return false;
  const suppliedToken = authorization.slice("Bearer ".length);
  const encoder = new TextEncoder();
  const [expectedDigest, suppliedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(expectedToken)),
    crypto.subtle.digest("SHA-256", encoder.encode(suppliedToken)),
  ]);
  const expected = new Uint8Array(expectedDigest);
  const supplied = new Uint8Array(suppliedDigest);
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected[index]! ^ supplied[index]!;
  }
  return difference === 0;
}

function readOptionalDate(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function readPositiveInteger(
  value: string | undefined,
  fallback: number,
  maximum: number,
): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0
    ? Math.min(parsed, maximum)
    : fallback;
}

function jsonResponse(
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}
