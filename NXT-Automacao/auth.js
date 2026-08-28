"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const { DatabaseSync } = require("node:sqlite");

const SESSION_COOKIE = "nxt_session";
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LIMIT = 5;

function createAuth(options) {
  const databasePath = options.databasePath;
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });

  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec(
    "CREATE TABLE IF NOT EXISTS users ("
    + "id INTEGER PRIMARY KEY AUTOINCREMENT,"
    + "username TEXT NOT NULL UNIQUE COLLATE NOCASE,"
    + "password_hash TEXT NOT NULL,"
    + "password_salt TEXT NOT NULL,"
    + "role TEXT NOT NULL CHECK(role IN ('master','operator','viewer')),"
    + "active INTEGER NOT NULL DEFAULT 1,"
    + "created_at TEXT NOT NULL,"
    + "updated_at TEXT NOT NULL"
    + ");"
    + "CREATE TABLE IF NOT EXISTS sessions ("
    + "token_hash TEXT PRIMARY KEY,"
    + "user_id INTEGER NOT NULL,"
    + "expires_at INTEGER NOT NULL,"
    + "created_at TEXT NOT NULL,"
    + "FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE"
    + ");"
    + "CREATE TABLE IF NOT EXISTS minimum_stock ("
    + "category_key TEXT PRIMARY KEY,"
    + "category_name TEXT NOT NULL,"
    + "minimum INTEGER NOT NULL CHECK(minimum >= 0),"
    + "updated_by INTEGER,"
    + "updated_at TEXT NOT NULL,"
    + "FOREIGN KEY(updated_by) REFERENCES users(id) ON DELETE SET NULL"
    + ");"
  );

  const router = express.Router();
  const loginAttempts = new Map();

  function nowIso() {
    return new Date().toISOString();
  }

  function normalizeUsername(value) {
    return String(value || "").trim();
  }

  function normalizeCategory(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toUpperCase()
      .trim();
  }

  function validateUsername(username) {
    return /^[a-zA-Z0-9._-]{3,40}$/.test(username);
  }

  function passwordError(password) {
    const value = String(password || "");
    if (value.length < 10) return "A senha deve ter pelo menos 10 caracteres.";
    if (!/[a-z]/.test(value)) return "Inclua ao menos uma letra minúscula.";
    if (!/[A-Z]/.test(value)) return "Inclua ao menos uma letra maiúscula.";
    if (!/\d/.test(value)) return "Inclua ao menos um número.";
    if (!/[^A-Za-z0-9]/.test(value)) return "Inclua ao menos um símbolo.";
    return "";
  }

  function hashPassword(password, salt) {
    return crypto.scryptSync(String(password), salt, 64).toString("hex");
  }

  function createPassword(password) {
    const salt = crypto.randomBytes(24).toString("hex");
    return { salt: salt, hash: hashPassword(password, salt) };
  }

  function verifyPassword(password, user) {
    const expected = Buffer.from(user.password_hash, "hex");
    const received = Buffer.from(hashPassword(password, user.password_salt), "hex");
    return expected.length === received.length
      && crypto.timingSafeEqual(expected, received);
  }

  function parseCookies(request) {
    const cookies = {};
    String(request.headers.cookie || "").split(";").forEach(function (part) {
      const index = part.indexOf("=");
      if (index < 0) return;
      const key = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      if (key) cookies[key] = decodeURIComponent(value);
    });
    return cookies;
  }

  function tokenHash(token) {
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  function setSession(response, userId) {
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = Date.now() + SESSION_DURATION_MS;
    database.prepare(
      "INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)"
    ).run(tokenHash(token), userId, expiresAt, nowIso());
    response.setHeader(
      "Set-Cookie",
      SESSION_COOKIE + "=" + encodeURIComponent(token)
        + "; Path=/; HttpOnly; SameSite=Strict; Max-Age="
        + Math.floor(SESSION_DURATION_MS / 1000)
    );
  }

  function clearSession(request, response) {
    const token = parseCookies(request)[SESSION_COOKIE];
    if (token) {
      database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash(token));
    }
    response.setHeader(
      "Set-Cookie",
      SESSION_COOKIE + "=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"
    );
  }

  function currentUser(request) {
    const token = parseCookies(request)[SESSION_COOKIE];
    if (!token) return null;
    database.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
    return database.prepare(
      "SELECT users.id,users.username,users.role,users.active,sessions.expires_at "
      + "FROM sessions JOIN users ON users.id = sessions.user_id "
      + "WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND users.active = 1"
    ).get(tokenHash(token), Date.now()) || null;
  }

  function publicUser(user) {
    return {
      id: Number(user.id),
      username: user.username,
      role: user.role,
      active: Boolean(user.active),
      canEditMinimum: user.role === "master",
      canManageUsers: user.role === "master",
      canUpdateNxt: user.role === "master" || user.role === "operator"
    };
  }

  function requireAuth(request, response, next) {
    const user = currentUser(request);
    if (!user) {
      if (request.originalUrl.startsWith("/api/")) {
        return response.status(401).json({
          sucesso: false,
          mensagem: "Sua sessão expirou. Entre novamente."
        });
      }
      return response.redirect("/login.html");
    }
    request.user = user;
    return next();
  }

  function requireMaster(request, response, next) {
    if (!request.user) {
      const user = currentUser(request);
      if (user) request.user = user;
    }
    if (!request.user || request.user.role !== "master") {
      return response.status(403).json({
        sucesso: false,
        mensagem: "Apenas o Master Admin pode realizar esta alteração."
      });
    }
    return next();
  }

  function requireUpdatePermission(request, response, next) {
    if (!request.user) {
      const user = currentUser(request);
      if (user) request.user = user;
    }
    if (!request.user || !["master", "operator"].includes(request.user.role)) {
      return response.status(403).json({
        sucesso: false,
        mensagem: "Seu perfil não pode atualizar o NXT4Insight."
      });
    }
    return next();
  }

  function setupRequired() {
    const result = database.prepare("SELECT COUNT(*) AS total FROM users").get();
    return Number(result.total) === 0;
  }

  function attemptKey(request, username) {
    return String(request.ip || request.socket.remoteAddress || "local")
      + "|" + normalizeUsername(username).toLowerCase();
  }

  function blockedAttempt(request, username) {
    const key = attemptKey(request, username);
    const state = loginAttempts.get(key);
    if (!state) return false;
    if (Date.now() - state.startedAt > LOGIN_WINDOW_MS) {
      loginAttempts.delete(key);
      return false;
    }
    return state.count >= LOGIN_LIMIT;
  }

  function registerFailure(request, username) {
    const key = attemptKey(request, username);
    const state = loginAttempts.get(key);
    if (!state || Date.now() - state.startedAt > LOGIN_WINDOW_MS) {
      loginAttempts.set(key, { count: 1, startedAt: Date.now() });
    } else {
      state.count += 1;
    }
  }

  router.get("/status", function (request, response) {
    const user = currentUser(request);
    response.setHeader("Cache-Control", "no-store");
    response.json({
      setupRequired: setupRequired(),
      authenticated: Boolean(user),
      user: user ? publicUser(user) : null
    });
  });

  router.post("/setup", function (request, response) {
    if (!setupRequired()) {
      return response.status(409).json({
        sucesso: false,
        mensagem: "O Master Admin já foi configurado."
      });
    }
    const username = normalizeUsername(request.body.username);
    const password = String(request.body.password || "");
    if (!validateUsername(username)) {
      return response.status(400).json({
        sucesso: false,
        mensagem: "Use de 3 a 40 caracteres: letras, números, ponto, hífen ou sublinhado."
      });
    }
    const error = passwordError(password);
    if (error) {
      return response.status(400).json({ sucesso: false, mensagem: error });
    }
    const created = createPassword(password);
    const timestamp = nowIso();
    const result = database.prepare(
      "INSERT INTO users (username,password_hash,password_salt,role,active,created_at,updated_at) "
      + "VALUES (?,?,?,?,1,?,?)"
    ).run(username, created.hash, created.salt, "master", timestamp, timestamp);
    setSession(response, Number(result.lastInsertRowid));
    return response.status(201).json({
      sucesso: true,
      user: {
        id: Number(result.lastInsertRowid),
        username: username,
        role: "master",
        active: true,
        canEditMinimum: true,
        canManageUsers: true,
        canUpdateNxt: true
      }
    });
  });

  router.post("/login", function (request, response) {
    const username = normalizeUsername(request.body.username);
    const password = String(request.body.password || "");
    if (blockedAttempt(request, username)) {
      return response.status(429).json({
        sucesso: false,
        mensagem: "Muitas tentativas. Aguarde 15 minutos e tente novamente."
      });
    }
    const user = database.prepare(
      "SELECT * FROM users WHERE username = ? COLLATE NOCASE"
    ).get(username);
    if (!user || !user.active || !verifyPassword(password, user)) {
      registerFailure(request, username);
      return response.status(401).json({
        sucesso: false,
        mensagem: "Usuário ou senha inválidos."
      });
    }
    loginAttempts.delete(attemptKey(request, username));
    setSession(response, Number(user.id));
    return response.json({ sucesso: true, user: publicUser(user) });
  });

  router.post("/logout", function (request, response) {
    clearSession(request, response);
    response.json({ sucesso: true });
  });

  router.get("/me", requireAuth, function (request, response) {
    response.setHeader("Cache-Control", "no-store");
    response.json({ sucesso: true, user: publicUser(request.user) });
  });

  router.get("/users", requireAuth, requireMaster, function (request, response) {
    const users = database.prepare(
      "SELECT id,username,role,active,created_at,updated_at FROM users ORDER BY username"
    ).all().map(publicUser);
    response.json({ sucesso: true, users: users });
  });

  router.post("/users", requireAuth, requireMaster, function (request, response) {
    const username = normalizeUsername(request.body.username);
    const password = String(request.body.password || "");
    const role = ["operator", "viewer"].includes(request.body.role)
      ? request.body.role
      : "viewer";
    if (!validateUsername(username)) {
      return response.status(400).json({
        sucesso: false,
        mensagem: "O usuário deve ter de 3 a 40 caracteres válidos."
      });
    }
    const error = passwordError(password);
    if (error) return response.status(400).json({ sucesso: false, mensagem: error });
    if (database.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE").get(username)) {
      return response.status(409).json({
        sucesso: false,
        mensagem: "Já existe um usuário com esse nome."
      });
    }
    const created = createPassword(password);
    const timestamp = nowIso();
    const result = database.prepare(
      "INSERT INTO users (username,password_hash,password_salt,role,active,created_at,updated_at) "
      + "VALUES (?,?,?,?,1,?,?)"
    ).run(username, created.hash, created.salt, role, timestamp, timestamp);
    response.status(201).json({
      sucesso: true,
      user: publicUser({
        id: Number(result.lastInsertRowid),
        username: username,
        role: role,
        active: 1
      })
    });
  });

  router.patch("/users/:id", requireAuth, requireMaster, function (request, response) {
    const id = Number(request.params.id);
    const existing = database.prepare("SELECT * FROM users WHERE id = ?").get(id);
    if (!existing) {
      return response.status(404).json({ sucesso: false, mensagem: "Usuário não encontrado." });
    }
    const role = existing.role === "master"
      ? "master"
      : (["operator", "viewer"].includes(request.body.role) ? request.body.role : existing.role);
    const active = existing.role === "master"
      ? 1
      : (typeof request.body.active === "boolean"
        ? (request.body.active ? 1 : 0)
        : existing.active);
    let passwordHash = existing.password_hash;
    let passwordSalt = existing.password_salt;
    if (request.body.password) {
      const error = passwordError(request.body.password);
      if (error) return response.status(400).json({ sucesso: false, mensagem: error });
      const created = createPassword(request.body.password);
      passwordHash = created.hash;
      passwordSalt = created.salt;
      database.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
    }
    database.prepare(
      "UPDATE users SET role=?,active=?,password_hash=?,password_salt=?,updated_at=? WHERE id=?"
    ).run(role, active, passwordHash, passwordSalt, nowIso(), id);
    const updated = database.prepare(
      "SELECT id,username,role,active,created_at,updated_at FROM users WHERE id=?"
    ).get(id);
    response.json({ sucesso: true, user: publicUser(updated) });
  });

  function getMinimums() {
    return database.prepare(
      "SELECT category_key AS categoryKey,category_name AS categoryName,minimum,updated_at AS updatedAt "
      + "FROM minimum_stock ORDER BY category_name"
    ).all().map(function (row) {
      return {
        categoryKey: row.categoryKey,
        categoryName: row.categoryName,
        minimum: Number(row.minimum),
        updatedAt: row.updatedAt
      };
    });
  }

  function saveMinimums(items, userId) {
    const upsert = database.prepare(
      "INSERT INTO minimum_stock (category_key,category_name,minimum,updated_by,updated_at) "
      + "VALUES (?,?,?,?,?) ON CONFLICT(category_key) DO UPDATE SET "
      + "category_name=excluded.category_name,minimum=excluded.minimum,"
      + "updated_by=excluded.updated_by,updated_at=excluded.updated_at"
    );
    database.exec("BEGIN");
    try {
      items.forEach(function (item) {
        const name = String(item.categoryName || "").trim();
        const key = normalizeCategory(item.categoryKey || name);
        const minimum = Math.max(0, Number.parseInt(item.minimum, 10) || 0);
        if (name && key) upsert.run(key, name, minimum, userId, nowIso());
      });
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return getMinimums();
  }

  return {
    router: router,
    requireAuth: requireAuth,
    requireMaster: requireMaster,
    requireUpdatePermission: requireUpdatePermission,
    getMinimums: getMinimums,
    saveMinimums: saveMinimums,
    setupRequired: setupRequired
  };
}

module.exports = { createAuth };
