const state = {
  artifact: null,
  actions: [],
  selected: null,
  theme: "light",
  loading: false,
};

const els = {
  themeToggle: document.querySelector("#themeToggle"),
  refreshButton: document.querySelector("#refreshButton"),
  totalCost: document.querySelector("#totalCost"),
  totalTokens: document.querySelector("#totalTokens"),
  totalTime: document.querySelector("#totalTime"),
  totalActions: document.querySelector("#totalActions"),
  runFilter: document.querySelector("#runFilter"),
  agentFilter: document.querySelector("#agentFilter"),
  statusFilter: document.querySelector("#statusFilter"),
  searchInput: document.querySelector("#searchInput"),
  fileCount: document.querySelector("#fileCount"),
  slowActionCount: document.querySelector("#slowActionCount"),
  modelCount: document.querySelector("#modelCount"),
  efficiencyScope: document.querySelector("#efficiencyScope"),
  costByFile: document.querySelector("#costByFile"),
  slowestActions: document.querySelector("#slowestActions"),
  modelComparison: document.querySelector("#modelComparison"),
  findingCount: document.querySelector("#findingCount"),
  costPerFinding: document.querySelector("#costPerFinding"),
  tokensPerFinding: document.querySelector("#tokensPerFinding"),
  timePerFinding: document.querySelector("#timePerFinding"),
  tokenSplitTotal: document.querySelector("#tokenSplitTotal"),
  tokenSplit: document.querySelector("#tokenSplit"),
  tokenSplitLegend: document.querySelector("#tokenSplitLegend"),
  errorCount: document.querySelector("#errorCount"),
  errorPanel: document.querySelector("#errorPanel"),
  pricingSource: document.querySelector("#pricingSource"),
  timeline: document.querySelector("#timeline"),
  actionsBody: document.querySelector("#actionsBody"),
  detailPanel: document.querySelector("#detailPanel"),
  detailList: document.querySelector("#detailList"),
  closeDetail: document.querySelector("#closeDetail"),
};

initializeTheme();

els.themeToggle.addEventListener("click", () => {
  setTheme(state.theme === "dark" ? "light" : "dark", true);
});
els.refreshButton.addEventListener("click", loadTelemetry);
els.runFilter.addEventListener("change", render);
els.agentFilter.addEventListener("change", render);
els.statusFilter.addEventListener("change", render);
els.searchInput.addEventListener("input", render);
els.closeDetail.addEventListener("click", () => {
  els.detailPanel.classList.remove("open");
});

await loadTelemetry();
setInterval(loadTelemetry, 5000);

function initializeTheme() {
  const savedTheme = localStorage.getItem("gitagents-theme");
  const preferredTheme = window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
  setTheme(savedTheme === "dark" || savedTheme === "light" ? savedTheme : preferredTheme, false);
}

function setTheme(theme, persist) {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  els.themeToggle.textContent = theme === "dark" ? "Light" : "Dark";
  els.themeToggle.setAttribute("aria-pressed", String(theme === "dark"));
  els.themeToggle.title = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";
  if (persist) {
    localStorage.setItem("gitagents-theme", theme);
  }
}

async function loadTelemetry() {
  if (state.loading) return;
  state.loading = true;
  try {
    const response = await fetch(`/api/telemetry?cache=${Date.now()}`);
    if (!response.ok) {
      throw new Error(`Dashboard API ${response.status}`);
    }
    state.artifact = await response.json();
    state.actions = Array.isArray(state.artifact.actions)
      ? state.artifact.actions.slice().sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
      : [];
  } catch (error) {
    state.artifact = {
      version: 1,
      generatedAt: new Date().toISOString(),
      currency: "USD",
      pricingSource: "",
      actions: [],
      error: error instanceof Error ? error.message : "Could not load dashboard telemetry",
    };
    state.actions = [];
  } finally {
    state.loading = false;
  }
  fillRunFilter();
  fillAgentFilter();
  render();
}

function fillRunFilter() {
  const previous = els.runFilter.value || "all";
  const runs = ["all", ...new Set(state.actions.map((action) => action.runId).filter(Boolean))];
  els.runFilter.innerHTML = runs
    .map((runId) => `<option value="${escapeAttr(runId)}">${runId === "all" ? "All" : escapeHtml(shortRunId(runId))}</option>`)
    .join("");
  els.runFilter.value = runs.includes(previous) ? previous : "all";
}

function fillAgentFilter() {
  const previous = els.agentFilter.value || "all";
  const agents = ["all", ...new Set(state.actions.map((action) => action.agent).filter(Boolean))];
  els.agentFilter.innerHTML = agents
    .map((agent) => `<option value="${escapeAttr(agent)}">${agent === "all" ? "All" : escapeHtml(agent)}</option>`)
    .join("");
  els.agentFilter.value = agents.includes(previous) ? previous : "all";
}

function render() {
  const filtered = filteredActions();
  renderSummary(filtered);
  renderCostByFile(filtered);
  renderSlowestActions(filtered);
  renderModelComparison(filtered);
  renderPromptEfficiency(filtered);
  renderTokenSplit(filtered);
  renderErrorPanel(filtered);
  renderTimeline(filtered);
  renderTable(filtered);
  els.pricingSource.textContent = state.artifact?.pricingSource
    ? `${sourceLabel()} | Pricing: ${state.artifact.pricingSource}`
    : sourceLabel();
}

function sourceLabel() {
  if (state.artifact?.dashboardSource) {
    const source = state.artifact.dashboardSource;
    const mode = source.mode === "postgres" ? "Postgres dashboard ingest" : "Memory dashboard ingest";
    return `${mode} | started ${formatDate(source.startedAt)} | ${formatInteger(source.actionCount ?? 0)} actions stored`;
  }
  if (state.artifact?.gitlabSource) {
    const source = state.artifact.gitlabSource;
    return `GitLab pipeline ${source.pipelineId}, ${source.jobName} #${source.jobId}`;
  }
  if (state.artifact?.error) return `Error: ${state.artifact.error}`;
  return "Live dashboard ingest";
}

function filteredActions() {
  const runId = els.runFilter.value;
  const agent = els.agentFilter.value;
  const status = els.statusFilter.value;
  const query = els.searchInput.value.trim().toLowerCase();

  return state.actions.filter((action) => {
    if (runId !== "all" && action.runId !== runId) return false;
    if (agent !== "all" && action.agent !== agent) return false;
    if (status !== "all" && action.status !== status) return false;
    if (!query) return true;
    return [
      action.agent,
      action.action,
      action.target,
      action.model,
      action.status,
      action.error,
      JSON.stringify(action.metadata ?? {}),
    ]
      .join(" ")
      .toLowerCase()
      .includes(query);
  });
}

function renderSummary(actions) {
  const totals = actions.reduce(
    (acc, action) => {
      acc.cost += Number(action.costUsd ?? 0);
      acc.tokens += Number(action.tokens?.totalTokens ?? 0);
      acc.time += Number(action.durationMs ?? 0);
      return acc;
    },
    { cost: 0, tokens: 0, time: 0 },
  );

  els.totalCost.textContent = formatCost(totals.cost);
  els.totalTokens.textContent = formatInteger(totals.tokens);
  els.totalTime.textContent = formatDuration(totals.time);
  els.totalActions.textContent = formatInteger(actions.length);
}

function renderCostByFile(actions) {
  const byFile = new Map();
  for (const action of actions) {
    const file = normalizeTargetFile(action.target);
    if (!file) continue;
    const current = byFile.get(file) ?? { file, cost: 0, time: 0, tokens: 0, actions: 0 };
    current.cost += Number(action.costUsd ?? 0);
    current.time += Number(action.durationMs ?? 0);
    current.tokens += Number(action.tokens?.totalTokens ?? 0);
    current.actions += 1;
    byFile.set(file, current);
  }

  const rows = [...byFile.values()].sort((a, b) => b.cost - a.cost).slice(0, 8);
  els.fileCount.textContent = `${formatInteger(byFile.size)} files`;
  els.costByFile.innerHTML = rows.length
    ? rows
        .map(
          (row) => `
            <div class="rank-item">
              <div class="rank-main">
                <div class="rank-title" title="${escapeAttr(row.file)}">${escapeHtml(row.file)}</div>
                <div class="rank-meta">${formatInteger(row.tokens)} tokens · ${formatDuration(row.time)} · ${formatInteger(row.actions)} actions</div>
              </div>
              <div class="rank-value">${formatCost(row.cost)}</div>
            </div>
          `,
        )
        .join("")
    : `<div class="empty">No file targets found.</div>`;
}

function renderSlowestActions(actions) {
  const rows = actions
    .slice()
    .sort((a, b) => Number(b.durationMs ?? 0) - Number(a.durationMs ?? 0))
    .slice(0, 8);
  els.slowActionCount.textContent = `${formatInteger(rows.length)} shown`;
  els.slowestActions.innerHTML = rows.length
    ? rows
        .map(
          (action) => `
            <div class="rank-item">
              <div class="rank-main">
                <div class="rank-title">${escapeHtml(action.action ?? "")}</div>
                <div class="rank-meta" title="${escapeAttr(action.target ?? "")}">${escapeHtml(action.agent ?? "")} · ${escapeHtml(action.target ?? "")}</div>
              </div>
              <div class="rank-value">${formatDuration(action.durationMs ?? 0)}</div>
            </div>
          `,
        )
        .join("")
    : `<div class="empty">No actions found.</div>`;
}

function renderModelComparison(actions) {
  const byModel = new Map();
  for (const action of actions) {
    const model = action.model || "unknown";
    const current = byModel.get(model) ?? { model, actions: 0, tokens: 0, cost: 0, time: 0 };
    current.actions += 1;
    current.tokens += Number(action.tokens?.totalTokens ?? 0);
    current.cost += Number(action.costUsd ?? 0);
    current.time += Number(action.durationMs ?? 0);
    byModel.set(model, current);
  }

  const rows = [...byModel.values()].sort((a, b) => b.cost - a.cost);
  els.modelCount.textContent = `${formatInteger(rows.length)} models`;
  els.modelComparison.innerHTML = rows.length
    ? rows
        .map(
          (row) => `
            <tr>
              <td>${escapeHtml(row.model)}</td>
              <td class="mono">${formatInteger(row.actions)}</td>
              <td class="mono">${formatInteger(row.tokens)}</td>
              <td class="mono">${formatCost(row.cost)}</td>
              <td class="mono">${formatDuration(row.time)}</td>
            </tr>
          `,
        )
        .join("")
    : `<tr><td class="empty" colspan="5">No model data.</td></tr>`;
}

function renderPromptEfficiency(actions) {
  const reviewActions = actions.filter((action) => action.action === "review-file");
  const findings = reviewActions.reduce(
    (total, action) => total + Number(action.metadata?.findingCount ?? 0),
    0,
  );
  const cost = reviewActions.reduce((total, action) => total + Number(action.costUsd ?? 0), 0);
  const tokens = reviewActions.reduce(
    (total, action) => total + Number(action.tokens?.totalTokens ?? 0),
    0,
  );
  const time = reviewActions.reduce((total, action) => total + Number(action.durationMs ?? 0), 0);
  const divisor = findings > 0 ? findings : 1;

  els.efficiencyScope.textContent = `${formatInteger(reviewActions.length)} review prompts`;
  els.findingCount.textContent = formatInteger(findings);
  els.costPerFinding.textContent = findings > 0 ? formatCost(cost / divisor) : "$0.00000";
  els.tokensPerFinding.textContent = findings > 0 ? formatInteger(Math.round(tokens / divisor)) : "0";
  els.timePerFinding.textContent = findings > 0 ? formatDuration(time / divisor) : "0 ms";
}

function renderTokenSplit(actions) {
  const totals = actions.reduce(
    (acc, action) => {
      const tokens = action.tokens ?? {};
      acc.input += Number(tokens.inputTokens ?? 0);
      acc.output += Number(tokens.outputTokens ?? 0);
      acc.cacheWrite += Number(tokens.cacheCreationInputTokens ?? 0);
      acc.cacheRead += Number(tokens.cacheReadInputTokens ?? 0);
      return acc;
    },
    { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
  );
  const total = totals.input + totals.output + totals.cacheWrite + totals.cacheRead;
  els.tokenSplitTotal.textContent = `${formatInteger(total)} tokens`;

  const segments = [
    ["Input", totals.input, "split-input"],
    ["Output", totals.output, "split-output"],
    ["Cache write", totals.cacheWrite, "split-cache-write"],
    ["Cache read", totals.cacheRead, "split-cache-read"],
  ];

  if (total === 0) {
    els.tokenSplit.innerHTML = "";
    els.tokenSplitLegend.innerHTML = `<div class="empty">No token usage found.</div>`;
    return;
  }

  els.tokenSplit.innerHTML = segments
    .filter(([, value]) => value > 0)
    .map(([, value, className]) => {
      const width = Math.max(1, (value / total) * 100);
      return `<div class="split-segment ${className}" style="width:${width}%"></div>`;
    })
    .join("");

  els.tokenSplitLegend.innerHTML = segments
    .map(([label, value, className]) => {
      const percent = total > 0 ? (value / total) * 100 : 0;
      return `
        <div class="legend-item">
          <span class="legend-dot ${className}"></span>
          <span class="legend-label">${escapeHtml(label)}</span>
          <span class="legend-value mono">${formatInteger(value)} · ${percent.toFixed(1)}%</span>
        </div>
      `;
    })
    .join("");
}

function renderErrorPanel(actions) {
  const errors = actions.filter((action) => action.status === "error" || action.error);
  const grouped = new Map();
  for (const action of errors) {
    const message = action.error || "Unknown error";
    const current = grouped.get(message) ?? {
      message,
      count: 0,
      cost: 0,
      time: 0,
      examples: new Set(),
    };
    current.count += 1;
    current.cost += Number(action.costUsd ?? 0);
    current.time += Number(action.durationMs ?? 0);
    if (action.target) current.examples.add(action.target);
    grouped.set(message, current);
  }

  const rows = [...grouped.values()].sort((a, b) => b.count - a.count).slice(0, 8);
  els.errorCount.textContent = `${formatInteger(errors.length)} errors`;
  els.errorPanel.innerHTML = rows.length
    ? rows
        .map((row) => {
          const examples = [...row.examples].slice(0, 2).join(", ");
          return `
            <div class="rank-item">
              <div class="rank-main">
                <div class="rank-title" title="${escapeAttr(row.message)}">${escapeHtml(row.message)}</div>
                <div class="rank-meta" title="${escapeAttr(examples)}">${escapeHtml(examples || "No target captured")} · ${formatDuration(row.time)} · ${formatCost(row.cost)}</div>
              </div>
              <div class="rank-value">${formatInteger(row.count)}</div>
            </div>
          `;
        })
        .join("")
    : `<div class="empty">No failed actions. Suspiciously clean.</div>`;
}

function renderTimeline(actions) {
  if (actions.length === 0) {
    els.timeline.innerHTML = `<div class="empty">No telemetry received yet. Start agents with GITAGENTS_DASHBOARD_URL pointing here.</div>`;
    return;
  }

  const topActions = actions.slice(0, 24);
  const maxCost = Math.max(...topActions.map((action) => Number(action.costUsd ?? 0)), 0.000001);
  els.timeline.innerHTML = topActions
    .map((action) => {
      const width = Math.max(2, (Number(action.costUsd ?? 0) / maxCost) * 100);
      return `
        <div class="bar-row">
          <div class="bar-label" title="${escapeAttr(action.target ?? action.action)}">${escapeHtml(action.action)} ${escapeHtml(action.target ?? "")}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${width}%"></div></div>
          <div class="bar-cost mono">${formatCost(action.costUsd ?? 0)}</div>
        </div>
      `;
    })
    .join("");
}

function renderTable(actions) {
  if (actions.length === 0) {
    els.actionsBody.innerHTML = `<tr><td class="empty" colspan="9">No matching actions.</td></tr>`;
    return;
  }

  els.actionsBody.innerHTML = actions
    .map((action, index) => {
      const tokens = action.tokens ?? {};
      return `
        <tr data-index="${index}">
          <td class="mono">${formatDate(action.startedAt)}</td>
          <td>${escapeHtml(action.agent ?? "")}</td>
          <td>${escapeHtml(action.action ?? "")}</td>
          <td class="target-cell" title="${escapeAttr(action.target ?? "")}">${escapeHtml(action.target ?? "")}</td>
          <td><span class="pill ${action.status === "error" ? "error" : "ok"}">${escapeHtml(action.status ?? "ok")}</span></td>
          <td>${escapeHtml(action.model ?? "")}</td>
          <td class="mono">${formatInteger(tokens.totalTokens ?? 0)}</td>
          <td class="mono">${formatCost(action.costUsd ?? 0)}</td>
          <td class="mono">${formatDuration(action.durationMs ?? 0)}</td>
        </tr>
      `;
    })
    .join("");

  [...els.actionsBody.querySelectorAll("tr[data-index]")].forEach((row) => {
    row.addEventListener("click", () => showDetail(actions[Number(row.dataset.index)]));
  });
}

function showDetail(action) {
  const tokens = action.tokens ?? {};
  const pricing = action.pricing ?? {};
  const rows = [
    ["Run", action.runId],
    ["Action", action.action],
    ["Agent", action.agent],
    ["Target", action.target],
    ["Status", action.status],
    ["Model", action.model],
    ["Started", formatDate(action.startedAt)],
    ["Ended", formatDate(action.endedAt)],
    ["Duration", formatDuration(action.durationMs ?? 0)],
    ["Input tokens", formatInteger(tokens.inputTokens ?? 0)],
    ["Output tokens", formatInteger(tokens.outputTokens ?? 0)],
    ["Cache write tokens", formatInteger(tokens.cacheCreationInputTokens ?? 0)],
    ["Cache read tokens", formatInteger(tokens.cacheReadInputTokens ?? 0)],
    ["Total tokens", formatInteger(tokens.totalTokens ?? 0)],
    ["Cost", formatCost(action.costUsd ?? 0)],
    ["Input $/MTok", pricing.inputPerMillion],
    ["Output $/MTok", pricing.outputPerMillion],
    ["Error", action.error],
    ["Metadata", action.metadata ? JSON.stringify(action.metadata, null, 2) : ""],
  ];

  els.detailList.innerHTML = rows
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd class="mono">${escapeHtml(String(value))}</dd>`)
    .join("");
  els.detailPanel.classList.add("open");
}

function formatCost(value) {
  return `$${Number(value).toFixed(Number(value) >= 1 ? 2 : 5)}`;
}

function formatInteger(value) {
  return new Intl.NumberFormat().format(Number(value));
}

function formatDuration(ms) {
  const value = Number(ms);
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60000) return `${(value / 1000).toFixed(1)} s`;
  return `${(value / 60000).toFixed(1)} min`;
}

function formatDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function normalizeTargetFile(target) {
  if (!target) return "";
  const value = String(target);
  const lineSuffix = value.match(/^(.*):\d+$/);
  return lineSuffix ? lineSuffix[1] : value;
}

function shortRunId(runId) {
  const value = String(runId);
  return value.length > 34 ? `${value.slice(0, 24)}...${value.slice(-7)}` : value;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}
