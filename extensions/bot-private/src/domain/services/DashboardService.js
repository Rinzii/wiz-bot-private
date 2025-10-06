import crypto from "node:crypto";
import express from "express";
import session from "express-session";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import bcrypt from "bcrypt";
import { createServer } from "node:http";
import { ChannelType } from "discord.js";
import MongoStore from "connect-mongo";

export class DashboardService {
  #logger;
  #config;
  #warningModel;
  #moderationActionModel;
  #server;
  #client;
  #app;
  #sessionSecret;
  #warnedPlaintextPassword;

  constructor({ config, logger, warningModel, moderationActionModel }) {
    this.#logger = logger;
    this.#config = this.#normalizeConfig(config);
    this.#warningModel = warningModel;
    this.#moderationActionModel = moderationActionModel;
    this.#sessionSecret = null;
    this.#warnedPlaintextPassword = false;
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

    const trustProxySetting = this.#config.trustProxy;
    if (trustProxySetting) {
      // if true, default to 1 proxy hop; else accept numeric/string as provided
      this.#app.set("trust proxy", trustProxySetting === true ? 1 : trustProxySetting);
    }

    // Per-request CSP nonce
    this.#app.use((req, res, next) => {
      res.locals.cspNonce = crypto.randomBytes(16).toString("base64");
      next();
    });

    // Helmet with strict CSP + nonces (no unsafe-inline)
    this.#app.use(
      helmet({
        contentSecurityPolicy: {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: [
              "'self'",
              (req, res) => `'nonce-${res.locals.cspNonce}'`
            ],
            styleSrc: [
              "'self'",
              (req, res) => `'nonce-${res.locals.cspNonce}'`
            ],
            imgSrc: [
              "'self'",
              "data:",
              "https://cdn.discordapp.com",
              "https://media.discordapp.net"
            ],
            connectSrc: ["'self'"],
            objectSrc: ["'none'"],
            baseUri: ["'none'"],
            frameAncestors: ["'none'"]
          }
        },
        referrerPolicy: { policy: "no-referrer" },
        crossOriginEmbedderPolicy: false,
        crossOriginResourcePolicy: { policy: "same-origin" }
      })
    );

    this.#app.use(express.json({ limit: "256kb" }));
    this.#app.use(express.urlencoded({ extended: false, limit: "256kb" }));

    const sessionSecret = this.#getSessionSecret();
    const secureCookies =
      this.#config.secureCookies === "auto" ? "auto" : Boolean(this.#config.secureCookies);
    const maxAge = Number.isFinite(this.#config.sessionMaxAgeMs)
      ? Math.max(60_000, this.#config.sessionMaxAgeMs)
      : 60 * 60_000;

    if (secureCookies === false) {
      this.#logger?.warn?.("dashboard.cookies.insecure", {
        message:
          "Session cookies are not marked secure; enable HTTPS and set privateDashboard.secureCookies=true in production."
      });
    }

    if (!this.#config.sessionSecret) {
      this.#logger?.warn?.("dashboard.session_secret.fallback", {
        message:
          "Falling back to an ephemeral session secret; configure privateDashboard.sessionSecret for persistent sessions."
      });
    }

    // Optional persistent session store (best practice)
    let store = undefined;
    if (this.#config.sessionStoreMongoUri) {
      try {
        store = MongoStore.create({
          mongoUrl: this.#config.sessionStoreMongoUri,
          ttl: Math.ceil(maxAge / 1000)
        });
        this.#logger?.info?.("dashboard.session_store.mongo.enabled");
      } catch (err) {
        this.#logger?.error?.("dashboard.session_store.mongo.error", {
          error: String(err?.message || err)
        });
      }
    } else {
      this.#logger?.warn?.("dashboard.session_store.memory", {
        message:
          "Using in-memory session store (not recommended for production). Set privateDashboard.sessionStoreMongoUri."
      });
    }

    this.#app.use(
      session({
        name: "dashboard.sid",
        secret: sessionSecret,
        resave: false,
        saveUninitialized: false,
        proxy: Boolean(trustProxySetting),
        rolling: true,
        store,
        cookie: {
          httpOnly: true,
          sameSite: "strict",
          secure: secureCookies,
          maxAge
        }
      })
    );

    const basePath = this.#normalizeBasePath(this.#config.basePath);
    const router = express.Router();

    const apiLimiter = this.#createRateLimiter(
      this.#config.rateLimit,
      "dashboard.api.rate_limit"
    );
    const loginLimiter = this.#createRateLimiter(
      this.#config.loginRateLimit,
      "dashboard.login.rate_limit"
    );

    if (apiLimiter) {
      router.use("/api", apiLimiter);
      router.use("/auth/logout", apiLimiter);
    }

    router.get("/health", (_req, res) => {
      res.json({ status: "ok", uptime: process.uptime() });
    });

    router.post(
      "/auth/login",
      loginLimiter ?? ((req, _res, next) => next()),
      (req, res, next) => this.#handleLogin(req, res).catch(next)
    );

    router.post("/auth/logout", this.#authMiddleware(), async (req, res) => {
      try {
        await new Promise((resolve, reject) => {
          const sess = req.session;
          if (!sess) {
            resolve();
            return;
          }
          sess.destroy((error) => {
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

    router.get("/api/stats", async (req, res) => {
      try {
        const guildId = req.query.guildId ? String(req.query.guildId) : null;
        const stats = await this.#fetchServerStats({ guildId });
        res.json(stats);
      } catch (error) {
        this.#handleRouteError(error, res, "dashboard.stats.error");
      }
    });

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

    router.get("/api/guilds/:guildId/roles", async (req, res) => {
      try {
        const details = await this.#fetchGuildRoleDetails({ guildId: req.params.guildId });
        if (!details) {
          res.status(404).json({ error: "Guild not found" });
          return;
        }
        res.json(details);
      } catch (error) {
        this.#handleRouteError(error, res, "dashboard.roles.detail_error");
      }
    });

    router.get("/api/guilds/:guildId/channels", async (req, res) => {
      try {
        const details = await this.#fetchGuildChannelDetails({ guildId: req.params.guildId });
        if (!details) {
          res.status(404).json({ error: "Guild not found" });
          return;
        }
        res.json(details);
      } catch (error) {
        this.#handleRouteError(error, res, "dashboard.channels.detail_error");
      }
    });

    router.get("/", (req, res) => {
      res
        .type("html")
        .send(
          this.#renderPage({
            basePath,
            authenticated: this.#isAuthenticated(req),
            username: this.#getSessionUsername(req),
            cspNonce: res.locals.cspNonce
          })
        );
    });

    this.#app.use(basePath, router);

    await new Promise((resolve, reject) => {
      this.#server = createServer(this.#app);
      this.#server.once("error", (error) => {
        this.#logger?.error?.("dashboard.start_error", {
          error: String(error?.message || error)
        });
        reject(error);
      });
      this.#server.listen(this.#config.port, () => {
        this.#logger?.info?.("dashboard.started", {
          port: this.#config.port,
          basePath
        });
        resolve();
      });
    });
  }

  async stop() {
    if (!this.#server) return;
    await new Promise((resolve) => this.#server.close(resolve));
    this.#server = null;
  }

  getUrl() {
    const basePath = this.#normalizeBasePath(this.#config.basePath);

    // allow explicit publicBaseUrl override
    if (this.#config.publicBaseUrl) {
      try {
        return new URL(basePath, this.#config.publicBaseUrl).toString();
      } catch {
        // fall through
      }
    }

    const protocol = this.#config.secureCookies === true ? "https" : "http";
    const fallback = this.#buildDashboardUrl({
      hostname: "localhost",
      port: this.#config.port,
      basePath,
      protocol
    });

    if (!this.#server) return fallback;

    const address = this.#server.address();
    if (!address) return fallback;

    if (typeof address === "string") {
      try {
        return new URL(basePath, address).toString();
      } catch {
        return fallback;
      }
    }

    const hostname = this.#formatHostname(address.address);
    const port = address.port ?? this.#config.port;

    return (
      this.#buildDashboardUrl({
        hostname,
        port,
        basePath,
        protocol
      }) ?? fallback
    );
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
      sessionStoreMongoUri: "", // optional persistent store
      publicBaseUrl: "", // optional external URL override
      secureCookies: "auto",
      trustProxy: false,
      rateLimit: { windowMs: 60_000, max: 100 },
      loginRateLimit: { windowMs: 15 * 60_000, max: 10 },
      sessionMaxAgeMs: 60 * 60_000
    };

    if (config && typeof config === "object") {
      if (typeof config.enabled === "boolean") normalized.enabled = config.enabled;
      if (Number.isFinite(config.port)) normalized.port = config.port;
      if (typeof config.basePath === "string")
        normalized.basePath = config.basePath.trim() || "/";
      if (Array.isArray(config.guildAllowList)) {
        normalized.guildAllowList = config.guildAllowList
          .map((value) => String(value).trim())
          .filter(Boolean);
      }
      if (typeof config.username === "string") normalized.username = config.username.trim();
      if (typeof config.passwordHash === "string")
        normalized.passwordHash = config.passwordHash.trim();
      if (typeof config.sessionSecret === "string")
        normalized.sessionSecret = config.sessionSecret.trim();
      if (typeof config.publicBaseUrl === "string")
        normalized.publicBaseUrl = config.publicBaseUrl.trim();
      if (typeof config.sessionStoreMongoUri === "string")
        normalized.sessionStoreMongoUri = config.sessionStoreMongoUri.trim();
      if (config.secureCookies === "auto" || typeof config.secureCookies === "boolean") {
        normalized.secureCookies = config.secureCookies;
      }
      if (config.trustProxy !== undefined) normalized.trustProxy = config.trustProxy;
      if (config.rateLimit && typeof config.rateLimit === "object") {
        if (Number.isFinite(config.rateLimit.windowMs))
          normalized.rateLimit.windowMs = Math.max(1, config.rateLimit.windowMs);
        if (Number.isFinite(config.rateLimit.max))
          normalized.rateLimit.max = Math.max(1, config.rateLimit.max);
      }
      if (config.loginRateLimit && typeof config.loginRateLimit === "object") {
        if (Number.isFinite(config.loginRateLimit.windowMs))
          normalized.loginRateLimit.windowMs = Math.max(1, config.loginRateLimit.windowMs);
        if (Number.isFinite(config.loginRateLimit.max))
          normalized.loginRateLimit.max = Math.max(1, config.loginRateLimit.max);
      }
      if (Number.isFinite(config.sessionMaxAgeMs)) {
        normalized.sessionMaxAgeMs = Math.max(60_000, config.sessionMaxAgeMs);
      }
    }

    normalized.basePath = this.#normalizeBasePath(normalized.basePath);
    return normalized;
  }

  #buildDashboardUrl({ hostname, port, basePath, protocol }) {
    const sanitizedHostname =
      typeof hostname === "string" && hostname.length > 0 ? hostname : "localhost";
    const origin = port
      ? `${protocol}://${sanitizedHostname}:${port}`
      : `${protocol}://${sanitizedHostname}`;

    try {
      return new URL(basePath || "/", origin).toString();
    } catch {
      const suffix = !basePath || basePath === "/" ? "/" : basePath;
      return `${origin}${suffix}`;
    }
  }

  #formatHostname(address) {
    if (!address || address === "::" || address === "0.0.0.0") {
      return "localhost";
    }

    const mappedIpv4 = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : null;
    if (mappedIpv4) return mappedIpv4;

    if (address.includes(":")) {
      return `[${address}]`;
    }

    return address;
  }

  #normalizeBasePath(basePath) {
    let normalized = typeof basePath === "string" ? basePath.trim() : "/";
    if (!normalized.startsWith("/")) normalized = `/${normalized}`;
    if (normalized.length > 1 && normalized.endsWith("/")) {
      normalized = normalized.slice(0, -1);
    }
    return normalized || "/";
  }

  #requestPrefersHtml(req) {
    const accept = req?.headers?.accept;
    if (typeof accept !== "string" || accept.length === 0) return false;

    return accept
      .split(",")
      .map((value) => value.split(";")[0]?.trim().toLowerCase())
      .filter(Boolean)
      .some((type) => type === "text/html" || type === "application/xhtml+xml");
  }

  #requestAppearsSecure(req) {
    if (!req) return false;
    if (req.secure) return true;
    const forwarded = req.headers?.["x-forwarded-proto"];
    if (typeof forwarded === "string" && forwarded.length > 0) {
      return forwarded
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .includes("https");
    }
    return false;
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
      res.setHeader('WWW-Authenticate', 'Session realm="Private Dashboard"');
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
    const trimmedUsername = typeof username === "string" ? username.trim() : "";
    const attemptContext = {
      ip: req.ip,
      usernameAttempt: trimmedUsername || undefined
    };

    this.#logger?.info?.("dashboard.login_attempt", attemptContext);

    const requiresSecureCookies = this.#config.secureCookies === true;
    if (requiresSecureCookies) {
      const requestLooksSecure = this.#requestAppearsSecure(req);
      if (!requestLooksSecure) {
        this.#logger?.warn?.("dashboard.login_failed", {
          ...attemptContext,
          reason: "insecure_transport"
        });
        res.status(400).json({
          error:
            "Secure cookies are enabled; access the dashboard over HTTPS or disable PRIVATE_DASHBOARD_SECURE_COOKIES."
        });
        return;
      }

      if (!req.secure && requestLooksSecure && !this.#config.trustProxy) {
        this.#logger?.error?.("dashboard.login_failed", {
          ...attemptContext,
          reason: "proxy_not_trusted"
        });
        res.status(400).json({
          error:
            "Secure cookies are enabled, but the proxy is not trusted. Set PRIVATE_DASHBOARD_TRUST_PROXY to trust the reverse proxy."
        });
        return;
      }
    }

    if (typeof username !== "string" || typeof password !== "string") {
      this.#logger?.warn?.("dashboard.login_failed", {
        ...attemptContext,
        reason: "invalid_payload"
      });
      res.status(400).json({ error: "Invalid request" });
      return;
    }

    const providedUsername = trimmedUsername;
    const providedPassword = password;

    if (!providedUsername || !providedPassword) {
      this.#logger?.warn?.("dashboard.login_failed", {
        ...attemptContext,
        reason: "missing_credentials"
      });
      res.status(400).json({ error: "Username and password are required" });
      return;
    }

    const passwordMatches = await this.#verifyPassword(providedPassword);
    const usernameMatches = this.#safeCompare(providedUsername, this.#config.username);

    if (!passwordMatches || !usernameMatches) {
      this.#logger?.warn?.("dashboard.login_failed", {
        ...attemptContext,
        reason: "invalid_credentials"
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      res.status(401).json({ error: "Invalid username or password" });
      return;
    }

    await new Promise((resolve) => {
      req.session.regenerate((error) => {
        if (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.#logger?.error?.("dashboard.login_failed", {
            ...attemptContext,
            reason: "session_regenerate_failed",
            error: message
          });
          this.#logger?.error?.("dashboard.session_regenerate_failed", { error: message });
          res.status(500).json({ error: "Failed to establish session" });
          resolve();
          return;
        }

        try {
          req.session.authenticated = true;
          req.session.username = this.#config.username;
          req.session.createdAt = Date.now();
        } catch (assignError) {
          const message =
            assignError instanceof Error ? assignError.message : String(assignError);
          this.#logger?.error?.("dashboard.login_failed", {
            ...attemptContext,
            reason: "session_assignment_failed",
            error: message
          });
          res.status(500).json({ error: "Failed to establish session" });
          resolve();
          return;
        }

        this.#commitSession(req)
          .then(() => {
            this.#logger?.info?.("dashboard.login_success", {
              ...attemptContext,
              username: this.#config.username
            });

            if (this.#requestPrefersHtml(req)) {
              const basePath = this.#normalizeBasePath(this.#config.basePath);
              res.redirect(303, basePath || "/");
              return;
            }

            res.json({ ok: true, username: this.#config.username });
          })
          .catch((saveError) => {
            const message = saveError instanceof Error ? saveError.message : String(saveError);
            this.#logger?.error?.("dashboard.login_failed", {
              ...attemptContext,
              reason: "session_save_failed",
              error: message
            });
            this.#logger?.error?.("dashboard.session_save_failed", { error: message });
            res.status(500).json({ error: "Failed to persist session" });
          })
          .finally(resolve);
      });
    });
  }

  async #verifyPassword(providedPassword) {
    const secret = this.#config.passwordHash;
    if (typeof secret !== "string" || !secret) return false;

    if (this.#looksLikeBcryptHash(secret)) {
      try {
        return await bcrypt.compare(providedPassword, secret);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.#logger?.error?.("dashboard.password_compare_error", { error: message });
        return false;
      }
    }

    if (!this.#warnedPlaintextPassword) {
      this.#warnedPlaintextPassword = true;
      this.#logger?.warn?.("dashboard.password_hash.unhashed", {
        message:
          "privateDashboard.passwordHash does not appear to be a bcrypt hash; falling back to constant-time string comparison.",
        remediation:
          "Generate a bcrypt hash for the dashboard password and set PRIVATE_DASHBOARD_PASSWORD_HASH to the hashed value."
      });
    }

    return this.#safeCompare(providedPassword, secret);
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

  #looksLikeBcryptHash(value) {
    if (typeof value !== "string") return false;
    return /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(value);
  }

  #commitSession(req) {
    const sess = req.session;
    if (!sess || typeof sess.save !== "function") {
      return Promise.reject(new Error("Session is not available"));
    }

    return new Promise((resolve, reject) => {
      sess.save((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
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

  #isGuildAllowed(guildId) {
    if (!guildId) return false;
    const id = String(guildId);
    const allowList = Array.isArray(this.#config.guildAllowList)
      ? this.#config.guildAllowList.map((value) => String(value))
      : [];
    if (!allowList.length) return true;
    return allowList.includes(id);
  }

  #buildGuildFilter({ guildId }) {
    if (guildId) {
      return { guildId: String(guildId) };
    }
    const allowList = Array.isArray(this.#config.guildAllowList)
      ? this.#config.guildAllowList
          .map((value) => String(value).trim())
          .filter(Boolean)
      : [];
    if (allowList.length) {
      return { guildId: { $in: allowList } };
    }
    return {};
  }

  async #resolveGuild(guildId) {
    if (!guildId || !this.#client) return null;
    const id = String(guildId);
    if (!this.#isGuildAllowed(id)) return null;

    let guild = this.#client.guilds.cache?.get?.(id) ?? null;
    if (!guild) {
      try {
        guild = await this.#client.guilds.fetch(id);
      } catch {
        return null;
      }
    }

    try {
      await guild.fetch();
    } catch {
      // ignore fetch failures and use cached data when possible
    }

    return guild;
  }

  #calculateAverage(values) {
    if (!Array.isArray(values) || !values.length) return null;
    const numeric = values.filter((value) => Number.isFinite(value));
    if (!numeric.length) return null;
    const total = numeric.reduce((sum, value) => sum + value, 0);
    return total / numeric.length;
  }

  #calculateMedian(values) {
    if (!Array.isArray(values) || !values.length) return null;
    const numeric = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
    if (!numeric.length) return null;
    const mid = Math.floor(numeric.length / 2);
    if (numeric.length % 2 === 0) {
      return (numeric[mid - 1] + numeric[mid]) / 2;
    }
    return numeric[mid];
  }

  async #fetchServerStats({ guildId }) {
    const generatedAt = new Date().toISOString();
    const client = this.#client;

    const totals = {
      guilds: 0,
      members: 0,
      approxPresences: 0,
      channels: 0,
      textChannels: 0,
      voiceChannels: 0,
      categoryChannels: 0,
      forumChannels: 0,
      stageChannels: 0,
      announcementChannels: 0,
      threadChannels: 0,
      roles: 0,
      emojis: 0,
      stickers: 0,
      boosts: 0
    };

    if (!client) {
      let moderation = null;
      try {
        moderation = await this.#fetchModerationStats({ guildId });
      } catch (error) {
        this.#logger?.warn?.("dashboard.moderation_stats.error", {
          error: error instanceof Error ? error.message : String(error)
        });
      }
      return { totals, guilds: [], generatedAt, moderation };
    }

    const targetGuildIds = new Set();

    if (guildId) {
      if (this.#isGuildAllowed(guildId)) {
        targetGuildIds.add(String(guildId));
      }
    } else if (Array.isArray(this.#config.guildAllowList) && this.#config.guildAllowList.length) {
      this.#config.guildAllowList
        .map((id) => String(id).trim())
        .filter(Boolean)
        .forEach((id) => {
          if (this.#isGuildAllowed(id)) targetGuildIds.add(id);
        });
    } else {
      client.guilds.cache?.forEach?.((guild) => {
        if (this.#isGuildAllowed(guild.id)) targetGuildIds.add(guild.id);
      });
    }

    if (!targetGuildIds.size) {
      try {
        const fetched = await client.guilds.fetch();
        fetched?.forEach?.((_guild, id) => {
          if (this.#isGuildAllowed(id)) targetGuildIds.add(id);
        });
      } catch {
        // ignore fetch failures; fall back to whatever we already have
      }
    }

    const guildStats = [];

    for (const id of targetGuildIds) {
      const guild =
        client.guilds.cache?.get?.(id) ?? (await client.guilds.fetch(id).catch(() => null));
      if (!guild) continue;

      let fetchedGuild = guild;
      try {
        fetchedGuild = await guild.fetch();
      } catch {
        // ignore if fetch fails; we will use whatever data is cached
      }

      let channelsCollection = guild.channels?.cache;
      try {
        const fetchedChannels = await guild.channels?.fetch();
        if (fetchedChannels) {
          channelsCollection = fetchedChannels;
        }
      } catch {
        // ignore channel fetch failures
      }

      try {
        await guild.roles?.fetch?.();
      } catch {}
      try {
        await guild.emojis?.fetch?.();
      } catch {}
      try {
        await guild.stickers?.fetch?.();
      } catch {}

      const channelCounts = {
        total: 0,
        text: 0,
        voice: 0,
        category: 0,
        forum: 0,
        stage: 0,
        announcement: 0,
        thread: 0
      };

      channelsCollection?.forEach?.((channel) => {
        if (!channel) return;
        channelCounts.total += 1;
        switch (channel.type) {
          case ChannelType.GuildText:
            channelCounts.text += 1;
            break;
          case ChannelType.GuildVoice:
            channelCounts.voice += 1;
            break;
          case ChannelType.GuildCategory:
            channelCounts.category += 1;
            break;
          case ChannelType.GuildForum:
            channelCounts.forum += 1;
            break;
          case ChannelType.GuildStageVoice:
            channelCounts.stage += 1;
            break;
          case ChannelType.GuildAnnouncement:
            channelCounts.announcement += 1;
            break;
          case ChannelType.PublicThread:
          case ChannelType.PrivateThread:
          case ChannelType.AnnouncementThread:
            channelCounts.thread += 1;
            break;
          default:
            break;
        }
      });

      const memberCount = Number.isFinite(fetchedGuild?.memberCount)
        ? fetchedGuild.memberCount
        : Number.isFinite(guild.memberCount)
        ? guild.memberCount
        : null;
      const approximateMemberCount = Number.isFinite(fetchedGuild?.approximateMemberCount)
        ? fetchedGuild.approximateMemberCount
        : null;
      const approxPresenceCount = Number.isFinite(fetchedGuild?.approximatePresenceCount)
        ? fetchedGuild.approximatePresenceCount
        : null;
      const resolvedMemberCount = Number.isFinite(memberCount)
        ? memberCount
        : Number.isFinite(approximateMemberCount)
        ? approximateMemberCount
        : null;

      const roleCount = guild.roles?.cache?.size ?? 0;
      const emojiCount = guild.emojis?.cache?.size ?? 0;
      const stickerCount = guild.stickers?.cache?.size ?? 0;
      const boostCount = Number.isFinite(fetchedGuild?.premiumSubscriptionCount)
        ? fetchedGuild.premiumSubscriptionCount
        : Number.isFinite(guild.premiumSubscriptionCount)
        ? guild.premiumSubscriptionCount
        : null;

      const guildData = {
        id: guild.id,
        name: fetchedGuild?.name ?? guild.name ?? guild.id,
        iconUrl: this.#resolveGuildIcon(fetchedGuild ?? guild),
        memberCount: resolvedMemberCount,
        approxPresenceCount,
        channelCounts,
        roleCount,
        emojiCount,
        stickerCount,
        boostLevel: fetchedGuild?.premiumTier ?? guild.premiumTier ?? null,
        boostCount,
        ownerId: fetchedGuild?.ownerId ?? guild.ownerId ?? null,
        createdAt:
          fetchedGuild?.createdAt instanceof Date
            ? fetchedGuild.createdAt.toISOString()
            : guild.createdAt instanceof Date
            ? guild.createdAt.toISOString()
            : null,
        shardId:
          typeof fetchedGuild?.shardId === "number"
            ? fetchedGuild.shardId
            : typeof guild.shardId === "number"
            ? guild.shardId
            : null
      };

      guildStats.push(guildData);

      totals.guilds += 1;
      if (Number.isFinite(resolvedMemberCount)) totals.members += resolvedMemberCount;
      if (Number.isFinite(approxPresenceCount)) totals.approxPresences += approxPresenceCount;
      totals.channels += channelCounts.total;
      totals.textChannels += channelCounts.text;
      totals.voiceChannels += channelCounts.voice;
      totals.categoryChannels += channelCounts.category;
      totals.forumChannels += channelCounts.forum;
      totals.stageChannels += channelCounts.stage;
      totals.announcementChannels += channelCounts.announcement;
      totals.threadChannels += channelCounts.thread;
      totals.roles += roleCount;
      totals.emojis += emojiCount;
      totals.stickers += stickerCount;
      if (Number.isFinite(boostCount)) totals.boosts += boostCount;
    }

    guildStats.sort((a, b) => a.name.localeCompare(b.name));

    const insights = this.#buildDerivedServerMetrics({ totals, guilds: guildStats });

    let moderation = null;
    try {
      moderation = await this.#fetchModerationStats({ guildId });
    } catch (error) {
      this.#logger?.warn?.("dashboard.moderation_stats.error", {
        error: error instanceof Error ? error.message : String(error)
      });
    }

    return { totals, guilds: guildStats, generatedAt, insights, moderation };
  }

  #buildDerivedServerMetrics({ totals, guilds }) {
    const guildCount = Array.isArray(guilds) ? guilds.length : 0;
    if (!guildCount) {
      return {
        averages: {},
        ratios: {},
        topGuilds: []
      };
    }

    const memberCounts = guilds.map((g) =>
      Number.isFinite(g.memberCount) ? g.memberCount : null
    );
    const presenceCounts = guilds.map((g) =>
      Number.isFinite(g.approxPresenceCount) ? g.approxPresenceCount : null
    );
    const boostCounts = guilds.map((g) => (Number.isFinite(g.boostCount) ? g.boostCount : null));

    const onlineRatios = guilds.map((g) => {
      if (
        !Number.isFinite(g.memberCount) ||
        !Number.isFinite(g.approxPresenceCount) ||
        !g.memberCount
      ) {
        return null;
      }
      return g.approxPresenceCount / g.memberCount;
    });

    const sortedByMembers = [...guilds]
      .filter((g) => Number.isFinite(g.memberCount))
      .sort((a, b) => (b.memberCount ?? 0) - (a.memberCount ?? 0));

    const sortedByPresence = [...guilds]
      .filter((g) => Number.isFinite(g.approxPresenceCount))
      .sort((a, b) => (b.approxPresenceCount ?? 0) - (a.approxPresenceCount ?? 0));

    const sortedByBoosts = [...guilds]
      .filter((g) => Number.isFinite(g.boostCount))
      .sort((a, b) => (b.boostCount ?? 0) - (a.boostCount ?? 0));

    const averages = {
      membersPerGuild: this.#calculateAverage(memberCounts),
      onlineUsersPerGuild: this.#calculateAverage(presenceCounts),
      boostsPerGuild: this.#calculateAverage(boostCounts),
      channelsPerGuild: guildCount ? totals.channels / guildCount : null,
      rolesPerGuild: guildCount ? totals.roles / guildCount : null,
      emojisPerGuild: guildCount ? totals.emojis / guildCount : null,
      stickersPerGuild: guildCount ? totals.stickers / guildCount : null
    };

    const ratios = {
      textToVoiceRatio: totals.voiceChannels ? totals.textChannels / totals.voiceChannels : null,
      threadsPerTextChannel: totals.textChannels ? totals.threadChannels / totals.textChannels : null,
      averageOnlineRatio: this.#calculateAverage(onlineRatios)
    };

    return {
      averages,
      ratios,
      topGuilds: {
        byMembers: sortedByMembers.slice(0, 5).map((guild) => ({
          id: guild.id,
          name: guild.name,
          memberCount: guild.memberCount
        })),
        byOnline: sortedByPresence.slice(0, 5).map((guild) => ({
          id: guild.id,
          name: guild.name,
          approxPresenceCount: guild.approxPresenceCount
        })),
        byBoosts: sortedByBoosts.slice(0, 5).map((guild) => ({
          id: guild.id,
          name: guild.name,
          boostCount: guild.boostCount
        }))
      },
      distribution: {
        memberCount: {
          average: this.#calculateAverage(memberCounts),
          median: this.#calculateMedian(memberCounts),
          min: sortedByMembers.length
            ? sortedByMembers[sortedByMembers.length - 1].memberCount ?? null
            : null,
          max: sortedByMembers.length ? sortedByMembers[0].memberCount ?? null : null
        },
        presenceCount: {
          average: this.#calculateAverage(presenceCounts),
          median: this.#calculateMedian(presenceCounts),
          min: sortedByPresence.length
            ? sortedByPresence[sortedByPresence.length - 1].approxPresenceCount ?? null
            : null,
          max: sortedByPresence.length
            ? sortedByPresence[0].approxPresenceCount ?? null
            : null
        }
      }
    };
  }

  async #fetchModerationStats({ guildId }) {
    if (!this.#warningModel || !this.#moderationActionModel) {
      return null;
    }

    const now = new Date();
    const generatedAt = now.toISOString();
    const warningFilter = this.#buildGuildFilter({ guildId });
    const actionFilter = this.#buildGuildFilter({ guildId });

    const addDateFilter = (base, since) => {
      if (!since) return { ...base };
      return { ...base, createdAt: { $gte: since } };
    };

    const buildMatchStage = (filter) => {
      return Object.keys(filter).length ? [{ $match: filter }] : [];
    };

    const dayMs = 24 * 60 * 60 * 1000;
    const windows = [
      { key: "last24h", label: "Last 24 hours", since: new Date(now.getTime() - dayMs) },
      { key: "last7d", label: "Last 7 days", since: new Date(now.getTime() - 7 * dayMs) },
      { key: "last30d", label: "Last 30 days", since: new Date(now.getTime() - 30 * dayMs) }
    ];

    const [
      totalWarnings,
      totalActions,
      warningUsers,
      actionUsers,
      warningModerators,
      actionModerators,
      activePunishments
    ] = await Promise.all([
      this.#warningModel.countDocuments(warningFilter),
      this.#moderationActionModel.countDocuments(actionFilter),
      this.#warningModel.distinct("userId", warningFilter),
      this.#moderationActionModel.distinct("userId", actionFilter),
      this.#warningModel.distinct("modId", warningFilter),
      this.#moderationActionModel.distinct("moderatorId", { ...actionFilter, moderatorId: { $ne: null } }),
      this.#moderationActionModel.countDocuments({
        ...actionFilter,
        expungedAt: null,
        $or: [{ expiresAt: null, completedAt: null }, { expiresAt: { $gt: now } }]
      })
    ]);

    const warningWindowCounts = await Promise.all(
      windows.map((window) =>
        this.#warningModel.countDocuments(addDateFilter(warningFilter, window.since))
      )
    );
    const actionWindowCounts = await Promise.all(
      windows.map((window) =>
        this.#moderationActionModel.countDocuments(addDateFilter(actionFilter, window.since))
      )
    );

    const actionBreakdown = await this.#moderationActionModel.aggregate([
      ...buildMatchStage(actionFilter),
      {
        $group: {
          _id: "$action",
          count: { $sum: 1 },
          lastActionAt: { $max: "$createdAt" }
        }
      },
      {
        $project: {
          _id: 0,
          action: { $ifNull: ["$_id", "unknown"] },
          count: 1,
          lastActionAt: 1
        }
      },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);

    const actionModeratorAgg = await this.#moderationActionModel.aggregate([
      ...buildMatchStage({ ...actionFilter, moderatorId: { $ne: null } }),
      {
        $group: {
          _id: "$moderatorId",
          count: { $sum: 1 },
          lastActionAt: { $max: "$createdAt" },
          actions: { $addToSet: "$action" }
        }
      },
      {
        $project: {
          _id: 0,
          moderatorId: "$_id",
          count: 1,
          lastActionAt: 1,
          actions: 1
        }
      },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);

    const warningModeratorAgg = await this.#warningModel.aggregate([
      ...buildMatchStage(warningFilter),
      {
        $group: {
          _id: "$modId",
          count: { $sum: 1 },
          lastWarningAt: { $max: "$createdAt" }
        }
      },
      {
        $project: {
          _id: 0,
          moderatorId: "$_id",
          count: 1,
          lastWarningAt: 1
        }
      },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);

    const topWarnedUsersAgg = await this.#warningModel.aggregate([
      ...buildMatchStage(warningFilter),
      {
        $group: {
          _id: "$userId",
          count: { $sum: 1 },
          lastWarningAt: { $max: "$createdAt" },
          guildIds: { $addToSet: "$guildId" }
        }
      },
      {
        $project: {
          _id: 0,
          userId: "$_id",
          count: 1,
          lastWarningAt: 1,
          guildIds: 1
        }
      },
      { $sort: { count: -1, lastWarningAt: -1 } },
      { $limit: 10 }
    ]);

    const topActionedUsersAgg = await this.#moderationActionModel.aggregate([
      ...buildMatchStage(actionFilter),
      {
        $group: {
          _id: "$userId",
          count: { $sum: 1 },
          lastActionAt: { $max: "$createdAt" },
          guildIds: { $addToSet: "$guildId" },
          actions: { $addToSet: "$action" }
        }
      },
      {
        $project: {
          _id: 0,
          userId: "$_id",
          count: 1,
          lastActionAt: 1,
          guildIds: 1,
          actions: 1
        }
      },
      { $sort: { count: -1, lastActionAt: -1 } },
      { $limit: 10 }
    ]);

    const warningGuildAgg = await this.#warningModel.aggregate([
      ...buildMatchStage(warningFilter),
      {
        $group: {
          _id: "$guildId",
          warningCount: { $sum: 1 },
          lastWarningAt: { $max: "$createdAt" },
          warningUsers: { $addToSet: "$userId" }
        }
      },
      {
        $project: {
          _id: 0,
          guildId: "$_id",
          warningCount: 1,
          lastWarningAt: 1,
          warningUserCount: { $size: "$warningUsers" }
        }
      }
    ]);

    const actionGuildAgg = await this.#moderationActionModel.aggregate([
      ...buildMatchStage(actionFilter),
      {
        $group: {
          _id: "$guildId",
          actionCount: { $sum: 1 },
          lastActionAt: { $max: "$createdAt" },
          actionUsers: { $addToSet: "$userId" }
        }
      },
      {
        $project: {
          _id: 0,
          guildId: "$_id",
          actionCount: 1,
          lastActionAt: 1,
          actionUserCount: { $size: "$actionUsers" }
        }
      }
    ]);

    const startOfTodayUtc = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    );
    const timelineStart = new Date(startOfTodayUtc);
    timelineStart.setUTCDate(timelineStart.getUTCDate() - 13);

    const warningTimelineAgg = await this.#warningModel.aggregate([
      ...buildMatchStage({ ...warningFilter, createdAt: { $gte: timelineStart } }),
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          count: { $sum: 1 }
        }
      },
      {
        $project: {
          _id: 0,
          date: "$_id",
          warnings: "$count"
        }
      },
      { $sort: { date: 1 } }
    ]);

    const actionTimelineAgg = await this.#moderationActionModel.aggregate([
      ...buildMatchStage({ ...actionFilter, createdAt: { $gte: timelineStart } }),
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          count: { $sum: 1 }
        }
      },
      {
        $project: {
          _id: 0,
          date: "$_id",
          actions: "$count"
        }
      },
      { $sort: { date: 1 } }
    ]);

    const timelineDays = [];
    for (let i = 0; i < 14; i += 1) {
      const day = new Date(timelineStart);
      day.setUTCDate(timelineStart.getUTCDate() + i);
      const key = day.toISOString().slice(0, 10);
      timelineDays.push({ key, date: key });
    }

    const warningTimelineMap = new Map();
    for (const entry of warningTimelineAgg) {
      if (!entry?.date) continue;
      warningTimelineMap.set(entry.date, entry.warnings ?? 0);
    }
    const actionTimelineMap = new Map();
    for (const entry of actionTimelineAgg) {
      if (!entry?.date) continue;
      actionTimelineMap.set(entry.date, entry.actions ?? 0);
    }

    const timeline = timelineDays.map(({ key }) => {
      const warnings = warningTimelineMap.get(key) ?? 0;
      const actions = actionTimelineMap.get(key) ?? 0;
      return {
        date: key,
        warnings,
        actions,
        total: warnings + actions
      };
    });

    const normalizeDate = (value) => {
      if (value instanceof Date) return value.toISOString();
      if (!value) return null;
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    };

    const normalizeModerator = (entry) => ({
      moderatorId: entry.moderatorId,
      count: entry.count ?? 0,
      lastActionAt: normalizeDate(entry.lastActionAt),
      lastWarningAt: normalizeDate(entry.lastWarningAt),
      actions: Array.isArray(entry.actions) ? entry.actions.filter(Boolean) : [],
      user: entry.moderatorId ? this.#resolveDiscordUser(entry.moderatorId) : null
    });

    const warningModeratorsList = warningModeratorAgg
      .filter((entry) => entry.moderatorId)
      .map((entry) => normalizeModerator(entry));

    const actionModeratorsList = actionModeratorAgg
      .filter((entry) => entry.moderatorId)
      .map((entry) => normalizeModerator(entry));

    const topWarnedUsers = topWarnedUsersAgg.map((entry) => ({
      userId: entry.userId,
      count: entry.count ?? 0,
      lastWarningAt: normalizeDate(entry.lastWarningAt),
      guildIds: Array.isArray(entry.guildIds) ? entry.guildIds.map((id) => String(id)) : [],
      user: entry.userId ? this.#resolveDiscordUser(entry.userId) : null
    }));

    const topActionedUsers = topActionedUsersAgg.map((entry) => ({
      userId: entry.userId,
      count: entry.count ?? 0,
      lastActionAt: normalizeDate(entry.lastActionAt),
      guildIds: Array.isArray(entry.guildIds) ? entry.guildIds.map((id) => String(id)) : [],
      actions: Array.isArray(entry.actions) ? entry.actions.filter(Boolean) : [],
      user: entry.userId ? this.#resolveDiscordUser(entry.userId) : null
    }));

    const guildMap = new Map();
    for (const entry of warningGuildAgg) {
      if (!entry?.guildId) continue;
      const id = String(entry.guildId);
      if (!guildMap.has(id)) {
        guildMap.set(id, {
          guildId: id,
          warningCount: 0,
          actionCount: 0,
          warningUserCount: 0,
          actionUserCount: 0,
          lastWarningAt: null,
          lastActionAt: null
        });
      }
      const target = guildMap.get(id);
      target.warningCount = entry.warningCount ?? 0;
      target.warningUserCount = entry.warningUserCount ?? 0;
      target.lastWarningAt = normalizeDate(entry.lastWarningAt);
    }

    for (const entry of actionGuildAgg) {
      if (!entry?.guildId) continue;
      const id = String(entry.guildId);
      if (!guildMap.has(id)) {
        guildMap.set(id, {
          guildId: id,
          warningCount: 0,
          actionCount: 0,
          warningUserCount: 0,
          actionUserCount: 0,
          lastWarningAt: null,
          lastActionAt: null
        });
      }
      const target = guildMap.get(id);
      target.actionCount = entry.actionCount ?? 0;
      target.actionUserCount = entry.actionUserCount ?? 0;
      target.lastActionAt = normalizeDate(entry.lastActionAt);
    }

    const guildBreakdown = Array.from(guildMap.values())
      .map((entry) => {
        const lastActivity =
          [entry.lastWarningAt, entry.lastActionAt].filter(Boolean).sort((a, b) => (a > b ? -1 : 1))[0] ??
          null;
        return {
          guildId: entry.guildId,
          warningCount: entry.warningCount,
          actionCount: entry.actionCount,
          warningUserCount: entry.warningUserCount,
          actionUserCount: entry.actionUserCount,
          uniqueUsers: Math.max(entry.warningUserCount ?? 0, entry.actionUserCount ?? 0),
          lastWarningAt: entry.lastWarningAt,
          lastActionAt: entry.lastActionAt,
          lastActivityAt: lastActivity,
          guild: this.#buildGuildSnapshot(entry.guildId)
        };
      })
      .sort((a, b) => {
        const scoreA = (a.warningCount ?? 0) + (a.actionCount ?? 0);
        const scoreB = (b.warningCount ?? 0) + (b.actionCount ?? 0);
        if (scoreA !== scoreB) return scoreB - scoreA;
        return a.guildId.localeCompare(b.guildId);
      });

    const guildSet = new Set();
    guildBreakdown.forEach((entry) => {
      if (entry.guildId) guildSet.add(entry.guildId);
    });

    const recent = {};
    windows.forEach((window, index) => {
      recent[window.key] = {
        label: window.label,
        warnings: warningWindowCounts[index] ?? 0,
        actions: actionWindowCounts[index] ?? 0,
        total: (warningWindowCounts[index] ?? 0) + (actionWindowCounts[index] ?? 0)
      };
    });

    return {
      generatedAt,
      totals: {
        warnings: totalWarnings,
        actions: totalActions,
        activePunishments,
        distinctUsers: new Set([
          ...warningUsers.map((id) => String(id)).filter(Boolean),
          ...actionUsers.map((id) => String(id)).filter(Boolean)
        ]).size,
        distinctModerators: new Set([
          ...warningModerators.map((id) => String(id)).filter(Boolean),
          ...actionModerators.map((id) => String(id)).filter(Boolean)
        ]).size,
        distinctGuilds: guildSet.size
      },
      recent,
      actionBreakdown: actionBreakdown.map((entry) => ({
        action: entry.action,
        count: entry.count ?? 0,
        lastActionAt: normalizeDate(entry.lastActionAt)
      })),
      topModerators: {
        actions: actionModeratorsList,
        warnings: warningModeratorsList
      },
      topUsers: {
        warnings: topWarnedUsers,
        actions: topActionedUsers
      },
      guildBreakdown,
      timeline
    };
  }

  async #fetchGuildRoleDetails({ guildId }) {
    if (!guildId) return null;
    const guild = await this.#resolveGuild(guildId);
    if (!guild) return null;

    const generatedAt = new Date().toISOString();

    let roleCollection = guild.roles?.cache ?? null;
    try {
      const fetchedRoles = await guild.roles?.fetch?.();
      if (fetchedRoles) {
        roleCollection = fetchedRoles;
      }
    } catch {
      // ignore role fetch failures
    }

    let memberCollection = guild.members?.cache ?? null;
    try {
      const fetchedMembers = await guild.members?.fetch?.();
      if (fetchedMembers) {
        memberCollection = fetchedMembers;
      }
    } catch {
      // ignore member fetch failures
    }

    if (!roleCollection?.size) {
      return {
        guild: {
          id: guild.id,
          name: guild.name ?? guild.id,
          iconUrl: this.#resolveGuildIcon(guild)
        },
        generatedAt,
        summary: { totals: { totalRoles: 0 }, memberCounts: {}, permissionUsage: [], topRoles: [] },
        roles: []
      };
    }

    const roles = [];
    const permissionUsage = new Map();

    roleCollection.forEach((role) => {
      if (!role) return;
      const base = {
        id: role.id,
        name: role.name,
        color: role.hexColor ?? null,
        position: typeof role.position === "number" ? role.position : null,
        hoist: Boolean(role.hoist),
        mentionable: Boolean(role.mentionable),
        managed: Boolean(role.managed),
        isEveryone: role.id === guild.id,
        createdAt: role.createdAt instanceof Date ? role.createdAt.toISOString() : null,
        iconUrl: null,
        permissions: [],
        permissionsCount: 0,
        memberCount: null,
        botCount: null,
        humanCount: null
      };

      try {
        base.iconUrl = role.icon ? role.iconURL?.({ size: 64 }) ?? null : null;
      } catch {
        base.iconUrl = null;
      }

      const permissions = role.permissions?.toArray?.() ?? [];
      base.permissions = permissions;
      base.permissionsCount = permissions.length;
      for (const perm of permissions) {
        if (!perm) continue;
        permissionUsage.set(perm, (permissionUsage.get(perm) ?? 0) + 1);
      }

      const roleMembers = role.members;
      if (roleMembers && typeof roleMembers.size === "number" && roleMembers.size >= 0) {
        base.memberCount = roleMembers.size;
        let botCount = 0;
        let humanCount = 0;
        roleMembers.forEach((member) => {
          if (!member) return;
          if (member.user?.bot) botCount += 1;
          else humanCount += 1;
        });
        base.botCount = botCount;
        base.humanCount = humanCount;
      } else if (memberCollection?.size) {
        // derive counts from member cache
        let botCount = 0;
        let humanCount = 0;
        memberCollection.forEach((member) => {
          if (!member?.roles?.cache?.has?.(role.id)) return;
          if (member.user?.bot) botCount += 1;
          else humanCount += 1;
        });
        const count = botCount + humanCount;
        base.memberCount = count || null;
        base.botCount = count ? botCount : null;
        base.humanCount = count ? humanCount : null;
      }

      if (role.tags) {
        base.tags = {
          botId: role.tags.botId ?? null,
          integrationId: role.tags.integrationId ?? null,
          premiumSubscriberRole: Boolean(role.tags.premiumSubscriberRole),
          subscriptionListingId: role.tags.subscriptionListingId ?? null,
          availableForPurchase: Boolean(role.tags.availableForPurchase),
          guildConnections: Boolean(role.tags.guildConnections)
        };
      } else {
        base.tags = null;
      }

      roles.push(base);
    });

    roles.sort((a, b) => (b.position ?? 0) - (a.position ?? 0));

    const memberCounts = roles.map((role) =>
      Number.isFinite(role.memberCount) ? role.memberCount : null
    );
    const rolesWithCounts = roles
      .filter((role) => Number.isFinite(role.memberCount))
      .sort((a, b) => (b.memberCount ?? 0) - (a.memberCount ?? 0));

    const summary = {
      totals: {
        totalRoles: roles.length,
        assignableRoles: roles.filter((role) => !role.managed && !role.isEveryone).length,
        managedRoles: roles.filter((role) => role.managed).length,
        hoistedRoles: roles.filter((role) => role.hoist).length,
        mentionableRoles: roles.filter((role) => role.mentionable).length,
        rolesWithColor: roles.filter((role) => role.color && role.color !== "#000000").length
      },
      memberCounts: {
        known: memberCounts.filter((value) => Number.isFinite(value)).length,
        unknown: roles.length - memberCounts.filter((value) => Number.isFinite(value)).length,
        average: this.#calculateAverage(memberCounts),
        median: this.#calculateMedian(memberCounts),
        max: rolesWithCounts.length ? rolesWithCounts[0].memberCount ?? null : null,
        min: rolesWithCounts.length
          ? rolesWithCounts[rolesWithCounts.length - 1].memberCount ?? null
          : null
      },
      permissionUsage: Array.from(permissionUsage.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([permission, count]) => ({ permission, count })),
      topRoles: rolesWithCounts.slice(0, 10).map((role) => ({
        id: role.id,
        name: role.name,
        memberCount: role.memberCount,
        botCount: role.botCount,
        humanCount: role.humanCount
      }))
    };

    return {
      guild: {
        id: guild.id,
        name: guild.name ?? guild.id,
        iconUrl: this.#resolveGuildIcon(guild)
      },
      generatedAt,
      summary,
      roles
    };
  }

  async #fetchGuildChannelDetails({ guildId }) {
    if (!guildId) return null;
    const guild = await this.#resolveGuild(guildId);
    if (!guild) return null;

    const generatedAt = new Date().toISOString();

    let channelCollection = guild.channels?.cache ?? null;
    try {
      const fetchedChannels = await guild.channels?.fetch?.();
      if (fetchedChannels) {
        channelCollection = fetchedChannels;
      }
    } catch {
      // ignore channel fetch failures
    }

    const channels = [];

    const typeCounters = {
      total: 0,
      text: 0,
      voice: 0,
      stage: 0,
      forum: 0,
      announcement: 0,
      category: 0,
      thread: 0,
      directory: 0,
      media: 0
    };

    let nsfwChannels = 0;
    let slowmodeEnabled = 0;
    let voiceCapacity = 0;
    let voiceUnlimited = 0;
    let activeVoiceUsers = 0;
    let archivedThreads = 0;

    channelCollection?.forEach?.((channel) => {
      if (!channel) return;
      typeCounters.total += 1;

      const detail = {
        id: channel.id,
        name: channel.name,
        type: channel.type,
        typeLabel: this.#describeChannelType(channel.type),
        createdAt: channel.createdAt instanceof Date ? channel.createdAt.toISOString() : null,
        parentId: channel.parentId ?? null,
        parentName: channel.parent?.name ?? null,
        position: typeof channel.rawPosition === "number" ? channel.rawPosition : null,
        topic: "topic" in channel ? channel.topic || null : null,
        nsfw: Boolean(channel.nsfw),
        rateLimitPerUser: "rateLimitPerUser" in channel ? channel.rateLimitPerUser ?? null : null,
        memberCount: null,
        botCount: null,
        userLimit: "userLimit" in channel ? channel.userLimit || null : null,
        bitrate: "bitrate" in channel ? channel.bitrate ?? null : null,
        videoQualityMode: "videoQualityMode" in channel ? channel.videoQualityMode ?? null : null,
        archived: "archived" in channel ? Boolean(channel.archived) : null,
        autoArchiveDuration:
          "autoArchiveDuration" in channel ? channel.autoArchiveDuration ?? null : null,
        locked: "locked" in channel ? Boolean(channel.locked) : null,
        invitable: "invitable" in channel ? Boolean(channel.invitable) : null,
        isTextBased: typeof channel.isTextBased === "function" ? channel.isTextBased() : false,
        lastActivityAt: null,
        childCount: null
      };

      if (detail.nsfw) nsfwChannels += 1;
      if (typeof detail.rateLimitPerUser === "number" && detail.rateLimitPerUser > 0)
        slowmodeEnabled += 1;

      if (channel.lastMessage?.createdTimestamp) {
        detail.lastActivityAt = new Date(channel.lastMessage.createdTimestamp).toISOString();
      } else if (typeof channel.lastPinTimestamp === "number" && channel.lastPinTimestamp > 0) {
        detail.lastActivityAt = new Date(channel.lastPinTimestamp).toISOString();
      } else if ("archivedAt" in channel && channel.archivedAt instanceof Date) {
        // better than checking for numeric archiveTimestamp
        detail.lastActivityAt = channel.archivedAt.toISOString();
      }

      if (channel.type === ChannelType.GuildText) {
        typeCounters.text += 1;
      } else if (channel.type === ChannelType.GuildVoice) {
        typeCounters.voice += 1;
      } else if (channel.type === ChannelType.GuildStageVoice) {
        typeCounters.stage += 1;
      } else if (channel.type === ChannelType.GuildForum) {
        typeCounters.forum += 1;
      } else if (channel.type === ChannelType.GuildAnnouncement) {
        typeCounters.announcement += 1;
      } else if (channel.type === ChannelType.GuildCategory) {
        typeCounters.category += 1;
        try {
          // compute child count from the collection
          detail.childCount = channelCollection
            ? channelCollection.filter((c) => c?.parentId === channel.id).size ?? null
            : null;
        } catch {
          detail.childCount = null;
        }
      } else if (channel.type === ChannelType.GuildDirectory) {
        typeCounters.directory += 1;
      } else if (channel.type === ChannelType.GuildMedia) {
        typeCounters.media += 1;
      } else if (
        channel.type === ChannelType.PublicThread ||
        channel.type === ChannelType.PrivateThread ||
        channel.type === ChannelType.AnnouncementThread
      ) {
        typeCounters.thread += 1;
        if (detail.archived) archivedThreads += 1;
        if (typeof channel.memberCount === "number") {
          detail.memberCount = channel.memberCount;
        }
      }

      if (channel.members && typeof channel.members.size === "number") {
        detail.memberCount = channel.members.size;
        let botCount = 0;
        channel.members.forEach((member) => {
          if (!member) return;
          if (member.user?.bot) botCount += 1;
        });
        detail.botCount = botCount;
        if (
          channel.type === ChannelType.GuildVoice ||
          channel.type === ChannelType.GuildStageVoice
        ) {
          activeVoiceUsers += channel.members.size;
        }
      }

      if (
        (channel.type === ChannelType.GuildVoice ||
          channel.type === ChannelType.GuildStageVoice) &&
        detail.userLimit
      ) {
        voiceCapacity += detail.userLimit;
      } else if (
        channel.type === ChannelType.GuildVoice ||
        channel.type === ChannelType.GuildStageVoice
      ) {
        voiceUnlimited += 1;
      }

      channels.push(detail);
    });

    channels.sort((a, b) => {
      if (a.type === b.type) {
        return (a.position ?? 0) - (b.position ?? 0);
      }
      return a.type - b.type;
    });

    const summary = {
      totals: typeCounters,
      nsfwChannels,
      slowmodeEnabled,
      voice: {
        capacity: voiceCapacity || null,
        unlimitedChannels: voiceUnlimited,
        activeUsers: activeVoiceUsers || null
      },
      threads: {
        archived: archivedThreads,
        active: typeCounters.thread - archivedThreads
      }
    };

    return {
      guild: {
        id: guild.id,
        name: guild.name ?? guild.id,
        iconUrl: this.#resolveGuildIcon(guild)
      },
      generatedAt,
      summary,
      channels
    };
  }

  #describeChannelType(type) {
    switch (type) {
      case ChannelType.GuildText:
        return "Text Channel";
      case ChannelType.GuildVoice:
        return "Voice Channel";
      case ChannelType.GuildStageVoice:
        return "Stage Channel";
      case ChannelType.GuildAnnouncement:
        return "Announcement Channel";
      case ChannelType.GuildCategory:
        return "Category";
      case ChannelType.GuildForum:
        return "Forum";
      case ChannelType.GuildDirectory:
        return "Directory";
      case ChannelType.GuildMedia:
        return "Media";
      case ChannelType.PublicThread:
        return "Public Thread";
      case ChannelType.PrivateThread:
        return "Private Thread";
      case ChannelType.AnnouncementThread:
        return "Announcement Thread";
      default:
        return "Other";
    }
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
          lastWarningAt: { $max: "$createdAt" },
          moderatorIds: { $addToSet: "$modId" }
        }
      },
      {
        $project: {
          _id: 0,
          userId: "$_id",
          guildIds: 1,
          warningCount: 1,
          lastWarningAt: 1,
          moderatorIds: 1
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
          guildIds: { $addToSet: "$guildId" },
          moderatorIds: { $addToSet: "$moderatorId" }
        }
      },
      {
        $project: {
          _id: 0,
          userId: "$_id",
          totalActions: 1,
          lastActionAt: 1,
          guildIds: 1,
          moderatorIds: 1
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
          actionBreakdown: {},
          moderatorIds: new Set()
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
      (entry.guildIds || []).forEach((id) => sum.guildIds.add(id));
      (entry.moderatorIds || []).forEach((id) => id && sum.moderatorIds.add(String(id)));
    }

    for (const entry of actionTotals) {
      const sum = ensureEntry(entry.userId);
      sum.totalActions = entry.totalActions || 0;
      if (entry.lastActionAt && (!sum.lastActionAt || entry.lastActionAt > sum.lastActionAt)) {
        sum.lastActionAt = entry.lastActionAt;
      }
      (entry.guildIds || []).forEach((id) => sum.guildIds.add(id));
      (entry.moderatorIds || []).forEach((id) => id && sum.moderatorIds.add(String(id)));
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
      const lastActivity =
        [sum.lastWarningAt, sum.lastActionAt].filter(Boolean).sort((a, b) => (a > b ? -1 : 1))[0] ??
        null;
      const topActions = Object.entries(sum.actionBreakdown)
        .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
        .slice(0, 3)
        .map(([action, count]) => ({ action, count }));
      result.push({
        userId: sum.userId,
        guildIds: [...sum.guildIds],
        warningCount: sum.warningCount,
        totalActions: sum.totalActions,
        lastWarningAt: sum.lastWarningAt ? new Date(sum.lastWarningAt).toISOString() : null,
        lastActionAt: sum.lastActionAt ? new Date(sum.lastActionAt).toISOString() : null,
        actionBreakdown: sum.actionBreakdown,
        topActions,
        moderatorIds: [...sum.moderatorIds],
        moderatorCount: sum.moderatorIds.size,
        lastActivityAt: lastActivity ? new Date(lastActivity).toISOString() : null,
        guildCount: sum.guildIds.size,
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

    const moderatorIds = new Set();
    const actionTypeCounts = new Map();
    const warningReasonCounts = new Map();
    const guildBreakdownMap = new Map();

    const ensureGuildEntry = (id) => {
      const key = id ? String(id) : "unknown";
      if (!guildBreakdownMap.has(key)) {
        guildBreakdownMap.set(key, {
          guildId: key,
          warningCount: 0,
          actionCount: 0,
          lastWarningAt: null,
          lastActionAt: null,
          moderators: new Set()
        });
      }
      return guildBreakdownMap.get(key);
    };

    for (const warning of warnings) {
      const entry = ensureGuildEntry(warning.guildId);
      entry.warningCount += 1;
      if (warning.createdAt && (!entry.lastWarningAt || warning.createdAt > entry.lastWarningAt)) {
        entry.lastWarningAt = warning.createdAt;
      }
      if (warning.modId) {
        const modId = String(warning.modId);
        entry.moderators.add(modId);
        moderatorIds.add(modId);
      }
      const reason = typeof warning.reason === "string" ? warning.reason.trim() : "";
      if (reason) {
        warningReasonCounts.set(reason, (warningReasonCounts.get(reason) ?? 0) + 1);
      }
    }

    for (const action of actions) {
      const entry = ensureGuildEntry(action.guildId);
      entry.actionCount += 1;
      if (action.createdAt && (!entry.lastActionAt || action.createdAt > entry.lastActionAt)) {
        entry.lastActionAt = action.createdAt;
      }
      if (action.moderatorId) {
        const modId = String(action.moderatorId);
        entry.moderators.add(modId);
        moderatorIds.add(modId);
      }
      const actionName = typeof action.action === "string" ? action.action : "unknown";
      actionTypeCounts.set(actionName, (actionTypeCounts.get(actionName) ?? 0) + 1);
    }

    const guildBreakdown = Array.from(guildBreakdownMap.values())
      .map((entry) => {
        const lastActivity =
          [entry.lastWarningAt, entry.lastActionAt].filter(Boolean).sort((a, b) => (a > b ? -1 : 1))[0] ??
          null;
        return {
          guildId: entry.guildId,
          warningCount: entry.warningCount,
          actionCount: entry.actionCount,
          lastWarningAt:
            entry.lastWarningAt instanceof Date
              ? entry.lastWarningAt.toISOString()
              : entry.lastWarningAt
              ? new Date(entry.lastWarningAt).toISOString()
              : null,
          lastActionAt:
            entry.lastActionAt instanceof Date
              ? entry.lastActionAt.toISOString()
              : entry.lastActionAt
              ? new Date(entry.lastActionAt).toISOString()
              : null,
          lastActivityAt:
            lastActivity instanceof Date
              ? lastActivity.toISOString()
              : lastActivity
              ? new Date(lastActivity).toISOString()
              : null,
          moderators: [...entry.moderators]
        };
      })
      .sort((a, b) => {
        const scoreA = (a.warningCount ?? 0) + (a.actionCount ?? 0);
        const scoreB = (b.warningCount ?? 0) + (b.actionCount ?? 0);
        if (scoreA !== scoreB) return scoreB - scoreA;
        return a.guildId.localeCompare(b.guildId);
      });

    const actionSummary = Array.from(actionTypeCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([actionName, count]) => ({ action: actionName, count }));

    const warningSummary = Array.from(warningReasonCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([reason, count]) => ({ reason, count }));

    const moderatorSummaries = [...moderatorIds].map((id) => ({
      id,
      user: this.#resolveDiscordUser(id)
    }));

    const lastActivityAt =
      [
        ...warnings.map((warning) =>
          warning.createdAt instanceof Date
            ? warning.createdAt.getTime()
            : warning.createdAt
            ? new Date(warning.createdAt).getTime()
            : null
        ),
        ...actions.map((action) =>
          action.createdAt instanceof Date
            ? action.createdAt.getTime()
            : action.createdAt
            ? new Date(action.createdAt).getTime()
            : null
        )
      ]
        .filter((value) => typeof value === "number" && Number.isFinite(value))
        .sort((a, b) => b - a)[0] ?? null;

    return {
      userId: String(userId),
      user: discordUser,
      warningCount: warnings.length,
      actionCount: actions.length,
      lastActivityAt: typeof lastActivityAt === "number" ? new Date(lastActivityAt).toISOString() : null,
      guildCount: guildBreakdown.length,
      moderators: moderatorSummaries,
      actionSummary,
      warningSummary,
      guildBreakdown,
      warnings: warnings.map((w) => ({
        id: String(w._id || ""),
        guildId: w.guildId,
        modId: w.modId,
        reason: w.reason,
        createdAt: w.createdAt instanceof Date ? w.createdAt.toISOString() : w.createdAt,
        moderator: w.modId ? this.#resolveDiscordUser(w.modId) : null
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
        metadata: a.metadata ?? null,
        moderator: a.moderatorId ? this.#resolveDiscordUser(a.moderatorId) : null
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
      globalName: cached.globalName ?? null,
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

  #resolveGuildIcon(guild) {
    if (!guild) return null;
    try {
      const icon = guild.iconURL?.({ size: 128 });
      return icon || null;
    } catch {
      return null;
    }
  }

  #buildGuildSnapshot(guildId) {
    if (!guildId) return null;
    const id = String(guildId);
    if (!this.#isGuildAllowed(id)) {
      return { id, name: id, iconUrl: null };
    }
    const guild = this.#client?.guilds?.cache?.get?.(id) ?? null;
    if (!guild) {
      return { id, name: id, iconUrl: null };
    }
    return {
      id: guild.id,
      name: guild.name ?? guild.id,
      iconUrl: this.#resolveGuildIcon(guild)
    };
  }

  #handleRouteError(error, res, logKey) {
    const message = error instanceof Error ? error.message : String(error);
    this.#logger?.error?.(logKey, { error: message });
    res.status(500).json({ error: "Internal server error" });
  }

  #escapeHtml(value) {
    if (typeof value !== "string" || value.length === 0) return "";
    return value.replace(/[&<>"'`]/g, (char) => {
      switch (char) {
        case "&":
          return "&amp;";
        case "<":
          return "&lt;";
        case ">":
          return "&gt;";
        case '"':
          return "&quot;";
        case "'":
          return "&#39;";
        case "`":
          return "&#96;";
        default:
          return char;
      }
    });
  }

  #renderPage({ basePath, authenticated, username, cspNonce }) {
    // Minimal, robust dashboard shell (nonce-based CSP, no unsafe-inline)
    const base = this.#normalizeBasePath(basePath);
    const apiBase = base === "/" ? "/api" : `${base}/api`;
    const authBase = base === "/" ? "/auth" : `${base}/auth`;
    const isAuthenticated = Boolean(authenticated);
    const escapedUsername = this.#escapeHtml(username || "");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Private Moderation Dashboard</title>
  <style nonce="${cspNonce}">
    :root { color-scheme: light dark; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
    body { margin: 0; padding: 2rem; background: #0f172a; color: #e2e8f0; }
    main { max-width: 980px; margin: 0 auto; display: grid; gap: 1rem; }
    .card { background: rgba(15,23,42,.9); border: 1px solid #1e293b; border-radius: 12px; padding: 1rem; }
    h1 { margin: 0 0 .25rem 0; }
    input, button { font: inherit; }
    input { padding: .5rem .65rem; border-radius: 8px; border: 1px solid #334155; background: rgba(15,23,42,.6); color: inherit; }
    button { padding: .55rem .85rem; border-radius: 8px; border: 1px solid transparent; background: #2563eb; color: white; font-weight: 600; cursor: pointer; }
    button.ghost { background: transparent; border-color: #334155; color: #cbd5f5; }
    .row { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }
    .meta { color: #94a3b8; font-size: .9rem; }
    pre { background: rgba(2,6,23,.6); border: 1px solid #1f2937; padding: .75rem; border-radius: 8px; overflow: auto; }
    label { display: grid; gap: .25rem; font-size: .9rem; }
    .error { color: #f87171; }
    .ok { color: #34d399; }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Private Moderation Dashboard</h1>
      <p class="meta" id="session-meta">${isAuthenticated ? `Signed in as ${escapedUsername || "unknown"}.` : "Please sign in to access moderation data."}</p>
    </header>

    <section class="card" id="auth-card">
      ${
        isAuthenticated
          ? `<div class="row">
               <button id="logout-btn" type="button">Log out</button>
             </div>`
          : `<form class="row" id="login-form" method="post" action="${this.#escapeHtml(authBase)}/login" autocomplete="off">
               <label>Username
                 <input id="login-username" name="username" required autocomplete="username" />
               </label>
               <label>Password
                 <input id="login-password" name="password" type="password" required autocomplete="current-password" />
               </label>
               <button type="submit">Sign in</button>
               <span id="login-error" class="error" hidden></span>
             </form>`
      }
    </section>

    <section class="card" id="controls-card"${isAuthenticated ? "" : " hidden"}>
      <div class="row">
        <label>Guild ID (optional)
          <input id="guild-id" placeholder="All guilds" />
        </label>
        <button id="refresh-btn" type="button">Refresh</button>
      </div>
    </section>

    <section class="card" id="stats-card"${isAuthenticated ? "" : " hidden"}>
      <div class="row">
        <strong>Overview</strong>
        <span id="stats-status" class="meta">—</span>
      </div>
      <pre id="stats-json" hidden></pre>
      <span id="stats-error" class="error" hidden></span>
    </section>

    <section class="card" id="users-card"${isAuthenticated ? "" : " hidden"}>
      <div class="row">
        <strong>Users</strong>
        <span id="users-status" class="meta">—</span>
      </div>
      <pre id="users-json" hidden></pre>
      <span id="users-error" class="error" hidden></span>
    </section>
  </main>

  <script nonce="${cspNonce}">
  (function(){
    const API_BASE = ${JSON.stringify(apiBase)};
    const AUTH_BASE = ${JSON.stringify(authBase)};
    let isAuthenticated = ${JSON.stringify(isAuthenticated)};

    const $ = (id) => document.getElementById(id);

    const updateAuthUI = (authed, username) => {
      isAuthenticated = authed;
      const authCard = $("auth-card");
      const controlsCard = $("controls-card");
      const statsCard = $("stats-card");
      const usersCard = $("users-card");
      const sessionMeta = $("session-meta");
      if (authed) {
        authCard.innerHTML = '<div class="row"><button id="logout-btn" type="button">Log out</button></div>';
        sessionMeta.textContent = username ? ("Signed in as " + username + ".") : "Signed in.";
        controlsCard.hidden = false;
        statsCard.hidden = false;
        usersCard.hidden = false;
        bindLogout();
      } else {
        authCard.innerHTML =
          '<form class="row" id="login-form" method="post" action="'+AUTH_BASE+'/login" autocomplete="off">'+
          '<label>Username<input id="login-username" name="username" required autocomplete="username" /></label>'+
          '<label>Password<input id="login-password" name="password" type="password" required autocomplete="current-password" /></label>'+
          '<button type="submit">Sign in</button>'+
          '<span id="login-error" class="error" hidden></span>'+
          '</form>';
        sessionMeta.textContent = "Please sign in to access moderation data.";
        controlsCard.hidden = true;
        statsCard.hidden = true;
        usersCard.hidden = true;
        bindLogin();
      }
    };

    const bindLogin = () => {
      const form = $("login-form");
      if (!form) return;
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const errorEl = $("login-error");
        errorEl.hidden = true;
        const username = $("login-username").value;
        const password = $("login-password").value;
        try {
          const res = await fetch(AUTH_BASE + "/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ username, password })
          });
          const data = await res.json().catch(()=>({}));
          if (!res.ok) {
            errorEl.textContent = data?.error || ("Login failed ("+res.status+")");
            errorEl.hidden = false;
            return;
          }
          updateAuthUI(true, data?.username || username || "");
          await refresh();
        } catch (err) {
          errorEl.textContent = String(err?.message || err);
          errorEl.hidden = false;
        }
      });
    };

    const bindLogout = () => {
      const btn = $("logout-btn");
      if (!btn) return;
      btn.addEventListener("click", async () => {
        try {
          const res = await fetch(AUTH_BASE + "/logout", { method: "POST", credentials: "include" });
          if (!res.ok) throw new Error("Logout failed ("+res.status+")");
        } catch {}
        updateAuthUI(false);
      });
    };

    const getGuildId = () => {
      const el = $("guild-id");
      return el ? el.value.trim() : "";
    };

    const refresh = async () => {
      $("refresh-btn").disabled = true;
      try {
        await Promise.all([loadStats(getGuildId()), loadUsers(getGuildId())]);
      } finally {
        $("refresh-btn").disabled = false;
      }
    };

    const loadStats = async (guildId) => {
      const status = $("stats-status");
      const out = $("stats-json");
      const err = $("stats-error");
      out.hidden = true; err.hidden = true;
      status.textContent = "Loading…";
      try {
        const q = guildId ? ("?guildId=" + encodeURIComponent(guildId)) : "";
        const res = await fetch(API_BASE + "/stats" + q, { credentials: "include" });
        if (res.status === 401 || res.status === 403) {
          updateAuthUI(false);
          throw new Error("Authentication required");
        }
        if (!res.ok) throw new Error("Failed ("+res.status+")");
        const data = await res.json();
        out.textContent = JSON.stringify(data, null, 2);
        out.hidden = false;
        status.textContent = data.generatedAt ? ("Updated " + new Date(data.generatedAt).toLocaleString()) : "Updated";
      } catch (e) {
        err.textContent = String(e?.message || e);
        err.hidden = false;
        status.textContent = "Failed to load.";
      }
    };

    const loadUsers = async (guildId) => {
      const status = $("users-status");
      const out = $("users-json");
      const err = $("users-error");
      out.hidden = true; err.hidden = true;
      status.textContent = "Loading…";
      try {
        const q = guildId ? ("?guildId=" + encodeURIComponent(guildId)) : "";
        const res = await fetch(API_BASE + "/users" + q, { credentials: "include" });
        if (res.status === 401 || res.status === 403) {
          updateAuthUI(false);
          throw new Error("Authentication required");
        }
        if (!res.ok) throw new Error("Failed ("+res.status+")");
        const data = await res.json();
        out.textContent = JSON.stringify(data, null, 2);
        out.hidden = false;
        status.textContent = (Array.isArray(data.users) ? data.users.length : 0) + " users";
      } catch (e) {
        err.textContent = String(e?.message || e);
        err.hidden = false;
        status.textContent = "Failed to load.";
      }
    };

    if (isAuthenticated) {
      const refreshBtn = $("refresh-btn");
      if (refreshBtn) refreshBtn.addEventListener("click", refresh);
      refresh().catch(()=>{});
      bindLogout();
    } else {
      bindLogin();
    }
  })();
  </script>
</body>
</html>`;
  }
}
