import crypto from "node:crypto";
import express from "express";
import session from "express-session";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import { createServer } from "node:http";

export class DashboardService {
  #logger;
  #config;
  #warningModel;
  #moderationActionModel;
  #server;
  #client;
  #app;
  #sessionSecret;

  constructor({ config, logger, warningModel, moderationActionModel }) {
    this.#logger = logger;
    this.#config = this.#normalizeConfig(config);
    this.#warningModel = warningModel;
    this.#moderationActionModel = moderationActionModel;
    this.#sessionSecret = null;
  }

  setClient(client) {
    this.#client = client;
  }

  async start() {
    if (!this.#config.enabled) {
      this.#logger?.info?.("dashboard.disabled", { reason: "config" });
      return;
    }

    if (!this.#config.username || !this.#config.passwordHash) {
      this.#logger?.warn?.("dashboard.misconfigured", {
        reason: "missing_credentials"
      });
      return;
    }

    if (this.#server) return;

    this.#app = express();
    this.#app.disable("x-powered-by");

    if (this.#config.trustProxy) {
      this.#app.set("trust proxy", this.#config.trustProxy === true ? 1 : this.#config.trustProxy);
    }

    this.#app.use(helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'none'"],
          frameAncestors: ["'none'"]
        }
      },
      referrerPolicy: { policy: "no-referrer" },
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: "same-origin" }
    }));

    this.#app.use(express.json({ limit: "256kb" }));
    this.#app.use(express.urlencoded({ extended: false, limit: "256kb" }));

    const sessionSecret = this.#getSessionSecret();
    const secureCookies = Boolean(this.#config.secureCookies);
    const maxAge = Number.isFinite(this.#config.sessionMaxAgeMs)
      ? Math.max(60_000, this.#config.sessionMaxAgeMs)
      : 60 * 60_000;

    if (!secureCookies) {
      this.#logger?.warn?.("dashboard.cookies.insecure", {
        message: "Session cookies are not marked secure; enable HTTPS and set privateDashboard.secureCookies=true in production."
      });
    }

    if (!this.#config.sessionSecret) {
      this.#logger?.warn?.("dashboard.session_secret.fallback", {
        message: "Falling back to an ephemeral session secret; configure privateDashboard.sessionSecret for persistent sessions."
      });
    }

    this.#app.use(session({
      name: "dashboard.sid",
      secret: sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: "strict",
        secure: secureCookies,
        maxAge
      }
    }));

    const basePath = this.#normalizeBasePath(this.#config.basePath);
    const router = express.Router();

    const apiLimiter = this.#createRateLimiter(this.#config.rateLimit, "dashboard.api.rate_limit");
    const loginLimiter = this.#createRateLimiter(this.#config.loginRateLimit, "dashboard.login.rate_limit");

    if (apiLimiter) {
      router.use("/api", apiLimiter);
      router.use("/auth/logout", apiLimiter);
    }

    router.get("/health", (_req, res) => {
      res.json({ status: "ok", uptime: process.uptime() });
    });

    router.post("/auth/login", loginLimiter ?? ((req, _res, next) => next()), (req, res) => this.#handleLogin(req, res));
    router.post("/auth/logout", this.#authMiddleware(), async (req, res) => {
      try {
        await new Promise((resolve, reject) => {
          const session = req.session;
          if (!session) {
            resolve();
            return;
          }
          session.destroy((error) => {
            if (error) reject(error);
            else resolve();
          });
        });
        res.json({ ok: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.#logger?.error?.("dashboard.logout_error", { error: message });
        res.status(500).json({ error: "Failed to logout" });
      }
    });

    router.get("/auth/session", (req, res) => {
      res.json({
        authenticated: this.#isAuthenticated(req),
        username: this.#getSessionUsername(req) || null
      });
    });

    router.use("/api", this.#authMiddleware());

    router.get("/api/users", async (req, res) => {
      try {
        const guildId = req.query.guildId ? String(req.query.guildId) : null;
        const summaries = await this.#fetchUserSummaries({ guildId });
        res.json({ users: summaries });
      } catch (error) {
        this.#handleRouteError(error, res, "dashboard.users.list_error");
      }
    });

    router.get("/api/users/:userId", async (req, res) => {
      try {
        const guildId = req.query.guildId ? String(req.query.guildId) : null;
        const details = await this.#fetchUserDetail({ userId: req.params.userId, guildId });
        if (!details) {
          res.status(404).json({ error: "User not found" });
          return;
        }
        res.json(details);
      } catch (error) {
        this.#handleRouteError(error, res, "dashboard.users.detail_error");
      }
    });

    router.get("/", (req, res) => {
      res.type("html").send(this.#renderPage({
        basePath,
        authenticated: this.#isAuthenticated(req),
        username: this.#getSessionUsername(req)
      }));
    });

    this.#app.use(basePath, router);

    await new Promise((resolve, reject) => {
      this.#server = createServer(this.#app);
      this.#server.once("error", (error) => {
        this.#logger?.error?.("dashboard.start_error", { error: String(error?.message || error) });
        reject(error);
      });
      this.#server.listen(this.#config.port, () => {
        this.#logger?.info?.("dashboard.started", { port: this.#config.port, basePath });
        resolve();
      });
    });
  }

  async stop() {
    if (!this.#server) return;
    await new Promise(resolve => this.#server.close(resolve));
    this.#server = null;
  }

  #normalizeConfig(config) {
    const normalized = {
      enabled: true,
      port: 3080,
      basePath: "/",
      guildAllowList: [],
      username: "",
      passwordHash: "",
      sessionSecret: "",
      secureCookies: true,
      trustProxy: false,
      rateLimit: { windowMs: 60_000, max: 100 },
      loginRateLimit: { windowMs: 15 * 60_000, max: 10 },
      sessionMaxAgeMs: 60 * 60_000
    };

    if (config && typeof config === "object") {
      if (typeof config.enabled === "boolean") normalized.enabled = config.enabled;
      if (Number.isFinite(config.port)) normalized.port = config.port;
      if (typeof config.basePath === "string") normalized.basePath = config.basePath.trim() || "/";
      if (Array.isArray(config.guildAllowList)) {
        normalized.guildAllowList = config.guildAllowList
          .map((value) => String(value).trim())
          .filter(Boolean);
      }
      if (typeof config.username === "string") normalized.username = config.username.trim();
      if (typeof config.passwordHash === "string") normalized.passwordHash = config.passwordHash.trim();
      if (typeof config.sessionSecret === "string") normalized.sessionSecret = config.sessionSecret.trim();
      if (typeof config.secureCookies === "boolean") normalized.secureCookies = config.secureCookies;
      if (config.trustProxy !== undefined) normalized.trustProxy = config.trustProxy;
      if (config.rateLimit && typeof config.rateLimit === "object") {
        if (Number.isFinite(config.rateLimit.windowMs)) normalized.rateLimit.windowMs = Math.max(1, config.rateLimit.windowMs);
        if (Number.isFinite(config.rateLimit.max)) normalized.rateLimit.max = Math.max(1, config.rateLimit.max);
      }
      if (config.loginRateLimit && typeof config.loginRateLimit === "object") {
        if (Number.isFinite(config.loginRateLimit.windowMs)) normalized.loginRateLimit.windowMs = Math.max(1, config.loginRateLimit.windowMs);
        if (Number.isFinite(config.loginRateLimit.max)) normalized.loginRateLimit.max = Math.max(1, config.loginRateLimit.max);
      }
      if (Number.isFinite(config.sessionMaxAgeMs)) {
        normalized.sessionMaxAgeMs = Math.max(60_000, config.sessionMaxAgeMs);
      }
    }

    normalized.basePath = this.#normalizeBasePath(normalized.basePath);
    return normalized;
  }

  #normalizeBasePath(basePath) {
    let normalized = typeof basePath === "string" ? basePath.trim() : "/";
    if (!normalized.startsWith("/")) normalized = `/${normalized}`;
    if (normalized.length > 1 && normalized.endsWith("/")) {
      normalized = normalized.slice(0, -1);
    }
    return normalized || "/";
  }

  #createRateLimiter(options, metricKey) {
    if (!options || typeof options !== "object") return null;
    const windowMs = Number.isFinite(options.windowMs) ? Math.max(1, options.windowMs) : null;
    const max = Number.isFinite(options.max) ? Math.max(1, options.max) : null;
    if (!windowMs || !max) return null;
    return rateLimit({
      windowMs,
      max,
      standardHeaders: true,
      legacyHeaders: false,
      handler: (req, res) => {
        this.#logger?.warn?.(metricKey, {
          ip: req.ip,
          message: "Rate limit exceeded"
        });
        res.status(429).json({ error: "Too many requests" });
      }
    });
  }

  #authMiddleware(options = {}) {
    const { optional = false } = options;
    return (req, res, next) => {
      if (this.#isAuthenticated(req)) {
        res.setHeader("Cache-Control", "no-store");
        next();
        return;
      }
      if (optional) {
        next();
        return;
      }
      res.setHeader("WWW-Authenticate", "Session realm=\"Private Dashboard\"");
      res.status(401).json({ error: "Unauthorized" });
    };
  }

  #isAuthenticated(req) {
    return Boolean(req.session?.authenticated);
  }

  #getSessionUsername(req) {
    const value = req.session?.username;
    return typeof value === "string" ? value : "";
  }

  async #handleLogin(req, res) {
    const { username, password } = req.body ?? {};
    if (typeof username !== "string" || typeof password !== "string") {
      res.status(400).json({ error: "Invalid request" });
      return;
    }

    const providedUsername = username.trim();
    const providedPassword = password;

    if (!providedUsername || !providedPassword) {
      res.status(400).json({ error: "Username and password are required" });
      return;
    }

    let passwordMatches = false;
    try {
      passwordMatches = await bcrypt.compare(providedPassword, this.#config.passwordHash);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#logger?.error?.("dashboard.password_compare_error", { error: message });
    }

    const usernameMatches = this.#safeCompare(providedUsername, this.#config.username);

    if (!passwordMatches || !usernameMatches) {
      this.#logger?.warn?.("dashboard.login_failed", {
        ip: req.ip,
        usernameAttempt: providedUsername
      });
      await new Promise(resolve => setTimeout(resolve, 150));
      res.status(401).json({ error: "Invalid username or password" });
      return;
    }

    await new Promise((resolve) => {
      req.session.regenerate((error) => {
        if (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.#logger?.error?.("dashboard.session_regenerate_failed", { error: message });
          res.status(500).json({ error: "Failed to establish session" });
          resolve();
          return;
        }
        req.session.authenticated = true;
        req.session.username = this.#config.username;
        req.session.createdAt = Date.now();
        res.json({ ok: true, username: this.#config.username });
        resolve();
      });
    });
  }

  #safeCompare(a, b) {
    if (typeof a !== "string" || typeof b !== "string") return false;
    const bufferA = Buffer.from(a);
    const bufferB = Buffer.from(b);
    const len = Math.max(bufferA.length, bufferB.length, 1);
    const paddedA = Buffer.alloc(len);
    const paddedB = Buffer.alloc(len);
    bufferA.copy(paddedA);
    bufferB.copy(paddedB);
    return crypto.timingSafeEqual(paddedA, paddedB) && bufferA.length === bufferB.length;
  }

  #getSessionSecret() {
    if (this.#config.sessionSecret) {
      return this.#config.sessionSecret;
    }
    if (!this.#sessionSecret) {
      this.#sessionSecret = crypto.randomBytes(32).toString("hex");
    }
    return this.#sessionSecret;
  }

  async #fetchUserSummaries({ guildId }) {
    const allowList = Array.isArray(this.#config.guildAllowList) ? this.#config.guildAllowList : [];
    const restrictGuild = guildId || (allowList.length ? allowList : null);

    const matchStage = {};
    if (restrictGuild) {
      if (Array.isArray(restrictGuild) && restrictGuild.length) {
        matchStage.guildId = { $in: restrictGuild };
      } else if (!Array.isArray(restrictGuild)) {
        matchStage.guildId = restrictGuild;
      }
    }

    const warningPipeline = [
      ...(Object.keys(matchStage).length ? [{ $match: matchStage }] : []),
      {
        $group: {
          _id: "$userId",
          guildIds: { $addToSet: "$guildId" },
          warningCount: { $sum: 1 },
          lastWarningAt: { $max: "$createdAt" }
        }
      },
      {
        $project: {
          _id: 0,
          userId: "$_id",
          guildIds: 1,
          warningCount: 1,
          lastWarningAt: 1
        }
      }
    ];

    const actionMatch = { ...matchStage };
    if (actionMatch.guildId && Array.isArray(actionMatch.guildId) && !actionMatch.guildId.length) {
      delete actionMatch.guildId;
    }

    const actionTotalsPipeline = [
      ...(Object.keys(actionMatch).length ? [{ $match: actionMatch }] : []),
      {
        $group: {
          _id: "$userId",
          totalActions: { $sum: 1 },
          lastActionAt: { $max: "$createdAt" },
          guildIds: { $addToSet: "$guildId" }
        }
      },
      {
        $project: {
          _id: 0,
          userId: "$_id",
          totalActions: 1,
          lastActionAt: 1,
          guildIds: 1
        }
      }
    ];

    const actionBreakdownPipeline = [
      ...(Object.keys(actionMatch).length ? [{ $match: actionMatch }] : []),
      {
        $group: {
          _id: { userId: "$userId", action: "$action" },
          count: { $sum: 1 }
        }
      }
    ];

    const [warningData, actionTotals, actionBreakdown] = await Promise.all([
      this.#warningModel.aggregate(warningPipeline),
      this.#moderationActionModel.aggregate(actionTotalsPipeline),
      this.#moderationActionModel.aggregate(actionBreakdownPipeline)
    ]);

    const summaryMap = new Map();

    const ensureEntry = (userId) => {
      if (!summaryMap.has(userId)) {
        summaryMap.set(userId, {
          userId,
          guildIds: new Set(),
          warningCount: 0,
          totalActions: 0,
          lastWarningAt: null,
          lastActionAt: null,
          actionBreakdown: {}
        });
      }
      return summaryMap.get(userId);
    };

    for (const entry of warningData) {
      const sum = ensureEntry(entry.userId);
      sum.warningCount = entry.warningCount || 0;
      if (entry.lastWarningAt && (!sum.lastWarningAt || entry.lastWarningAt > sum.lastWarningAt)) {
        sum.lastWarningAt = entry.lastWarningAt;
      }
      (entry.guildIds || []).forEach(id => sum.guildIds.add(id));
    }

    for (const entry of actionTotals) {
      const sum = ensureEntry(entry.userId);
      sum.totalActions = entry.totalActions || 0;
      if (entry.lastActionAt && (!sum.lastActionAt || entry.lastActionAt > sum.lastActionAt)) {
        sum.lastActionAt = entry.lastActionAt;
      }
      (entry.guildIds || []).forEach(id => sum.guildIds.add(id));
    }

    for (const entry of actionBreakdown) {
      const userId = entry._id?.userId;
      const action = entry._id?.action || "unknown";
      if (!userId) continue;
      const sum = ensureEntry(userId);
      sum.actionBreakdown[action] = (sum.actionBreakdown[action] || 0) + (entry.count || 0);
    }

    const result = [];
    for (const sum of summaryMap.values()) {
      const discordUser = this.#resolveDiscordUser(sum.userId);
      result.push({
        userId: sum.userId,
        guildIds: [...sum.guildIds],
        warningCount: sum.warningCount,
        totalActions: sum.totalActions,
        lastWarningAt: sum.lastWarningAt ? new Date(sum.lastWarningAt).toISOString() : null,
        lastActionAt: sum.lastActionAt ? new Date(sum.lastActionAt).toISOString() : null,
        actionBreakdown: sum.actionBreakdown,
        user: discordUser
      });
    }

    result.sort((a, b) => {
      const scoreA = (a.warningCount || 0) + (a.totalActions || 0);
      const scoreB = (b.warningCount || 0) + (b.totalActions || 0);
      if (scoreA !== scoreB) return scoreB - scoreA;
      return a.userId.localeCompare(b.userId);
    });

    return result;
  }

  async #fetchUserDetail({ userId, guildId }) {
    if (!userId) return null;
    const filter = { userId: String(userId) };
    const allowList = this.#config.guildAllowList;
    if (guildId) {
      filter.guildId = guildId;
    } else if (allowList.length) {
      filter.guildId = { $in: allowList };
    }

    const [warnings, actions] = await Promise.all([
      this.#warningModel.find(filter).sort({ createdAt: -1 }).limit(100).lean(),
      this.#moderationActionModel.find(filter).sort({ createdAt: -1 }).limit(100).lean()
    ]);

    if (!warnings.length && !actions.length) return null;

    const discordUser = this.#resolveDiscordUser(userId);

    return {
      userId: String(userId),
      user: discordUser,
      warningCount: warnings.length,
      actionCount: actions.length,
      warnings: warnings.map((w) => ({
        id: String(w._id || ""),
        guildId: w.guildId,
        modId: w.modId,
        reason: w.reason,
        createdAt: w.createdAt instanceof Date ? w.createdAt.toISOString() : w.createdAt
      })),
      actions: actions.map((a) => ({
        id: String(a._id || ""),
        guildId: a.guildId,
        moderatorId: a.moderatorId,
        action: a.action,
        reason: a.reason,
        caseNumber: a.caseNumber,
        createdAt: a.createdAt instanceof Date ? a.createdAt.toISOString() : a.createdAt,
        durationMs: a.durationMs ?? null,
        expiresAt: a.expiresAt instanceof Date ? a.expiresAt.toISOString() : a.expiresAt,
        metadata: a.metadata ?? null
      }))
    };
  }

  #resolveDiscordUser(userId) {
    if (!this.#client?.users) return null;
    const cached = this.#client.users.cache?.get?.(userId);
    if (!cached) return null;
    const base = {
      id: cached.id,
      username: cached.username,
      discriminator: cached.discriminator,
      tag: cached.tag
    };
    try {
      const avatar = cached.displayAvatarURL?.({ size: 128 });
      if (avatar) base.avatarUrl = avatar;
    } catch {
      // ignore display avatar errors
    }
    return base;
  }

  #handleRouteError(error, res, logKey) {
    const message = error instanceof Error ? error.message : String(error);
    this.#logger?.error?.(logKey, { error: message });
    res.status(500).json({ error: "Internal server error" });
  }

  #renderPage({ basePath, authenticated, username }) {
    const base = this.#normalizeBasePath(basePath);
    const apiBase = base === "/" ? "/api" : `${base}/api`;
    const authBase = base === "/" ? "/auth" : `${base}/auth`;
    const authenticatedJson = JSON.stringify(Boolean(authenticated));
    const usernameJson = JSON.stringify(username || "");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Private User Dashboard</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 0; padding: 1.5rem; background: #0f172a; color: #e2e8f0; }
    h1 { margin-bottom: 0.25rem; }
    h2 { margin-top: 0; }
    table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
    th, td { border: 1px solid #1e293b; padding: 0.5rem; text-align: left; }
    th { background: #1e3a8a; }
    tr:nth-child(even) { background: rgba(148, 163, 184, 0.1); }
    .avatar { width: 32px; height: 32px; border-radius: 50%; object-fit: cover; }
    .user-cell { display: flex; align-items: center; gap: 0.75rem; }
    .meta { font-size: 0.85rem; color: #94a3b8; }
    .tag { font-family: monospace; font-size: 0.95rem; }
    .last-active { white-space: nowrap; }
    .error { color: #f87171; margin-top: 1rem; }
    .filters { display: flex; gap: 0.75rem; align-items: flex-end; flex-wrap: wrap; }
    label { display: flex; flex-direction: column; font-size: 0.85rem; gap: 0.25rem; }
    input, select { padding: 0.4rem 0.5rem; border-radius: 0.5rem; border: 1px solid #475569; background: #0f172a; color: inherit; }
    button { padding: 0.5rem 0.75rem; border-radius: 0.5rem; border: 1px solid transparent; background: #2563eb; color: white; cursor: pointer; }
    button:hover { background: #1d4ed8; }
    main { max-width: 1100px; margin: 0 auto; }
    .card { background: rgba(15, 23, 42, 0.9); border: 1px solid #1e293b; border-radius: 0.75rem; padding: 1.5rem; margin-top: 1rem; }
    form { display: flex; flex-direction: column; gap: 1rem; }
    .actions { display: flex; gap: 0.75rem; align-items: center; }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Private User Dashboard</h1>
      <p class="meta" id="session-meta"></p>
    </header>
    <section id="login-section" class="card" hidden>
      <h2>Administrator Sign In</h2>
      <form id="login-form" autocomplete="on">
        <label>Username
          <input id="login-username" name="username" type="text" autocomplete="username" required />
        </label>
        <label>Password
          <input id="login-password" name="password" type="password" autocomplete="current-password" required />
        </label>
        <div class="actions">
          <button type="submit">Sign in</button>
          <span class="meta">Your credentials are transmitted securely and never stored in the browser.</span>
        </div>
      </form>
      <div class="error" id="login-error" hidden></div>
    </section>
    <section id="dashboard-section" class="card" hidden>
      <div class="actions" style="justify-content: space-between; flex-wrap: wrap; gap: 1rem;">
        <div class="filters">
          <label>Guild ID
            <input id="guild-filter" placeholder="Optional guild filter" />
          </label>
          <button id="refresh-btn" type="button">Refresh</button>
        </div>
        <button id="logout-btn" type="button" style="background:#ef4444;">Log out</button>
      </div>
      <div id="status" class="meta" style="margin-top: 1rem;">Loading…</div>
      <div class="error" id="error" hidden></div>
      <table id="user-table" hidden>
        <thead>
          <tr>
            <th>User</th>
            <th>Warnings</th>
            <th>Actions</th>
            <th>Last Warning</th>
            <th>Last Action</th>
            <th>Guilds</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </section>
  </main>
  <script>
    const API_BASE = ${JSON.stringify(apiBase)};
    const AUTH_BASE = ${JSON.stringify(authBase)};
    let isAuthenticated = ${authenticatedJson};
    let currentUser = ${usernameJson};

    const loginSection = document.getElementById('login-section');
    const dashboardSection = document.getElementById('dashboard-section');
    const loginForm = document.getElementById('login-form');
    const loginUsername = document.getElementById('login-username');
    const loginPassword = document.getElementById('login-password');
    const loginErrorEl = document.getElementById('login-error');
    const statusEl = document.getElementById('status');
    const tableEl = document.getElementById('user-table');
    const tbodyEl = tableEl.querySelector('tbody');
    const errorEl = document.getElementById('error');
    const guildFilterEl = document.getElementById('guild-filter');
    const refreshBtn = document.getElementById('refresh-btn');
    const logoutBtn = document.getElementById('logout-btn');
    const sessionMeta = document.getElementById('session-meta');

    function updateView() {
      if (isAuthenticated) {
        loginSection.hidden = true;
        dashboardSection.hidden = false;
        sessionMeta.textContent = currentUser ? 'Signed in as ' + currentUser : 'Signed in';
      } else {
        loginSection.hidden = false;
        dashboardSection.hidden = true;
        sessionMeta.textContent = 'Please sign in to access moderation data.';
        loginPassword.value = '';
      }
    }

    async function fetchSession() {
      try {
        const res = await fetch(AUTH_BASE + '/session', { credentials: 'include' });
        if (!res.ok) throw new Error('Session check failed');
        const data = await res.json();
        setAuthenticated(Boolean(data.authenticated), data.username || '');
      } catch {
        setAuthenticated(false, '');
      }
    }

    function setAuthenticated(state, username) {
      isAuthenticated = state;
      currentUser = username || '';
      updateView();
      if (state) {
        fetchUsers();
      } else {
        statusEl.textContent = 'You must sign in to view data.';
        tableEl.hidden = true;
        errorEl.hidden = true;
      }
    }

    async function login(username, password) {
      loginErrorEl.hidden = true;
      const res = await fetch(AUTH_BASE + '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username, password })
      });
      if (!res.ok) {
        let message = 'Login failed';
        try {
          const data = await res.json();
          if (data?.error) message = data.error;
        } catch {}
        loginErrorEl.textContent = message;
        loginErrorEl.hidden = false;
        return;
      }
      const data = await res.json();
      setAuthenticated(true, data.username || username);
    }

    async function logout() {
      try {
        await fetch(AUTH_BASE + '/logout', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' }
        });
      } finally {
        setAuthenticated(false, '');
      }
    }

    async function fetchUsers() {
      if (!isAuthenticated) return;
      statusEl.textContent = 'Loading…';
      errorEl.hidden = true;
      tableEl.hidden = true;
      tbodyEl.innerHTML = '';

      const params = new URLSearchParams();
      const guildId = guildFilterEl.value.trim();
      if (guildId) params.set('guildId', guildId);

      try {
        const query = params.toString();
        const url = API_BASE + '/users' + (query ? ('?' + query) : '');
        const res = await fetch(url, { credentials: 'include' });
        if (res.status === 401 || res.status === 403) {
          setAuthenticated(false, '');
          loginErrorEl.textContent = 'Session expired. Please sign in again.';
          loginErrorEl.hidden = false;
          return;
        }
        if (!res.ok) {
          throw new Error('Request failed with status ' + res.status);
        }
        const data = await res.json();
        renderTable(data.users || []);
        statusEl.textContent = data.users?.length ? (data.users.length + ' users loaded') : 'No users found';
        tableEl.hidden = !data.users?.length;
      } catch (error) {
        statusEl.textContent = 'Failed to load users';
        errorEl.textContent = error.message || 'Unknown error';
        errorEl.hidden = false;
      }
    }

    function renderTable(users) {
      tbodyEl.innerHTML = '';
      for (const user of users) {
        const tr = document.createElement('tr');
        const userCell = document.createElement('td');
        userCell.className = 'user-cell';
        if (user.user?.avatarUrl) {
          const img = document.createElement('img');
          img.src = user.user.avatarUrl;
          img.alt = user.user.tag || user.user.username || user.user.id;
          img.className = 'avatar';
          userCell.appendChild(img);
        }
        const metaWrap = document.createElement('div');
        const title = document.createElement('div');
        title.textContent = user.user?.username || user.user?.tag || user.userId;
        metaWrap.appendChild(title);
        const tag = document.createElement('div');
        tag.className = 'meta tag';
        tag.textContent = user.user?.tag || user.userId;
        metaWrap.appendChild(tag);
        userCell.appendChild(metaWrap);
        tr.appendChild(userCell);

        const warnCell = document.createElement('td');
        warnCell.textContent = user.warningCount ?? 0;
        tr.appendChild(warnCell);

        const actionsCell = document.createElement('td');
        actionsCell.textContent = user.totalActions ?? 0;
        tr.appendChild(actionsCell);

        const lastWarnCell = document.createElement('td');
        lastWarnCell.className = 'last-active';
        lastWarnCell.textContent = user.lastWarningAt ? new Date(user.lastWarningAt).toLocaleString() : '—';
        tr.appendChild(lastWarnCell);

        const lastActionCell = document.createElement('td');
        lastActionCell.className = 'last-active';
        lastActionCell.textContent = user.lastActionAt ? new Date(user.lastActionAt).toLocaleString() : '—';
        tr.appendChild(lastActionCell);

        const guildCell = document.createElement('td');
        guildCell.textContent = (user.guildIds || []).join(', ');
        tr.appendChild(guildCell);

        tbodyEl.appendChild(tr);
      }
    }

    loginForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const username = loginUsername.value.trim();
      const password = loginPassword.value;
      if (!username || !password) {
        loginErrorEl.textContent = 'Enter both username and password.';
        loginErrorEl.hidden = false;
        return;
      }
      login(username, password).catch((error) => {
        loginErrorEl.textContent = error.message || 'Login failed';
        loginErrorEl.hidden = false;
      });
    });

    refreshBtn.addEventListener('click', () => fetchUsers());
    logoutBtn.addEventListener('click', () => logout());

    updateView();
    if (isAuthenticated) {
      fetchUsers();
    } else {
      fetchSession();
    }
  </script>
</body>
</html>`;
  }
}
