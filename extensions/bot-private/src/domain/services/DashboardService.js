import crypto from "node:crypto";
import express from "express";
import session from "express-session";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import { createServer } from "node:http";
import { ChannelType } from "discord.js";

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
    const secureCookies = this.#config.secureCookies === "auto"
      ? "auto"
      : Boolean(this.#config.secureCookies);
    const maxAge = Number.isFinite(this.#config.sessionMaxAgeMs)
      ? Math.max(60_000, this.#config.sessionMaxAgeMs)
      : 60 * 60_000;

    if (secureCookies === false) {
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

  getUrl() {
    const basePath = this.#normalizeBasePath(this.#config.basePath);
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

    return this.#buildDashboardUrl({
      hostname,
      port,
      basePath,
      protocol
    }) ?? fallback;
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
      secureCookies: "auto",
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
      if (config.secureCookies === "auto" || typeof config.secureCookies === "boolean") {
        normalized.secureCookies = config.secureCookies;
      }
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

  #buildDashboardUrl({ hostname, port, basePath, protocol }) {
    const sanitizedHostname = typeof hostname === "string" && hostname.length > 0 ? hostname : "localhost";
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
    const trimmedUsername = typeof username === "string" ? username.trim() : "";
    const attemptContext = {
      ip: req.ip,
      usernameAttempt: trimmedUsername || undefined
    };

    this.#logger?.info?.("dashboard.login_attempt", attemptContext);

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
      await new Promise(resolve => setTimeout(resolve, 150));
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
          const message = assignError instanceof Error ? assignError.message : String(assignError);
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
    const session = req.session;
    if (!session || typeof session.save !== "function") {
      return Promise.reject(new Error("Session is not available"));
    }

    return new Promise((resolve, reject) => {
      session.save((error) => {
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
      const guild = client.guilds.cache?.get?.(id) ?? await client.guilds.fetch(id).catch(() => null);
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
      } catch {
        // ignore role fetch failures
      }

      try {
        await guild.emojis?.fetch?.();
      } catch {
        // ignore emoji fetch failures
      }

      try {
        await guild.stickers?.fetch?.();
      } catch {
        // ignore sticker fetch failures
      }

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
        : (Number.isFinite(guild.memberCount) ? guild.memberCount : null);
      const approximateMemberCount = Number.isFinite(fetchedGuild?.approximateMemberCount)
        ? fetchedGuild.approximateMemberCount
        : null;
      const approxPresenceCount = Number.isFinite(fetchedGuild?.approximatePresenceCount)
        ? fetchedGuild.approximatePresenceCount
        : null;
      const resolvedMemberCount = Number.isFinite(memberCount)
        ? memberCount
        : (Number.isFinite(approximateMemberCount) ? approximateMemberCount : null);

      const roleCount = guild.roles?.cache?.size ?? 0;
      const emojiCount = guild.emojis?.cache?.size ?? 0;
      const stickerCount = guild.stickers?.cache?.size ?? 0;
      const boostCount = Number.isFinite(fetchedGuild?.premiumSubscriptionCount)
        ? fetchedGuild.premiumSubscriptionCount
        : (Number.isFinite(guild.premiumSubscriptionCount) ? guild.premiumSubscriptionCount : null);

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
        createdAt: fetchedGuild?.createdAt instanceof Date
          ? fetchedGuild.createdAt.toISOString()
          : (guild.createdAt instanceof Date ? guild.createdAt.toISOString() : null),
        shardId: typeof fetchedGuild?.shardId === "number"
          ? fetchedGuild.shardId
          : (typeof guild.shardId === "number" ? guild.shardId : null)
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

    const memberCounts = guilds.map((g) => Number.isFinite(g.memberCount) ? g.memberCount : null);
    const presenceCounts = guilds.map((g) => Number.isFinite(g.approxPresenceCount) ? g.approxPresenceCount : null);
    const boostCounts = guilds.map((g) => Number.isFinite(g.boostCount) ? g.boostCount : null);

    const onlineRatios = guilds.map((g) => {
      if (!Number.isFinite(g.memberCount) || !Number.isFinite(g.approxPresenceCount) || !g.memberCount) {
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
          min: sortedByMembers.length ? sortedByMembers[sortedByMembers.length - 1].memberCount ?? null : null,
          max: sortedByMembers.length ? sortedByMembers[0].memberCount ?? null : null
        },
        presenceCount: {
          average: this.#calculateAverage(presenceCounts),
          median: this.#calculateMedian(presenceCounts),
          min: sortedByPresence.length ? sortedByPresence[sortedByPresence.length - 1].approxPresenceCount ?? null : null,
          max: sortedByPresence.length ? sortedByPresence[0].approxPresenceCount ?? null : null
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
        $or: [
          { expiresAt: null, completedAt: null },
          { expiresAt: { $gt: now } }
        ]
      })
    ]);

    const warningWindowCounts = await Promise.all(
      windows.map((window) => this.#warningModel.countDocuments(addDateFilter(warningFilter, window.since)))
    );
    const actionWindowCounts = await Promise.all(
      windows.map((window) => this.#moderationActionModel.countDocuments(addDateFilter(actionFilter, window.since)))
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

    const startOfTodayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
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

    const guildBreakdown = Array.from(guildMap.values()).map((entry) => {
      const lastActivity = [entry.lastWarningAt, entry.lastActionAt]
        .filter(Boolean)
        .sort((a, b) => (a > b ? -1 : 1))[0] ?? null;
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
    }).sort((a, b) => {
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
        // attempt to derive counts from member cache
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

    const memberCounts = roles.map((role) => Number.isFinite(role.memberCount) ? role.memberCount : null);
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
        min: rolesWithCounts.length ? rolesWithCounts[rolesWithCounts.length - 1].memberCount ?? null : null
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
        topic: "topic" in channel ? (channel.topic || null) : null,
        nsfw: Boolean(channel.nsfw),
        rateLimitPerUser: "rateLimitPerUser" in channel ? channel.rateLimitPerUser ?? null : null,
        memberCount: null,
        botCount: null,
        userLimit: "userLimit" in channel ? (channel.userLimit || null) : null,
        bitrate: "bitrate" in channel ? channel.bitrate ?? null : null,
        videoQualityMode: "videoQualityMode" in channel ? channel.videoQualityMode ?? null : null,
        archived: "archived" in channel ? Boolean(channel.archived) : null,
        autoArchiveDuration: "autoArchiveDuration" in channel ? channel.autoArchiveDuration ?? null : null,
        locked: "locked" in channel ? Boolean(channel.locked) : null,
        invitable: "invitable" in channel ? Boolean(channel.invitable) : null,
        isTextBased: typeof channel.isTextBased === "function" ? channel.isTextBased() : false,
        lastActivityAt: null,
        childCount: null
      };

      if (detail.nsfw) nsfwChannels += 1;
      if (typeof detail.rateLimitPerUser === "number" && detail.rateLimitPerUser > 0) slowmodeEnabled += 1;

      if (channel.lastMessage?.createdTimestamp) {
        detail.lastActivityAt = new Date(channel.lastMessage.createdTimestamp).toISOString();
      } else if (typeof channel.lastPinTimestamp === "number" && channel.lastPinTimestamp > 0) {
        detail.lastActivityAt = new Date(channel.lastPinTimestamp).toISOString();
      } else if ("archiveTimestamp" in channel && typeof channel.archiveTimestamp === "number") {
        detail.lastActivityAt = new Date(channel.archiveTimestamp).toISOString();
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
          detail.childCount = channel.children?.cache?.size ?? null;
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
        if (channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice) {
          activeVoiceUsers += channel.members.size;
        }
      }

      if ((channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice) && detail.userLimit) {
        voiceCapacity += detail.userLimit;
      } else if (channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice) {
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
      (entry.guildIds || []).forEach(id => sum.guildIds.add(id));
      (entry.moderatorIds || []).forEach(id => id && sum.moderatorIds.add(String(id)));
    }

    for (const entry of actionTotals) {
      const sum = ensureEntry(entry.userId);
      sum.totalActions = entry.totalActions || 0;
      if (entry.lastActionAt && (!sum.lastActionAt || entry.lastActionAt > sum.lastActionAt)) {
        sum.lastActionAt = entry.lastActionAt;
      }
      (entry.guildIds || []).forEach(id => sum.guildIds.add(id));
      (entry.moderatorIds || []).forEach(id => id && sum.moderatorIds.add(String(id)));
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
      const lastActivity = [sum.lastWarningAt, sum.lastActionAt]
        .filter(Boolean)
        .sort((a, b) => (a > b ? -1 : 1))[0] ?? null;
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

    const guildBreakdown = Array.from(guildBreakdownMap.values()).map((entry) => {
      const lastActivity = [entry.lastWarningAt, entry.lastActionAt]
        .filter(Boolean)
        .sort((a, b) => (a > b ? -1 : 1))[0] ?? null;
      return {
        guildId: entry.guildId,
        warningCount: entry.warningCount,
        actionCount: entry.actionCount,
        lastWarningAt: entry.lastWarningAt instanceof Date
          ? entry.lastWarningAt.toISOString()
          : (entry.lastWarningAt ? new Date(entry.lastWarningAt).toISOString() : null),
        lastActionAt: entry.lastActionAt instanceof Date
          ? entry.lastActionAt.toISOString()
          : (entry.lastActionAt ? new Date(entry.lastActionAt).toISOString() : null),
        lastActivityAt: lastActivity instanceof Date
          ? lastActivity.toISOString()
          : (lastActivity ? new Date(lastActivity).toISOString() : null),
        moderators: [...entry.moderators]
      };
    }).sort((a, b) => {
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

    const lastActivityAt = [
      ...warnings.map((warning) => warning.createdAt instanceof Date
        ? warning.createdAt.getTime()
        : (warning.createdAt ? new Date(warning.createdAt).getTime() : null)),
      ...actions.map((action) => action.createdAt instanceof Date
        ? action.createdAt.getTime()
        : (action.createdAt ? new Date(action.createdAt).getTime() : null))
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

  #renderPage({ basePath, authenticated, username }) {
    const base = this.#normalizeBasePath(basePath);
    const apiBase = base === "/" ? "/api" : `${base}/api`;
    const authBase = base === "/" ? "/auth" : `${base}/auth`;
    const isAuthenticated = Boolean(authenticated);
    const authenticatedJson = JSON.stringify(isAuthenticated);
    const usernameJson = JSON.stringify(username || "");
    const escapedUsername = this.#escapeHtml(username || "");
    const loginHiddenAttr = isAuthenticated ? " hidden" : "";
    const dashboardHiddenAttr = isAuthenticated ? "" : " hidden";
    const sessionMetaText = isAuthenticated
      ? (escapedUsername ? `Signed in as ${escapedUsername}.` : "Signed in.")
      : "Please sign in to access moderation data.";
    const loginAutofocusAttr = isAuthenticated ? "" : " autofocus";
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Private Moderation Dashboard</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 1.5rem; background: #0f172a; color: #e2e8f0; min-height: 100vh; }
    main { max-width: 1240px; margin: 0 auto; display: flex; flex-direction: column; gap: 1.5rem; }
    h1 { margin-bottom: 0.25rem; }
    h2 { margin: 0; font-size: 1.4rem; }
    h3 { margin: 0 0 0.75rem 0; font-size: 1.1rem; }
    h4 { margin: 0 0 0.5rem 0; font-size: 1rem; }
    p { margin: 0; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #1e293b; padding: 0.5rem 0.6rem; text-align: left; vertical-align: top; }
    th { background: #1e3a8a; font-weight: 600; }
    tr:nth-child(even) { background: rgba(148, 163, 184, 0.08); }
    tr.selected { background: rgba(37, 99, 235, 0.25); }
    .table-wrapper { margin-top: 1rem; overflow-x: auto; }
    .meta { font-size: 0.85rem; color: #94a3b8; }
    .error { color: #f87171; margin-top: 0.75rem; font-size: 0.9rem; }
    .page-header { display: flex; justify-content: space-between; align-items: flex-end; flex-wrap: wrap; gap: 1rem; }
    .card { background: rgba(15, 23, 42, 0.94); border: 1px solid #1e293b; border-radius: 0.9rem; padding: 1.5rem; box-shadow: 0 20px 40px rgba(15, 23, 42, 0.45); }
    form { display: grid; gap: 1rem; max-width: 320px; }
    label { display: flex; flex-direction: column; gap: 0.35rem; font-size: 0.85rem; color: #cbd5f5; }
    input { padding: 0.55rem 0.65rem; border-radius: 0.65rem; border: 1px solid #334155; background: rgba(15, 23, 42, 0.6); color: inherit; }
    input:focus { outline: 2px solid #2563eb; outline-offset: 2px; }
    button { padding: 0.55rem 0.85rem; border-radius: 0.65rem; border: 1px solid transparent; background: #2563eb; color: white; font-weight: 600; cursor: pointer; transition: background 0.2s ease, transform 0.15s ease; }
    button:hover { background: #1d4ed8; }
    button:active { transform: translateY(1px); }
    button:disabled { opacity: 0.65; cursor: not-allowed; }
    .danger-btn { background: #ef4444; }
    .danger-btn:hover { background: #dc2626; }
    .ghost-btn { background: transparent; border-color: #334155; color: #cbd5f5; font-weight: 500; }
    .ghost-btn:hover { background: rgba(148, 163, 184, 0.12); }
    .dashboard-controls { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; flex-wrap: wrap; }
    .filters { display: flex; flex-wrap: wrap; gap: 1rem; align-items: flex-end; }
    .tabs { display: flex; gap: 0.5rem; margin-top: 1.5rem; border-bottom: 1px solid #1e293b; }
    .tab { background: transparent; border: none; border-bottom: 2px solid transparent; color: #cbd5f5; border-radius: 0.65rem 0.65rem 0 0; }
    .tab:hover { background: rgba(37, 99, 235, 0.12); }
    .tab.active { color: #f8fafc; border-color: #2563eb; background: rgba(37, 99, 235, 0.18); }
    .tab-panel { margin-top: 1.25rem; display: none; }
    .tab-panel[hidden] { display: none !important; }
    .tab-panel.active { display: block; }
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin-top: 1.25rem; }
    .stat-pill { background: rgba(30, 64, 175, 0.25); border: 1px solid rgba(59, 130, 246, 0.5); border-radius: 0.85rem; padding: 1rem; display: flex; flex-direction: column; gap: 0.35rem; min-height: 90px; }
    .stat-pill .label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.08em; color: #cbd5f5; }
    .stat-pill .value { font-size: 1.5rem; font-weight: 600; color: #f8fafc; }
    .stat-pill .description { font-size: 0.8rem; color: #94a3b8; }
    .insights-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 1rem; margin-top: 1.25rem; }
    .stat-card { background: rgba(15, 23, 42, 0.7); border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 0.85rem; padding: 1rem; display: flex; flex-direction: column; gap: 0.75rem; }
    .stat-card dl { display: grid; grid-template-columns: auto 1fr; gap: 0.35rem 0.65rem; margin: 0; font-size: 0.9rem; }
    .stat-card dt { color: #cbd5f5; }
    .stat-card dd { margin: 0; color: #f8fafc; font-weight: 600; }
    .stat-card ol { margin: 0; padding-left: 1rem; display: flex; flex-direction: column; gap: 0.35rem; font-size: 0.9rem; }
    .stat-card li { display: flex; justify-content: space-between; gap: 0.75rem; }
    .stat-card li .value { color: #cbd5f5; font-weight: 600; }
    .stat-card ol.profile-list { list-style: none; padding-left: 0; margin: 0; display: flex; flex-direction: column; gap: 0.5rem; }
    .stat-card ol.profile-list li { display: flex; justify-content: space-between; gap: 0.75rem; }
    .stat-card .profile-info { display: flex; flex-direction: column; gap: 0.2rem; }
    .stat-card .profile-info .name { font-weight: 600; color: #f8fafc; }
    .stat-card .profile-info .meta { color: #94a3b8; font-size: 0.75rem; }
    .guild-cell { display: flex; align-items: center; gap: 0.75rem; }
    .guild-icon { width: 36px; height: 36px; border-radius: 25%; background: #1e293b; object-fit: cover; flex-shrink: 0; }
    .guild-icon.placeholder { display: flex; align-items: center; justify-content: center; font-weight: 600; color: #94a3b8; }
    .user-cell { display: flex; align-items: center; gap: 0.75rem; min-width: 220px; }
    .avatar { width: 36px; height: 36px; border-radius: 50%; object-fit: cover; background: #1e293b; flex-shrink: 0; }
    .avatar.placeholder { display: flex; align-items: center; justify-content: center; font-weight: 600; color: #cbd5f5; }
    .user-meta { display: flex; flex-direction: column; gap: 0.2rem; }
    .user-meta .tag { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace; font-size: 0.8rem; color: #94a3b8; }
    .section-status { margin-top: 0.25rem; font-size: 0.85rem; color: #94a3b8; }
    .detail-card { margin-top: 1.5rem; border: 1px solid rgba(148, 163, 184, 0.25); border-radius: 1rem; padding: 1.25rem; background: rgba(15, 23, 42, 0.85); display: none; flex-direction: column; gap: 1rem; }
    .detail-card.active { display: flex; }
    .detail-header { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
    .metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 0.75rem; }
    .metric { background: rgba(37, 99, 235, 0.15); border: 1px solid rgba(37, 99, 235, 0.35); border-radius: 0.75rem; padding: 0.75rem; display: flex; flex-direction: column; gap: 0.25rem; }
    .metric .label { font-size: 0.75rem; text-transform: uppercase; color: #bfdbfe; letter-spacing: 0.05em; }
    .metric .value { font-size: 1.25rem; font-weight: 600; }
    .detail-sections { display: grid; gap: 1.25rem; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
    .chip-group { display: flex; flex-wrap: wrap; gap: 0.35rem; }
    .chip { padding: 0.25rem 0.55rem; border-radius: 999px; background: rgba(37, 99, 235, 0.18); border: 1px solid rgba(37, 99, 235, 0.35); font-size: 0.75rem; color: #bfdbfe; }
    .color-swatch { width: 14px; height: 14px; border-radius: 50%; border: 1px solid rgba(148, 163, 184, 0.4); margin-right: 0.5rem; flex-shrink: 0; }
    .channel-icon { margin-right: 0.5rem; }
    .flag-list { display: flex; flex-wrap: wrap; gap: 0.35rem; }
    .flag { background: rgba(148, 163, 184, 0.18); border-radius: 999px; padding: 0.2rem 0.45rem; font-size: 0.75rem; color: #cbd5f5; border: 1px solid rgba(148, 163, 184, 0.35); }
    .compact-table th, .compact-table td { font-size: 0.85rem; }
    .empty-state { margin-top: 1rem; font-size: 0.9rem; color: #94a3b8; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace; background: rgba(15, 23, 42, 0.6); border-radius: 0.35rem; padding: 0.1rem 0.35rem; }
    .overview-subsection { display: flex; flex-direction: column; gap: 1.25rem; margin-top: 1.5rem; }
    .section-heading { display: flex; justify-content: space-between; align-items: baseline; gap: 0.75rem; flex-wrap: wrap; }
    .timeline-card { display: flex; flex-direction: column; gap: 0.75rem; }
    .timeline-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.6rem; }
    .timeline-entry { display: flex; flex-direction: column; gap: 0.3rem; }
    .timeline-row { display: flex; align-items: center; gap: 0.75rem; }
    .timeline-label { width: 110px; font-size: 0.85rem; color: #cbd5f5; }
    .timeline-bar { flex: 1; height: 10px; border-radius: 999px; background: rgba(37, 99, 235, 0.2); position: relative; overflow: hidden; }
    .timeline-bar-fill { position: absolute; inset: 0; background: linear-gradient(90deg, rgba(59, 130, 246, 0.85), rgba(37, 99, 235, 0.65)); border-radius: inherit; }
    .timeline-value { min-width: 96px; text-align: right; font-size: 0.8rem; color: #cbd5f5; font-weight: 600; }
    @media (max-width: 720px) {
      body { padding: 1rem; }
      .filters { width: 100%; flex-direction: column; align-items: stretch; }
      .dashboard-controls { align-items: stretch; }
      .danger-btn { width: 100%; }
    }
  </style>
</head>
<body>
  <main>
    <header class="page-header">
      <div>
        <h1>Private Moderation Dashboard</h1>
        <p class="meta" id="session-meta">${sessionMetaText}</p>
      </div>
    </header>
    <section id="login-section" class="card"${loginHiddenAttr}>
      <h2>Sign in</h2>
      <form id="login-form" method="post" action="${authBase}/login" autocomplete="off">
        <label>Username
          <input id="login-username" name="username" autocomplete="username" required${loginAutofocusAttr} />
        </label>
        <label>Password
          <input id="login-password" name="password" type="password" autocomplete="current-password" required />
        </label>
        <div class="actions">
          <button type="submit">Sign in</button>
          <span class="meta">Credentials are transmitted securely and never stored in the browser.</span>
        </div>
      </form>
      <div class="error" id="login-error" hidden></div>
    </section>
    <section id="dashboard-section" class="card"${dashboardHiddenAttr}>
      <div class="dashboard-controls">
        <div class="filters">
          <label>Guild ID
            <input id="guild-filter" placeholder="All guilds" />
          </label>
          <label id="user-search-wrapper" hidden>Search Users
            <input id="user-search" placeholder="Filter by user or ID" />
          </label>
          <button id="refresh-btn" type="button">Refresh</button>
        </div>
        <button id="logout-btn" type="button" class="danger-btn">Log out</button>
      </div>
      <nav class="tabs" id="tab-bar">
        <button type="button" class="tab active" data-tab="overview">Overview</button>
        <button type="button" class="tab" data-tab="users">Users</button>
        <button type="button" class="tab" data-tab="roles">Roles</button>
        <button type="button" class="tab" data-tab="channels">Channels</button>
      </nav>
      <section class="tab-panel active" data-tab-content="overview">
        <h2>Server Overview</h2>
        <div class="section-status" id="stats-status">Loading…</div>
        <div class="error" id="stats-error" hidden></div>
        <div id="stats-summary" class="stats-grid" hidden></div>
        <div id="insights-grid" class="insights-grid" hidden></div>
        <div id="moderation-section" class="overview-subsection" hidden>
          <div class="section-heading">
            <h3>Moderation Insights</h3>
            <p class="meta" id="moderation-meta" hidden></p>
          </div>
          <div id="moderation-summary" class="stats-grid"></div>
          <div id="moderation-lists" class="insights-grid"></div>
          <div id="moderation-timeline" class="stat-card timeline-card" hidden></div>
          <div class="table-wrapper" id="moderation-guild-wrapper" hidden>
            <table id="moderation-guild-table">
              <thead>
                <tr>
                  <th>Guild</th>
                  <th>Warnings</th>
                  <th>Actions</th>
                  <th>Unique Users</th>
                  <th>Last Activity</th>
                </tr>
              </thead>
              <tbody></tbody>
            </table>
          </div>
          <p class="empty-state" id="moderation-empty" hidden>No moderation records yet.</p>
        </div>
        <div class="table-wrapper" id="guild-stats-wrapper" hidden>
          <table id="guild-stats-table">
            <thead>
              <tr>
                <th>Guild</th>
                <th>Members</th>
                <th>Online</th>
                <th>Online %</th>
                <th>Channels</th>
                <th>Roles</th>
                <th>Boosts</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
      </section>
      <section class="tab-panel" data-tab-content="users" hidden>
        <h2>User Moderation Activity</h2>
        <div class="section-status" id="users-status">Loading…</div>
        <div class="error" id="users-error" hidden></div>
        <div class="table-wrapper">
          <table id="user-table" hidden>
            <thead>
              <tr>
                <th>User</th>
                <th>Warnings</th>
                <th>Actions</th>
                <th>Top Actions</th>
                <th>Last Activity</th>
                <th>Moderators</th>
                <th>Guilds</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
        <div id="user-detail" class="detail-card" hidden></div>
      </section>
      <section class="tab-panel" data-tab-content="roles" hidden>
        <h2>Role Insights</h2>
        <div class="section-status" id="roles-status">Enter a guild ID to load role insights.</div>
        <div class="error" id="roles-error" hidden></div>
        <div id="role-summary" class="stats-grid" hidden></div>
        <div id="role-top-list" class="insights-grid" hidden></div>
        <div class="table-wrapper">
          <table id="role-table" hidden>
            <thead>
              <tr>
                <th>Role</th>
                <th>Members</th>
                <th>Bots</th>
                <th>Humans</th>
                <th>Permissions</th>
                <th>Flags</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
      </section>
      <section class="tab-panel" data-tab-content="channels" hidden>
        <h2>Channel Inventory</h2>
        <div class="section-status" id="channels-status">Enter a guild ID to load channel details.</div>
        <div class="error" id="channels-error" hidden></div>
        <div id="channel-summary" class="stats-grid" hidden></div>
        <div class="table-wrapper">
          <table id="channel-table" hidden>
            <thead>
              <tr>
                <th>Channel</th>
                <th>Type</th>
                <th>Parent</th>
                <th>Members</th>
                <th>Voice / Rate Limit</th>
                <th>Flags</th>
                <th>Created</th>
                <th>Last Activity</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
      </section>
    </section>
  </main>
  <script>
    const API_BASE = ${JSON.stringify(apiBase)};
    const AUTH_BASE = ${JSON.stringify(authBase)};
    let isAuthenticated = ${authenticatedJson};
    let currentUser = ${usernameJson};
    let activeTab = 'overview';
    let currentGuildFilter = '';
    let userSummaries = [];
    const userDetailCache = new Map();
    const roleCache = new Map();
    const channelCache = new Map();
    let statsSnapshot = null;

    const CHANNEL_TYPES = {
      GUILD_TEXT: 0,
      GUILD_VOICE: 2,
      GUILD_CATEGORY: 4,
      GUILD_ANNOUNCEMENT: 5,
      ANNOUNCEMENT_THREAD: 10,
      PUBLIC_THREAD: 11,
      PRIVATE_THREAD: 12,
      GUILD_STAGE_VOICE: 13,
      GUILD_DIRECTORY: 14,
      GUILD_FORUM: 15,
      GUILD_MEDIA: 16
    };

    const loginSection = document.getElementById('login-section');
    const dashboardSection = document.getElementById('dashboard-section');
    const loginForm = document.getElementById('login-form');
    const loginUsername = document.getElementById('login-username');
    const loginPassword = document.getElementById('login-password');
    const loginErrorEl = document.getElementById('login-error');
    const sessionMeta = document.getElementById('session-meta');
    const guildFilterEl = document.getElementById('guild-filter');
    const userSearchWrapper = document.getElementById('user-search-wrapper');
    const userSearchEl = document.getElementById('user-search');
    const refreshBtn = document.getElementById('refresh-btn');
    const logoutBtn = document.getElementById('logout-btn');
    const tabBar = document.getElementById('tab-bar');
    const tabButtons = Array.from(tabBar.querySelectorAll('.tab'));
    const tabPanels = Array.from(document.querySelectorAll('[data-tab-content]'));

    const statsStatusEl = document.getElementById('stats-status');
    const statsErrorEl = document.getElementById('stats-error');
    const statsSummaryEl = document.getElementById('stats-summary');
    const insightsGrid = document.getElementById('insights-grid');
    const guildStatsWrapper = document.getElementById('guild-stats-wrapper');
    const guildStatsTable = document.getElementById('guild-stats-table');
    const guildStatsBody = guildStatsTable.querySelector('tbody');
    const moderationSection = document.getElementById('moderation-section');
    const moderationSummaryEl = document.getElementById('moderation-summary');
    const moderationListsEl = document.getElementById('moderation-lists');
    const moderationTimelineCard = document.getElementById('moderation-timeline');
    const moderationGuildWrapper = document.getElementById('moderation-guild-wrapper');
    const moderationGuildTable = document.getElementById('moderation-guild-table');
    const moderationGuildBody = moderationGuildTable.querySelector('tbody');
    const moderationMetaEl = document.getElementById('moderation-meta');
    const moderationEmptyEl = document.getElementById('moderation-empty');

    const usersStatusEl = document.getElementById('users-status');
    const usersErrorEl = document.getElementById('users-error');
    const userTable = document.getElementById('user-table');
    const userTableBody = userTable.querySelector('tbody');
    const userDetailEl = document.getElementById('user-detail');

    const rolesStatusEl = document.getElementById('roles-status');
    const rolesErrorEl = document.getElementById('roles-error');
    const roleSummaryEl = document.getElementById('role-summary');
    const roleTopList = document.getElementById('role-top-list');
    const roleTable = document.getElementById('role-table');
    const roleTableBody = roleTable.querySelector('tbody');

    const channelsStatusEl = document.getElementById('channels-status');
    const channelsErrorEl = document.getElementById('channels-error');
    const channelSummaryEl = document.getElementById('channel-summary');
    const channelTable = document.getElementById('channel-table');
    const channelTableBody = channelTable.querySelector('tbody');

    const numberFormatter = new Intl.NumberFormat();
    const compactNumberFormatter = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
    const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
    const dateTimeFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    const relativeFormatter = typeof Intl.RelativeTimeFormat === 'function'
      ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
      : null;
    const relativeUnits = [
      { unit: 'year', seconds: 31536000 },
      { unit: 'month', seconds: 2592000 },
      { unit: 'week', seconds: 604800 },
      { unit: 'day', seconds: 86400 },
      { unit: 'hour', seconds: 3600 },
      { unit: 'minute', seconds: 60 },
      { unit: 'second', seconds: 1 }
    ];

    function getCurrentGuildFilter() {
      return guildFilterEl.value.trim();
    }

    function formatNumber(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
      return numberFormatter.format(value);
    }

    function formatCompact(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
      return compactNumberFormatter.format(value);
    }

    function formatPercent(part, total) {
      if (!Number.isFinite(part) || !Number.isFinite(total) || total === 0) return '—';
      return (part / total * 100).toFixed(1) + '%';
    }

    function formatCount(value, noun) {
      if (!Number.isFinite(value)) return '—';
      const formatted = numberFormatter.format(value);
      const suffix = value === 1 ? noun : noun + 's';
      return formatted + ' ' + suffix;
    }

    function formatSeconds(value) {
      if (!Number.isFinite(value)) return '—';
      if (value < 60) return value + 's';
      if (value % 60 === 0) return (value / 60) + 'm';
      return (value / 60).toFixed(1) + 'm';
    }

    function formatDateTime(value) {
      if (!value) return '—';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '—';
      return dateTimeFormatter.format(date);
    }

    function formatDateTimeWithRelative(value) {
      if (!value) return '—';
      const base = formatDateTime(value);
      const relative = computeRelative(value);
      return relative ? base + ' (' + relative + ')' : base;
    }

    function computeRelative(value) {
      if (!relativeFormatter || !value) return '';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '';
      let diffSeconds = Math.round((date.getTime() - Date.now()) / 1000);
      for (const entry of relativeUnits) {
        if (Math.abs(diffSeconds) >= entry.seconds || entry.unit === 'second') {
          const relativeValue = Math.round(diffSeconds / entry.seconds);
          return relativeFormatter.format(relativeValue, entry.unit);
        }
      }
      return '';
    }

    function createStatPill(label, value, description) {
      const pill = document.createElement('div');
      pill.className = 'stat-pill';
      const labelEl = document.createElement('span');
      labelEl.className = 'label';
      labelEl.textContent = label;
      pill.appendChild(labelEl);
      const valueEl = document.createElement('span');
      valueEl.className = 'value';
      valueEl.textContent = value;
      pill.appendChild(valueEl);
      if (description) {
        const descEl = document.createElement('span');
        descEl.className = 'description';
        descEl.textContent = description;
        pill.appendChild(descEl);
      }
      return pill;
    }

    function createDefinitionCard(title, entries) {
      const card = document.createElement('div');
      card.className = 'stat-card';
      const heading = document.createElement('h3');
      heading.textContent = title;
      card.appendChild(heading);
      const dl = document.createElement('dl');
      for (const [label, value] of entries) {
        const dt = document.createElement('dt');
        dt.textContent = label;
        const dd = document.createElement('dd');
        dd.textContent = value;
        dl.appendChild(dt);
        dl.appendChild(dd);
      }
      if (!entries.length) {
        const empty = document.createElement('p');
        empty.className = 'meta';
        empty.textContent = 'No data available.';
        card.appendChild(empty);
      } else {
        card.appendChild(dl);
      }
      return card;
    }

    function createListCard(title, items, getValue, options = {}) {
      const card = document.createElement('div');
      card.className = 'stat-card';
      const heading = document.createElement('h3');
      heading.textContent = title;
      card.appendChild(heading);
      if (!items.length) {
        const empty = document.createElement('p');
        empty.className = 'meta';
        empty.textContent = options.emptyText || 'No entries available.';
        card.appendChild(empty);
        return card;
      }
      const list = document.createElement('ol');
      for (const item of items) {
        const li = document.createElement('li');
        const name = document.createElement('span');
        name.textContent = item.name || item.id || 'Unknown';
        const value = document.createElement('span');
        value.className = 'value';
        value.textContent = getValue(item);
        li.appendChild(name);
        li.appendChild(value);
        if (options.getTitle) {
          li.title = options.getTitle(item);
        }
        list.appendChild(li);
      }
      card.appendChild(list);
      return card;
    }

    function createProfileListCard(title, items, options = {}) {
      const card = document.createElement('div');
      card.className = 'stat-card';
      const heading = document.createElement('h3');
      heading.textContent = title;
      card.appendChild(heading);
      if (!items.length) {
        const empty = document.createElement('p');
        empty.className = 'meta';
        empty.textContent = options.emptyText || 'No entries available.';
        card.appendChild(empty);
        return card;
      }
      const list = document.createElement('ol');
      list.className = 'profile-list';
      items.forEach((item) => {
        const li = document.createElement('li');
        li.className = 'profile-item';
        if (options.getTitle) {
          const titleText = options.getTitle(item);
          if (titleText) li.title = titleText;
        }
        const info = document.createElement('div');
        info.className = 'profile-info';
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = options.getName ? options.getName(item) : (item.name || item.id || 'Unknown');
        info.appendChild(name);
        if (options.getSubtitle) {
          const subtitle = options.getSubtitle(item);
          if (subtitle) {
            const meta = document.createElement('span');
            meta.className = 'meta';
            meta.textContent = subtitle;
            info.appendChild(meta);
          }
        }
        li.appendChild(info);
        const value = document.createElement('span');
        value.className = 'value';
        value.textContent = options.getValue ? options.getValue(item) : '';
        li.appendChild(value);
        list.appendChild(li);
      });
      card.appendChild(list);
      return card;
    }

    function renderModerationTimeline(timeline) {
      moderationTimelineCard.innerHTML = '';
      if (!Array.isArray(timeline) || !timeline.length) {
        moderationTimelineCard.hidden = true;
        return;
      }
      moderationTimelineCard.hidden = false;
      const heading = document.createElement('h3');
      heading.textContent = '14-day moderation timeline';
      moderationTimelineCard.appendChild(heading);
      const list = document.createElement('ol');
      list.className = 'timeline-list';
      const maxTotal = timeline.reduce((max, entry) => Math.max(max, entry.total ?? 0), 0);
      timeline.forEach((entry) => {
        const li = document.createElement('li');
        li.className = 'timeline-entry';
        const row = document.createElement('div');
        row.className = 'timeline-row';
        const label = document.createElement('span');
        label.className = 'timeline-label';
        if (entry.date) {
          const date = new Date(entry.date + 'T00:00:00Z');
          label.textContent = Number.isNaN(date.getTime()) ? entry.date : dateFormatter.format(date);
        } else {
          label.textContent = 'Unknown';
        }
        row.appendChild(label);
        const bar = document.createElement('div');
        bar.className = 'timeline-bar';
        const fill = document.createElement('div');
        fill.className = 'timeline-bar-fill';
        let width = 0;
        if (maxTotal > 0) {
          width = (entry.total ?? 0) / maxTotal * 100;
          if (width > 0 && width < 4) width = 4;
        }
        fill.style.width = width.toFixed(1) + '%';
        fill.title = formatNumber(entry.total ?? 0) + ' total actions';
        bar.appendChild(fill);
        row.appendChild(bar);
        const value = document.createElement('span');
        value.className = 'timeline-value';
        value.textContent = formatNumber(entry.total ?? 0) + ' total';
        row.appendChild(value);
        li.appendChild(row);
        const meta = document.createElement('span');
        meta.className = 'meta';
        meta.textContent = formatNumber(entry.warnings ?? 0) + ' warnings • ' + formatNumber(entry.actions ?? 0) + ' actions';
        li.appendChild(meta);
        list.appendChild(li);
      });
      moderationTimelineCard.appendChild(list);
    }

    function renderModerationOverview(moderation, guildId) {
      moderationSummaryEl.innerHTML = '';
      moderationListsEl.innerHTML = '';
      moderationGuildBody.innerHTML = '';
      moderationGuildWrapper.hidden = true;
      moderationTimelineCard.innerHTML = '';
      moderationTimelineCard.hidden = true;
      if (moderationMetaEl) {
        moderationMetaEl.hidden = true;
        moderationMetaEl.textContent = '';
      }
      if (!moderation) {
        moderationSection.hidden = true;
        if (moderationEmptyEl) moderationEmptyEl.hidden = true;
        return;
      }

      moderationSection.hidden = false;

      if (moderationMetaEl && moderation.generatedAt) {
        moderationMetaEl.textContent = 'Generated ' + formatDateTimeWithRelative(moderation.generatedAt);
        moderationMetaEl.hidden = false;
      }

      const totals = moderation.totals || {};
      const summaryItems = [
        ['Warnings', formatNumber(totals.warnings)],
        ['Actions', formatNumber(totals.actions)],
        ['Active penalties', formatNumber(totals.activePunishments)],
        ['People affected', formatNumber(totals.distinctUsers)],
        ['Moderators', formatNumber(totals.distinctModerators)],
        ['Guilds', formatNumber(totals.distinctGuilds)]
      ];
      summaryItems.forEach(([label, value]) => {
        moderationSummaryEl.appendChild(createStatPill(label, value));
      });

      const recent = moderation.recent || {};
      const recentEntries = [];
      if (recent.last24h) {
        recentEntries.push(['Last 24 hours', formatNumber(recent.last24h.warnings) + ' warnings • ' + formatNumber(recent.last24h.actions) + ' actions']);
      }
      if (recent.last7d) {
        recentEntries.push(['Last 7 days', formatNumber(recent.last7d.warnings) + ' warnings • ' + formatNumber(recent.last7d.actions) + ' actions']);
      }
      if (recent.last30d) {
        recentEntries.push(['Last 30 days', formatNumber(recent.last30d.warnings) + ' warnings • ' + formatNumber(recent.last30d.actions) + ' actions']);
      }
      if (recentEntries.length) {
        moderationListsEl.appendChild(createDefinitionCard('Recent moderation volume', recentEntries));
      }

      const actionBreakdown = Array.isArray(moderation.actionBreakdown) ? moderation.actionBreakdown.map((entry) => ({
        name: entry.action || 'unknown',
        count: entry.count ?? 0,
        lastActionAt: entry.lastActionAt
      })) : [];
      moderationListsEl.appendChild(createListCard('Action breakdown', actionBreakdown, (item) => formatNumber(item.count), {
        emptyText: 'No moderation actions recorded.',
        getTitle: (item) => item.lastActionAt ? 'Last action ' + formatDateTimeWithRelative(item.lastActionAt) : ''
      }));

      const warnedUsers = Array.isArray(moderation.topUsers?.warnings) ? moderation.topUsers.warnings.slice(0, 5) : [];
      moderationListsEl.appendChild(createProfileListCard('Most warned users', warnedUsers, {
        emptyText: 'No warnings recorded.',
        getName: (entry) => describeUser(entry.user) || entry.userId,
        getSubtitle: (entry) => entry.lastWarningAt ? 'Last warning ' + formatDateTimeWithRelative(entry.lastWarningAt) : '',
        getValue: (entry) => formatCount(entry.count ?? 0, 'warning'),
        getTitle: (entry) => Array.isArray(entry.guildIds) && entry.guildIds.length ? 'Guilds: ' + entry.guildIds.join(', ') : ''
      }));

      const actionedUsers = Array.isArray(moderation.topUsers?.actions) ? moderation.topUsers.actions.slice(0, 5) : [];
      moderationListsEl.appendChild(createProfileListCard('Most moderated users', actionedUsers, {
        emptyText: 'No moderation actions recorded.',
        getName: (entry) => describeUser(entry.user) || entry.userId,
        getSubtitle: (entry) => entry.lastActionAt ? 'Last action ' + formatDateTimeWithRelative(entry.lastActionAt) : '',
        getValue: (entry) => formatCount(entry.count ?? 0, 'action'),
        getTitle: (entry) => Array.isArray(entry.actions) && entry.actions.length ? 'Actions: ' + entry.actions.join(', ') : ''
      }));

      const actionModerators = Array.isArray(moderation.topModerators?.actions) ? moderation.topModerators.actions.slice(0, 5) : [];
      moderationListsEl.appendChild(createProfileListCard('Most active moderators', actionModerators, {
        emptyText: 'No moderator actions recorded.',
        getName: (entry) => describeUser(entry.user) || entry.moderatorId,
        getSubtitle: (entry) => entry.lastActionAt ? 'Last action ' + formatDateTimeWithRelative(entry.lastActionAt) : '',
        getValue: (entry) => formatCount(entry.count ?? 0, 'action'),
        getTitle: (entry) => Array.isArray(entry.actions) && entry.actions.length ? 'Actions: ' + entry.actions.join(', ') : ''
      }));

      const warningModerators = Array.isArray(moderation.topModerators?.warnings) ? moderation.topModerators.warnings.slice(0, 5) : [];
      moderationListsEl.appendChild(createProfileListCard('Top warning moderators', warningModerators, {
        emptyText: 'No warnings recorded.',
        getName: (entry) => describeUser(entry.user) || entry.moderatorId,
        getSubtitle: (entry) => entry.lastWarningAt ? 'Last warning ' + formatDateTimeWithRelative(entry.lastWarningAt) : '',
        getValue: (entry) => formatCount(entry.count ?? 0, 'warning')
      }));

      moderationListsEl.hidden = !moderationListsEl.childElementCount;

      renderModerationTimeline(Array.isArray(moderation.timeline) ? moderation.timeline : []);

      const guildEntries = Array.isArray(moderation.guildBreakdown) ? moderation.guildBreakdown.slice(0, 10) : [];
      if (guildEntries.length) {
        guildEntries.forEach((entry) => {
          const tr = document.createElement('tr');
          const displayGuild = entry.guild || { id: entry.guildId, name: entry.guildId, iconUrl: null };
          const guildCell = document.createElement('td');
          guildCell.className = 'guild-cell';
          if (displayGuild.iconUrl) {
            const icon = document.createElement('img');
            icon.className = 'guild-icon';
            icon.src = displayGuild.iconUrl;
            icon.alt = displayGuild.name || displayGuild.id;
            guildCell.appendChild(icon);
          } else {
            const placeholder = document.createElement('div');
            placeholder.className = 'guild-icon placeholder';
            placeholder.textContent = displayGuild.name ? displayGuild.name.charAt(0).toUpperCase() : '?';
            guildCell.appendChild(placeholder);
          }
          const name = document.createElement('span');
          name.textContent = displayGuild.name || entry.guildId;
          guildCell.appendChild(name);
          tr.appendChild(guildCell);

          const warningCell = document.createElement('td');
          warningCell.textContent = formatNumber(entry.warningCount);
          tr.appendChild(warningCell);

          const actionCell = document.createElement('td');
          actionCell.textContent = formatNumber(entry.actionCount);
          tr.appendChild(actionCell);

          const uniqueCell = document.createElement('td');
          uniqueCell.textContent = formatNumber(entry.uniqueUsers);
          uniqueCell.title = 'Warnings: ' + formatNumber(entry.warningUserCount) + ' • Actions: ' + formatNumber(entry.actionUserCount);
          tr.appendChild(uniqueCell);

          const lastCell = document.createElement('td');
          lastCell.textContent = formatDateTimeWithRelative(entry.lastActivityAt);
          tr.appendChild(lastCell);

          moderationGuildBody.appendChild(tr);
        });
        moderationGuildWrapper.hidden = false;
      } else {
        moderationGuildWrapper.hidden = true;
      }

      const hasVolume = Number.isFinite(totals.warnings) && totals.warnings > 0
        || Number.isFinite(totals.actions) && totals.actions > 0;
      if (moderationEmptyEl) {
        moderationEmptyEl.textContent = guildId ? 'No moderation records for this guild yet.' : 'No moderation records found.';
        moderationEmptyEl.hidden = hasVolume;
      }
    }

    function describeUser(user) {
      if (!user) return '';
      const base = user.globalName || user.username || user.id;
      if (!base) return user.id || '';
      if (user.discriminator && user.discriminator !== '0') {
        return base + '#' + user.discriminator;
      }
      return base;
    }

    function makeAvatar(initial) {
      const span = document.createElement('span');
      span.className = 'avatar placeholder';
      span.textContent = initial || '?';
      return span;
    }

    function makeChannelIcon(type) {
      switch (type) {
        case CHANNEL_TYPES.GUILD_TEXT:
        case CHANNEL_TYPES.ANNOUNCEMENT_THREAD:
        case CHANNEL_TYPES.PUBLIC_THREAD:
        case CHANNEL_TYPES.PRIVATE_THREAD:
        case CHANNEL_TYPES.GUILD_ANNOUNCEMENT:
          return '#';
        case CHANNEL_TYPES.GUILD_VOICE:
          return '🔊';
        case CHANNEL_TYPES.GUILD_STAGE_VOICE:
          return '🎙️';
        case CHANNEL_TYPES.GUILD_FORUM:
          return '🗂️';
        case CHANNEL_TYPES.GUILD_CATEGORY:
          return '🗃️';
        case CHANNEL_TYPES.GUILD_DIRECTORY:
          return '📂';
        case CHANNEL_TYPES.GUILD_MEDIA:
          return '🖼️';
        default:
          return '•';
      }
    }

    function resetRoleView(message) {
      rolesStatusEl.textContent = message;
      rolesErrorEl.hidden = true;
      roleSummaryEl.hidden = true;
      roleTopList.hidden = true;
      roleTable.hidden = true;
      roleTableBody.innerHTML = '';
    }

    function resetChannelView(message) {
      channelsStatusEl.textContent = message;
      channelsErrorEl.hidden = true;
      channelSummaryEl.hidden = true;
      channelTable.hidden = true;
      channelTableBody.innerHTML = '';
    }

    function updateView() {
      if (isAuthenticated) {
        loginSection.hidden = true;
        dashboardSection.hidden = false;
        sessionMeta.textContent = currentUser ? 'Signed in as ' + currentUser : 'Signed in';
        userSearchWrapper.hidden = activeTab !== 'users';
      } else {
        loginSection.hidden = false;
        dashboardSection.hidden = true;
        sessionMeta.textContent = 'Please sign in to access moderation data.';
        loginPassword.value = '';
        setTimeout(() => loginUsername.focus(), 50);
      }
    }

    function setActiveTab(name) {
      activeTab = name;
      tabButtons.forEach((button) => {
        button.classList.toggle('active', button.dataset.tab === name);
      });
      tabPanels.forEach((panel) => {
        const isActive = panel.dataset.tabContent === name;
        panel.hidden = !isActive;
        panel.classList.toggle('active', isActive);
      });
      userSearchWrapper.hidden = name !== 'users';
      if (name === 'roles') {
        const guildId = getCurrentGuildFilter();
        if (guildId) {
          loadRoles(guildId);
        } else {
          resetRoleView('Enter a guild ID to load role insights.');
        }
      } else if (name === 'channels') {
        const guildId = getCurrentGuildFilter();
        if (guildId) {
          loadChannels(guildId);
        } else {
          resetChannelView('Enter a guild ID to load channel details.');
        }
      } else if (name === 'users') {
        renderUserTable(userSummaries);
      }
    }

    async function fetchSession() {
      statsStatusEl.textContent = 'Checking session…';
      try {
        const res = await fetch(AUTH_BASE + '/session', { credentials: 'include' });
        if (!res.ok) throw new Error('Session check failed');
        const data = await res.json();
        if (data.authenticated) {
          setAuthenticated(true, data.username || '');
        } else if (!isAuthenticated) {
          setAuthenticated(false, '');
        }
      } catch {
        if (!isAuthenticated) {
          setAuthenticated(false, '');
        }
      }
    }

    function setAuthenticated(state, username) {
      const wasAuthenticated = isAuthenticated;
      isAuthenticated = state;
      currentUser = username || '';
      updateView();
      if (!state) {
        statsSnapshot = null;
        userSummaries = [];
        userDetailCache.clear();
        roleCache.clear();
        channelCache.clear();
        userDetailEl.hidden = true;
        userDetailEl.classList.remove('active');
        userDetailEl.innerHTML = '';
        renderModerationOverview(null);
      }
      if (state && !wasAuthenticated) {
        activeTab = 'overview';
        setActiveTab(activeTab);
        refreshAll();
      }
    }

    function formatTopActions(topActions) {
      if (!Array.isArray(topActions) || !topActions.length) return '—';
      return topActions.map((entry) => (entry.action || 'unknown') + ' (' + entry.count + ')').join(', ');
    }

    function renderStats(data, guildId) {
      statsSnapshot = data;
      statsSummaryEl.innerHTML = '';
      insightsGrid.innerHTML = '';
      renderModerationOverview(data && data.moderation ? data.moderation : null, guildId || '');

      const totals = data && data.totals ? data.totals : {};
      const summaryItems = [
        ['Guilds', formatNumber(totals.guilds)],
        ['Members', formatCompact(totals.members)],
        ['Online', formatCompact(totals.approxPresences)],
        ['Channels', formatNumber(totals.channels)],
        ['Roles', formatNumber(totals.roles)],
        ['Boosts', formatNumber(totals.boosts)]
      ];
      let hasSummary = false;
      for (const [label, value] of summaryItems) {
        if (value !== '—') hasSummary = true;
        statsSummaryEl.appendChild(createStatPill(label, value));
      }
      statsSummaryEl.hidden = !hasSummary;

      const insights = data && data.insights ? data.insights : {};
      const insightCards = [];
      if (insights.averages) {
        const averages = insights.averages;
        const entries = [
          ['Members per guild', formatNumber(averages.membersPerGuild)],
          ['Online per guild', formatNumber(averages.onlineUsersPerGuild)],
          ['Boosts per guild', formatNumber(averages.boostsPerGuild)],
          ['Channels per guild', formatNumber(averages.channelsPerGuild)],
          ['Roles per guild', formatNumber(averages.rolesPerGuild)],
          ['Emoji per guild', formatNumber(averages.emojisPerGuild)],
          ['Stickers per guild', formatNumber(averages.stickersPerGuild)]
        ].filter(([, value]) => value !== '—');
        insightCards.push(createDefinitionCard('Averages', entries));
      }
      if (insights.ratios) {
        const ratios = insights.ratios;
        const entries = [
          ['Text / Voice', ratios.textToVoiceRatio ? ratios.textToVoiceRatio.toFixed(2) : '—'],
          ['Threads per text', ratios.threadsPerTextChannel ? ratios.threadsPerTextChannel.toFixed(2) : '—'],
          ['Average online ratio', ratios.averageOnlineRatio ? (ratios.averageOnlineRatio * 100).toFixed(1) + '%' : '—']
        ];
        insightCards.push(createDefinitionCard('Ratios', entries));
      }
      if (insights.topGuilds) {
        if (Array.isArray(insights.topGuilds.byMembers)) {
          insightCards.push(createListCard('Top guilds by members', insights.topGuilds.byMembers, (item) => formatNumber(item.memberCount || 0)));
        }
        if (Array.isArray(insights.topGuilds.byOnline)) {
          insightCards.push(createListCard('Most active guilds', insights.topGuilds.byOnline, (item) => formatNumber(item.approxPresenceCount || 0)));
        }
        if (Array.isArray(insights.topGuilds.byBoosts)) {
          insightCards.push(createListCard('Most boosted guilds', insights.topGuilds.byBoosts, (item) => formatNumber(item.boostCount || 0)));
        }
      }
      if (insights.distribution) {
        const memberDistribution = insights.distribution.memberCount || {};
        const presenceDistribution = insights.distribution.presenceCount || {};
        insightCards.push(createDefinitionCard('Member distribution', [
          ['Average', formatNumber(memberDistribution.average)],
          ['Median', formatNumber(memberDistribution.median)],
          ['Max', formatNumber(memberDistribution.max)],
          ['Min', formatNumber(memberDistribution.min)]
        ]));
        insightCards.push(createDefinitionCard('Online distribution', [
          ['Average', formatNumber(presenceDistribution.average)],
          ['Median', formatNumber(presenceDistribution.median)],
          ['Max', formatNumber(presenceDistribution.max)],
          ['Min', formatNumber(presenceDistribution.min)]
        ]));
      }
      if (insightCards.length) {
        insightCards.forEach((card) => insightsGrid.appendChild(card));
        insightsGrid.hidden = false;
      } else {
        insightsGrid.hidden = true;
      }

      guildStatsBody.innerHTML = '';
      const guilds = Array.isArray(data.guilds) ? data.guilds : [];
      if (guilds.length) {
        guilds.forEach((guild) => {
          const tr = document.createElement('tr');

          const guildCell = document.createElement('td');
          guildCell.className = 'guild-cell';
          if (guild.iconUrl) {
            const icon = document.createElement('img');
            icon.className = 'guild-icon';
            icon.src = guild.iconUrl;
            icon.alt = guild.name || guild.id;
            guildCell.appendChild(icon);
          } else {
            const placeholder = document.createElement('div');
            placeholder.className = 'guild-icon placeholder';
            placeholder.textContent = guild.name ? guild.name.charAt(0).toUpperCase() : '?';
            guildCell.appendChild(placeholder);
          }
          const nameEl = document.createElement('span');
          nameEl.textContent = guild.name || guild.id;
          guildCell.appendChild(nameEl);
          tr.appendChild(guildCell);

          const membersCell = document.createElement('td');
          membersCell.textContent = formatNumber(guild.memberCount);
          tr.appendChild(membersCell);

          const onlineCell = document.createElement('td');
          onlineCell.textContent = formatNumber(guild.approxPresenceCount);
          tr.appendChild(onlineCell);

          const ratioCell = document.createElement('td');
          ratioCell.textContent = formatPercent(guild.approxPresenceCount, guild.memberCount);
          tr.appendChild(ratioCell);

          const channelCell = document.createElement('td');
          channelCell.textContent = formatNumber(guild.channelCounts ? guild.channelCounts.total : null);
          if (guild.channelCounts) {
            const breakdown = [
              ['Text', guild.channelCounts.text],
              ['Voice', guild.channelCounts.voice],
              ['Stage', guild.channelCounts.stage],
              ['Forum', guild.channelCounts.forum],
              ['Announcement', guild.channelCounts.announcement],
              ['Thread', guild.channelCounts.thread],
              ['Category', guild.channelCounts.category]
            ].map(([label, value]) => label + ': ' + formatNumber(value)).join('
');
            channelCell.title = breakdown;
          }
          tr.appendChild(channelCell);

          const roleCell = document.createElement('td');
          roleCell.textContent = formatNumber(guild.roleCount);
          tr.appendChild(roleCell);

          const boostCell = document.createElement('td');
          boostCell.textContent = formatNumber(guild.boostCount);
          if (guild.boostLevel) {
            boostCell.title = 'Tier ' + guild.boostLevel;
          }
          tr.appendChild(boostCell);

          guildStatsBody.appendChild(tr);
        });
        guildStatsWrapper.hidden = false;
        statsStatusEl.textContent = (data.generatedAt ? 'Last updated ' + formatDateTime(data.generatedAt) : 'Last updated just now') + (guildId ? ' — Filter: ' + guildId : '');
      } else {
        guildStatsWrapper.hidden = true;
        statsStatusEl.textContent = guildId ? 'No guilds available for the current filter.' : 'No guild data available.';
      }
    }

    function renderUserTable(users) {
      userTableBody.innerHTML = '';
      userDetailEl.hidden = true;
      userDetailEl.classList.remove('active');
      userDetailEl.innerHTML = '';
      if (!Array.isArray(users) || !users.length) {
        userTable.hidden = true;
        usersStatusEl.textContent = 'No users found.';
        return;
      }
      const query = (userSearchEl.value || '').trim().toLowerCase();
      const filtered = !query ? users : users.filter((user) => {
        const fields = [
          user.userId,
          user.user?.username,
          user.user?.globalName,
          user.user?.tag
        ].filter(Boolean).map((value) => value.toLowerCase());
        return fields.some((field) => field.includes(query));
      });

      filtered.forEach((user) => {
        const tr = document.createElement('tr');
        tr.dataset.userId = user.userId;

        const userCell = document.createElement('td');
        userCell.className = 'user-cell';
        const displayUser = user.user;
        if (displayUser && displayUser.avatarUrl) {
          const avatar = document.createElement('img');
          avatar.className = 'avatar';
          avatar.src = displayUser.avatarUrl;
          avatar.alt = displayUser.username || displayUser.id;
          userCell.appendChild(avatar);
        } else {
          userCell.appendChild(makeAvatar(displayUser && displayUser.username ? displayUser.username.charAt(0).toUpperCase() : '?'));
        }
        const meta = document.createElement('div');
        meta.className = 'user-meta';
        const name = document.createElement('span');
        name.textContent = describeUser(displayUser) || user.userId;
        meta.appendChild(name);
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = displayUser && displayUser.tag ? displayUser.tag : user.userId;
        meta.appendChild(tag);
        userCell.appendChild(meta);
        tr.appendChild(userCell);

        const warningCell = document.createElement('td');
        warningCell.textContent = formatNumber(user.warningCount);
        tr.appendChild(warningCell);

        const actionCell = document.createElement('td');
        actionCell.textContent = formatNumber(user.totalActions);
        tr.appendChild(actionCell);

        const topActionCell = document.createElement('td');
        topActionCell.textContent = formatTopActions(user.topActions);
        tr.appendChild(topActionCell);

        const lastActivityCell = document.createElement('td');
        lastActivityCell.textContent = formatDateTimeWithRelative(user.lastActivityAt);
        tr.appendChild(lastActivityCell);

        const moderatorCell = document.createElement('td');
        moderatorCell.textContent = formatNumber(user.moderatorCount);
        moderatorCell.title = (user.moderatorIds || []).join(', ');
        tr.appendChild(moderatorCell);

        const guildCell = document.createElement('td');
        guildCell.textContent = formatNumber(user.guildCount);
        guildCell.title = (user.guildIds || []).join(', ');
        tr.appendChild(guildCell);

        userTableBody.appendChild(tr);
      });

      userTable.hidden = !filtered.length;
      if (filtered.length) {
        usersStatusEl.textContent = 'Showing ' + filtered.length + ' of ' + users.length + ' users.';
      } else {
        usersStatusEl.textContent = 'No users match the current filter.';
      }
    }

    function renderUserDetail(detail) {
      if (!detail) {
        userDetailEl.hidden = true;
        userDetailEl.classList.remove('active');
        userDetailEl.innerHTML = '';
        return;
      }

      userDetailEl.hidden = false;
      userDetailEl.classList.add('active');
      userDetailEl.innerHTML = '';

      const header = document.createElement('div');
      header.className = 'detail-header';
      const heading = document.createElement('h3');
      heading.textContent = describeUser(detail.user) || detail.userId;
      header.appendChild(heading);
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'ghost-btn';
      closeBtn.textContent = 'Close';
      closeBtn.addEventListener('click', () => {
        userDetailEl.hidden = true;
        userDetailEl.classList.remove('active');
        userDetailEl.innerHTML = '';
        userTableBody.querySelectorAll('tr').forEach((row) => row.classList.remove('selected'));
      });
      header.appendChild(closeBtn);
      userDetailEl.appendChild(header);

      const metricsGrid = document.createElement('div');
      metricsGrid.className = 'metrics-grid';
      const metrics = [
        ['Warnings', formatNumber(detail.warningCount)],
        ['Actions', formatNumber(detail.actionCount)],
        ['Guilds', formatNumber(detail.guildCount)],
        ['Last activity', formatDateTimeWithRelative(detail.lastActivityAt)]
      ];
      metrics.forEach(([label, value]) => {
        const metric = document.createElement('div');
        metric.className = 'metric';
        const labelEl = document.createElement('span');
        labelEl.className = 'label';
        labelEl.textContent = label;
        const valueEl = document.createElement('span');
        valueEl.className = 'value';
        valueEl.textContent = value;
        metric.appendChild(labelEl);
        metric.appendChild(valueEl);
        metricsGrid.appendChild(metric);
      });
      userDetailEl.appendChild(metricsGrid);

      if (Array.isArray(detail.moderators) && detail.moderators.length) {
        const moderatorsLabel = document.createElement('div');
        moderatorsLabel.className = 'meta';
        moderatorsLabel.textContent = 'Moderators who interacted with this user';
        userDetailEl.appendChild(moderatorsLabel);

        const chipGroup = document.createElement('div');
        chipGroup.className = 'chip-group';
        detail.moderators.forEach((moderator) => {
          const chip = document.createElement('span');
          chip.className = 'chip';
          chip.textContent = describeUser(moderator.user) || moderator.id;
          chipGroup.appendChild(chip);
        });
        userDetailEl.appendChild(chipGroup);
      }

      const detailSections = document.createElement('div');
      detailSections.className = 'detail-sections';

      const guildSection = document.createElement('div');
      const guildHeading = document.createElement('h4');
      guildHeading.textContent = 'Guild breakdown';
      guildSection.appendChild(guildHeading);
      if (detail.guildBreakdown && detail.guildBreakdown.length) {
        const table = document.createElement('table');
        table.className = 'compact-table';
        const thead = document.createElement('thead');
        thead.innerHTML = '<tr><th>Guild ID</th><th>Warnings</th><th>Actions</th><th>Last activity</th></tr>';
        table.appendChild(thead);
        const tbody = document.createElement('tbody');
        detail.guildBreakdown.slice(0, 15).forEach((entry) => {
          const row = document.createElement('tr');
          const idCell = document.createElement('td');
          idCell.textContent = entry.guildId;
          row.appendChild(idCell);
          const warnCell = document.createElement('td');
          warnCell.textContent = formatNumber(entry.warningCount);
          row.appendChild(warnCell);
          const actionCell = document.createElement('td');
          actionCell.textContent = formatNumber(entry.actionCount);
          row.appendChild(actionCell);
          const activityCell = document.createElement('td');
          activityCell.textContent = formatDateTimeWithRelative(entry.lastActivityAt);
          row.appendChild(activityCell);
          tbody.appendChild(row);
        });
        table.appendChild(tbody);
        guildSection.appendChild(table);
      } else {
        const empty = document.createElement('p');
        empty.className = 'empty-state';
        empty.textContent = 'No guild-specific activity recorded.';
        guildSection.appendChild(empty);
      }
      detailSections.appendChild(guildSection);

      const warningSection = document.createElement('div');
      const warningHeading = document.createElement('h4');
      warningHeading.textContent = 'Recent warnings';
      warningSection.appendChild(warningHeading);
      if (detail.warnings && detail.warnings.length) {
        const table = document.createElement('table');
        table.className = 'compact-table';
        const thead = document.createElement('thead');
        thead.innerHTML = '<tr><th>When</th><th>Moderator</th><th>Reason</th></tr>';
        table.appendChild(thead);
        const tbody = document.createElement('tbody');
        detail.warnings.slice(0, 10).forEach((warning) => {
          const row = document.createElement('tr');
          const timeCell = document.createElement('td');
          timeCell.textContent = formatDateTimeWithRelative(warning.createdAt);
          row.appendChild(timeCell);
          const modCell = document.createElement('td');
          modCell.textContent = describeUser(warning.moderator) || warning.modId || '—';
          row.appendChild(modCell);
          const reasonCell = document.createElement('td');
          reasonCell.textContent = warning.reason || '—';
          row.appendChild(reasonCell);
          tbody.appendChild(row);
        });
        table.appendChild(tbody);
        warningSection.appendChild(table);
      } else {
        const empty = document.createElement('p');
        empty.className = 'empty-state';
        empty.textContent = 'No warnings found for this user.';
        warningSection.appendChild(empty);
      }
      detailSections.appendChild(warningSection);

      const actionSection = document.createElement('div');
      const actionHeading = document.createElement('h4');
      actionHeading.textContent = 'Recent actions';
      actionSection.appendChild(actionHeading);
      if (detail.actions && detail.actions.length) {
        const table = document.createElement('table');
        table.className = 'compact-table';
        const thead = document.createElement('thead');
        thead.innerHTML = '<tr><th>When</th><th>Action</th><th>Moderator</th><th>Reason</th></tr>';
        table.appendChild(thead);
        const tbody = document.createElement('tbody');
        detail.actions.slice(0, 10).forEach((action) => {
          const row = document.createElement('tr');
          const timeCell = document.createElement('td');
          timeCell.textContent = formatDateTimeWithRelative(action.createdAt);
          row.appendChild(timeCell);
          const actionCell = document.createElement('td');
          actionCell.textContent = action.action || '—';
          row.appendChild(actionCell);
          const modCell = document.createElement('td');
          modCell.textContent = describeUser(action.moderator) || action.moderatorId || '—';
          row.appendChild(modCell);
          const reasonCell = document.createElement('td');
          reasonCell.textContent = action.reason || '—';
          row.appendChild(reasonCell);
          tbody.appendChild(row);
        });
        table.appendChild(tbody);
        actionSection.appendChild(table);
      } else {
        const empty = document.createElement('p');
        empty.className = 'empty-state';
        empty.textContent = 'No moderation actions found for this user.';
        actionSection.appendChild(empty);
      }
      detailSections.appendChild(actionSection);

      userDetailEl.appendChild(detailSections);

      if (detail.actionSummary && detail.actionSummary.length) {
        userDetailEl.appendChild(createDefinitionCard('Action summary', detail.actionSummary.map((entry) => [entry.action || 'unknown', formatNumber(entry.count)])));
      }
      if (detail.warningSummary && detail.warningSummary.length) {
        userDetailEl.appendChild(createDefinitionCard('Top warning reasons', detail.warningSummary.map((entry) => [entry.reason || '—', formatNumber(entry.count)])));
      }
    }

    function renderRoleSummary(data) {
      if (!data) {
        resetRoleView('No role data available.');
        return;
      }
      const summary = data.summary || {};
      roleSummaryEl.innerHTML = '';
      roleTopList.innerHTML = '';

      const totalPills = [
        ['Roles', formatNumber(summary.totals ? summary.totals.totalRoles : null)],
        ['Assignable', formatNumber(summary.totals ? summary.totals.assignableRoles : null)],
        ['Managed', formatNumber(summary.totals ? summary.totals.managedRoles : null)],
        ['Hoisted', formatNumber(summary.totals ? summary.totals.hoistedRoles : null)],
        ['Mentionable', formatNumber(summary.totals ? summary.totals.mentionableRoles : null)],
        ['With color', formatNumber(summary.totals ? summary.totals.rolesWithColor : null)]
      ];
      totalPills.forEach(([label, value]) => roleSummaryEl.appendChild(createStatPill(label, value)));
      roleSummaryEl.hidden = false;

      const memberCounts = summary.memberCounts || {};
      roleTopList.appendChild(createDefinitionCard('Member distribution', [
        ['Known', formatNumber(memberCounts.known)],
        ['Unknown', formatNumber(memberCounts.unknown)],
        ['Average', formatNumber(memberCounts.average)],
        ['Median', formatNumber(memberCounts.median)],
        ['Max', formatNumber(memberCounts.max)],
        ['Min', formatNumber(memberCounts.min)]
      ]));

      const permissionUsage = summary.permissionUsage || [];
      roleTopList.appendChild(createListCard('Most used permissions', permissionUsage, (entry) => formatNumber(entry.count), { emptyText: 'No permission data available.' }));

      const topRoles = summary.topRoles || [];
      roleTopList.appendChild(createListCard('Most assigned roles', topRoles, (entry) => formatNumber(entry.memberCount || 0), {
        getTitle: (entry) => 'Humans: ' + formatNumber(entry.humanCount) + '
Bots: ' + formatNumber(entry.botCount)
      }));
      roleTopList.hidden = false;

      roleTableBody.innerHTML = '';
      (data.roles || []).forEach((role) => {
        const tr = document.createElement('tr');

        const nameCell = document.createElement('td');
        const wrapper = document.createElement('div');
        wrapper.style.display = 'flex';
        wrapper.style.alignItems = 'center';
        wrapper.style.gap = '0.65rem';

        const swatch = document.createElement('span');
        swatch.className = 'color-swatch';
        swatch.style.background = role.color && role.color !== '#000000' ? role.color : '#1e293b';
        wrapper.appendChild(swatch);

        const name = document.createElement('span');
        name.textContent = role.name || role.id;
        wrapper.appendChild(name);
        nameCell.appendChild(wrapper);
        tr.appendChild(nameCell);

        const memberCell = document.createElement('td');
        memberCell.textContent = formatNumber(role.memberCount);
        tr.appendChild(memberCell);

        const botCell = document.createElement('td');
        botCell.textContent = formatNumber(role.botCount);
        tr.appendChild(botCell);

        const humanCell = document.createElement('td');
        humanCell.textContent = formatNumber(role.humanCount);
        tr.appendChild(humanCell);

        const permCell = document.createElement('td');
        permCell.textContent = role.permissionsCount ? role.permissionsCount + ' perms' : '0';
        if (role.permissions && role.permissions.length) {
          permCell.title = role.permissions.join(', ');
        }
        tr.appendChild(permCell);

        const flagCell = document.createElement('td');
        const flags = [];
        if (role.isEveryone) flags.push('Default');
        if (role.managed) flags.push('Managed');
        if (role.hoist) flags.push('Hoisted');
        if (role.mentionable) flags.push('Mentionable');
        if (role.tags?.premiumSubscriberRole) flags.push('Booster');
        if (role.tags?.availableForPurchase) flags.push('Purchasable');
        if (role.tags?.guildConnections) flags.push('Connections');
        flagCell.textContent = flags.length ? flags.join(', ') : '—';
        tr.appendChild(flagCell);

        const createdCell = document.createElement('td');
        createdCell.textContent = formatDateTime(role.createdAt);
        tr.appendChild(createdCell);

        roleTableBody.appendChild(tr);
      });
      roleTable.hidden = !(data.roles && data.roles.length);
      rolesStatusEl.textContent = 'Loaded ' + (data.roles ? data.roles.length : 0) + ' roles' + (data.generatedAt ? ' • Updated ' + formatDateTime(data.generatedAt) : '');
    }

    function renderChannelSummary(data) {
      if (!data) {
        resetChannelView('No channel data available.');
        return;
      }
      channelSummaryEl.innerHTML = '';
      const totals = data.summary ? data.summary.totals : null;
      if (totals) {
        const pills = [
          ['Total channels', formatNumber(totals.total)],
          ['Text', formatNumber(totals.text)],
          ['Voice', formatNumber(totals.voice)],
          ['Stage', formatNumber(totals.stage)],
          ['Threads', formatNumber(totals.thread)],
          ['Categories', formatNumber(totals.category)],
          ['Forum', formatNumber(totals.forum)],
          ['Announcements', formatNumber(totals.announcement)]
        ];
        pills.forEach(([label, value]) => channelSummaryEl.appendChild(createStatPill(label, value)));
      }
      if (data.summary) {
        const voiceSummary = data.summary.voice || {};
        channelSummaryEl.appendChild(createStatPill('Voice capacity', voiceSummary.capacity ? formatNumber(voiceSummary.capacity) : 'Unlimited', voiceSummary.unlimitedChannels ? voiceSummary.unlimitedChannels + ' unlimited channels' : null));
        channelSummaryEl.appendChild(createStatPill('Active voice users', formatNumber(voiceSummary.activeUsers)));
        channelSummaryEl.appendChild(createStatPill('NSFW channels', formatNumber(data.summary.nsfwChannels)));
        channelSummaryEl.appendChild(createStatPill('Slowmode channels', formatNumber(data.summary.slowmodeEnabled)));
        const threadSummary = data.summary.threads || {};
        channelSummaryEl.appendChild(createStatPill('Active threads', formatNumber(threadSummary.active)));
        channelSummaryEl.appendChild(createStatPill('Archived threads', formatNumber(threadSummary.archived)));
      }
      channelSummaryEl.hidden = false;

      channelTableBody.innerHTML = '';
      (data.channels || []).forEach((channel) => {
        const tr = document.createElement('tr');

        const channelCell = document.createElement('td');
        const label = document.createElement('div');
        label.style.display = 'flex';
        label.style.alignItems = 'center';
        label.style.gap = '0.5rem';
        const icon = document.createElement('span');
        icon.className = 'channel-icon';
        icon.textContent = makeChannelIcon(channel.type);
        label.appendChild(icon);
        const name = document.createElement('span');
        name.textContent = channel.name || channel.id;
        label.appendChild(name);
        channelCell.appendChild(label);
        tr.appendChild(channelCell);

        const typeCell = document.createElement('td');
        typeCell.textContent = channel.typeLabel || '—';
        tr.appendChild(typeCell);

        const parentCell = document.createElement('td');
        parentCell.textContent = channel.parentName || channel.parentId || '—';
        tr.appendChild(parentCell);

        const memberCell = document.createElement('td');
        memberCell.textContent = formatNumber(channel.memberCount);
        if (Number.isFinite(channel.botCount)) {
          memberCell.title = 'Bots: ' + channel.botCount;
        }
        tr.appendChild(memberCell);

        const rateCell = document.createElement('td');
        const parts = [];
        if (Number.isFinite(channel.rateLimitPerUser)) {
          parts.push('Slowmode ' + formatSeconds(channel.rateLimitPerUser));
        }
        if (Number.isFinite(channel.bitrate)) {
          parts.push((channel.bitrate / 1000).toFixed(0) + ' kbps');
        }
        if (Number.isFinite(channel.userLimit)) {
          parts.push('Limit ' + channel.userLimit);
        } else if (channel.type === CHANNEL_TYPES.GUILD_VOICE || channel.type === CHANNEL_TYPES.GUILD_STAGE_VOICE) {
          parts.push('No user limit');
        }
        rateCell.textContent = parts.length ? parts.join(' • ') : '—';
        tr.appendChild(rateCell);

        const flagCell = document.createElement('td');
        const flagList = [];
        if (channel.nsfw) flagList.push('NSFW');
        if (channel.archived) flagList.push('Archived');
        if (channel.locked) flagList.push('Locked');
        if (channel.invitable === false) flagList.push('Closed');
        if (channel.isTextBased) flagList.push('Text');
        if (channel.childCount) flagList.push(channel.childCount + ' children');
        flagCell.textContent = flagList.length ? flagList.join(', ') : '—';
        tr.appendChild(flagCell);

        const createdCell = document.createElement('td');
        createdCell.textContent = formatDateTime(channel.createdAt);
        tr.appendChild(createdCell);

        const activityCell = document.createElement('td');
        activityCell.textContent = formatDateTimeWithRelative(channel.lastActivityAt);
        tr.appendChild(activityCell);

        channelTableBody.appendChild(tr);
      });
      channelTable.hidden = !(data.channels && data.channels.length);
      channelsStatusEl.textContent = 'Loaded ' + (data.channels ? data.channels.length : 0) + ' channels' + (data.generatedAt ? ' • Updated ' + formatDateTime(data.generatedAt) : '');
    }

    async function loadStats(guildId) {
      statsErrorEl.hidden = true;
      try {
        const query = guildId ? '?guildId=' + encodeURIComponent(guildId) : '';
        const res = await fetch(API_BASE + '/stats' + query, { credentials: 'include' });
        if (res.status === 401 || res.status === 403) {
          setAuthenticated(false, '');
          throw new Error('Authentication required');
        }
        if (!res.ok) {
          throw new Error('Failed to load server stats (' + res.status + ')');
        }
        const data = await res.json();
        renderStats(data, guildId);
      } catch (error) {
        statsErrorEl.textContent = error.message || 'Unknown error';
        statsErrorEl.hidden = false;
        if (!statsSnapshot) {
          statsStatusEl.textContent = 'Unable to load server statistics.';
          statsSummaryEl.hidden = true;
          insightsGrid.hidden = true;
          guildStatsWrapper.hidden = true;
          renderModerationOverview(null);
        }
      }
    }

    async function loadUsers(guildId) {
      usersErrorEl.hidden = true;
      try {
        const query = guildId ? '?guildId=' + encodeURIComponent(guildId) : '';
        const res = await fetch(API_BASE + '/users' + query, { credentials: 'include' });
        if (res.status === 401 || res.status === 403) {
          setAuthenticated(false, '');
          throw new Error('Authentication required');
        }
        if (!res.ok) {
          throw new Error('Failed to load user summaries (' + res.status + ')');
        }
        const data = await res.json();
        userSummaries = Array.isArray(data.users) ? data.users : [];
        renderUserTable(userSummaries);
        usersStatusEl.textContent = userSummaries.length ? 'Loaded ' + userSummaries.length + ' users.' : 'No users found.';
      } catch (error) {
        usersErrorEl.textContent = error.message || 'Unknown error';
        usersErrorEl.hidden = false;
        if (!userSummaries.length) {
          usersStatusEl.textContent = 'Unable to load users.';
          userTable.hidden = true;
        }
      }
    }

    async function loadUserDetail(userId, guildId) {
      const cacheKey = guildId ? userId + ':' + guildId : userId;
      if (userDetailCache.has(cacheKey)) {
        renderUserDetail(userDetailCache.get(cacheKey));
        return;
      }
      userDetailEl.hidden = false;
      userDetailEl.classList.add('active');
      userDetailEl.innerHTML = '<p class="meta">Loading user details…</p>';
      try {
        const query = guildId ? '?guildId=' + encodeURIComponent(guildId) : '';
        const res = await fetch(API_BASE + '/users/' + encodeURIComponent(userId) + query, { credentials: 'include' });
        if (res.status === 404) {
          userDetailEl.innerHTML = '<p class="error">No details found for this user.</p>';
          return;
        }
        if (res.status === 401 || res.status === 403) {
          setAuthenticated(false, '');
          throw new Error('Authentication required');
        }
        if (!res.ok) {
          throw new Error('Failed to load user details (' + res.status + ')');
        }
        const data = await res.json();
        userDetailCache.set(cacheKey, data);
        renderUserDetail(data);
      } catch (error) {
        userDetailEl.innerHTML = '<p class="error">' + (error.message || 'Unknown error') + '</p>';
      }
    }

    async function loadRoles(guildId) {
      if (!guildId) {
        resetRoleView('Enter a guild ID to load role insights.');
        return;
      }
      rolesErrorEl.hidden = true;
      if (roleCache.has(guildId)) {
        renderRoleSummary(roleCache.get(guildId));
      } else {
        rolesStatusEl.textContent = 'Loading role insights…';
      }
      try {
        const res = await fetch(API_BASE + '/guilds/' + encodeURIComponent(guildId) + '/roles', { credentials: 'include' });
        if (res.status === 404) {
          resetRoleView('Guild not found or inaccessible.');
          return;
        }
        if (res.status === 401 || res.status === 403) {
          setAuthenticated(false, '');
          throw new Error('Authentication required');
        }
        if (!res.ok) {
          throw new Error('Failed to load role insights (' + res.status + ')');
        }
        const data = await res.json();
        roleCache.set(guildId, data);
        renderRoleSummary(data);
      } catch (error) {
        rolesErrorEl.textContent = error.message || 'Unknown error';
        rolesErrorEl.hidden = false;
      }
    }

    async function loadChannels(guildId) {
      if (!guildId) {
        resetChannelView('Enter a guild ID to load channel details.');
        return;
      }
      channelsErrorEl.hidden = true;
      if (channelCache.has(guildId)) {
        renderChannelSummary(channelCache.get(guildId));
      } else {
        channelsStatusEl.textContent = 'Loading channel details…';
      }
      try {
        const res = await fetch(API_BASE + '/guilds/' + encodeURIComponent(guildId) + '/channels', { credentials: 'include' });
        if (res.status === 404) {
          resetChannelView('Guild not found or inaccessible.');
          return;
        }
        if (res.status === 401 || res.status === 403) {
          setAuthenticated(false, '');
          throw new Error('Authentication required');
        }
        if (!res.ok) {
          throw new Error('Failed to load channel details (' + res.status + ')');
        }
        const data = await res.json();
        channelCache.set(guildId, data);
        renderChannelSummary(data);
      } catch (error) {
        channelsErrorEl.textContent = error.message || 'Unknown error';
        channelsErrorEl.hidden = false;
      }
    }

    async function refreshAll() {
      if (!isAuthenticated) return;
      refreshBtn.disabled = true;
      try {
        const guildId = getCurrentGuildFilter();
        currentGuildFilter = guildId;
        await Promise.all([loadStats(guildId), loadUsers(guildId)]);
        if (guildId) {
          if (activeTab === 'roles') {
            await loadRoles(guildId);
          } else if (roleCache.has(guildId)) {
            renderRoleSummary(roleCache.get(guildId));
          } else {
            rolesStatusEl.textContent = 'Select the Roles tab to load insights.';
          }
          if (activeTab === 'channels') {
            await loadChannels(guildId);
          } else if (channelCache.has(guildId)) {
            renderChannelSummary(channelCache.get(guildId));
          } else {
            channelsStatusEl.textContent = 'Select the Channels tab to load details.';
          }
        } else {
          resetRoleView('Enter a guild ID to load role insights.');
          resetChannelView('Enter a guild ID to load channel details.');
        }
      } finally {
        refreshBtn.disabled = false;
      }
    }

    tabButtons.forEach((button) => {
      button.addEventListener('click', () => {
        if (!isAuthenticated) return;
        const tab = button.dataset.tab;
        if (tab) setActiveTab(tab);
      });
    });

    guildFilterEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        refreshAll();
      }
    });

    guildFilterEl.addEventListener('input', () => {
      const guildId = getCurrentGuildFilter();
      if (!guildId) {
        resetRoleView('Enter a guild ID to load role insights.');
        resetChannelView('Enter a guild ID to load channel details.');
      } else {
        if (activeTab !== 'roles') {
          rolesStatusEl.textContent = 'Press Refresh to load role insights for ' + guildId + '.';
        }
        if (activeTab !== 'channels') {
          channelsStatusEl.textContent = 'Press Refresh to load channel details for ' + guildId + '.';
        }
      }
    });

    userSearchEl.addEventListener('input', () => {
      renderUserTable(userSummaries);
    });

    userTableBody.addEventListener('click', (event) => {
      const row = event.target.closest('tr[data-user-id]');
      if (!row) return;
      userTableBody.querySelectorAll('tr').forEach((r) => r.classList.remove('selected'));
      row.classList.add('selected');
      loadUserDetail(row.dataset.userId, currentGuildFilter || '');
    });

    loginForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!loginUsername.value || !loginPassword.value) {
        loginErrorEl.textContent = 'Username and password are required.';
        loginErrorEl.hidden = false;
        return;
      }
      loginErrorEl.hidden = true;
      try {
        const res = await fetch(AUTH_BASE + '/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ username: loginUsername.value.trim(), password: loginPassword.value })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error || 'Login failed');
        }
        setAuthenticated(true, data.username || '');
        loginPassword.value = '';
      } catch (error) {
        loginErrorEl.textContent = error.message || 'Login failed';
        loginErrorEl.hidden = false;
        loginPassword.value = '';
        loginPassword.focus();
      }
    });

    logoutBtn.addEventListener('click', async () => {
      logoutBtn.disabled = true;
      try {
        await fetch(AUTH_BASE + '/logout', { method: 'POST', credentials: 'include' });
      } catch {
        // ignore logout errors
      }
      logoutBtn.disabled = false;
      setAuthenticated(false, '');
    });

    refreshBtn.addEventListener('click', () => {
      refreshAll();
    });

    updateView();
    if (isAuthenticated) {
      activeTab = 'overview';
      setActiveTab(activeTab);
      refreshAll();
    } else {
      fetchSession();
    }
  </script>
</body>
</html>`;

  }
}
