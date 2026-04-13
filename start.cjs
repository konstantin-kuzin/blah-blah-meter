/**
 * Локальная разработка: статика + POST/OPTIONS /api/groq (тот же handler, что на Vercel).
 * Live Server / «Open with Live Server» не запускают api/*.js — используйте этот скрипт.
 *
 * Запуск: node start.cjs
 * Порт: PORT=5500 (по умолчанию 5500; если занят — следующий, пока не найдётся свободный)
 * Ключ: export GROQ_API_KEY=... или поле в настройках приложения.
 */
/* eslint-disable no-console */
"use strict";

var http = require("http");
var fs = require("fs");
var path = require("path");

var ROOT = __dirname;
var PORT_START = Number(process.env.PORT) || 5500;
var PORT_ATTEMPTS = 30;

var groqHandler = require("./api/groq.js");

var MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json"
};

function patchRes(res) {
  res.status = function (code) {
    res.statusCode = code;
    return res;
  };
  res.json = function (obj) {
    if (!res.headersSent) {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
    }
    res.end(JSON.stringify(obj));
  };
  return res;
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    var chunks = [];
    req.on("data", function (c) {
      chunks.push(c);
    });
    req.on("end", function () {
      resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

function isPathInsideRoot(resolved) {
  var rootResolved = path.resolve(ROOT);
  var rel = path.relative(rootResolved, resolved);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function serveStatic(req, res, url) {
  var pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  var rel = pathname.replace(/^\/+/, "");
  var filePath = path.resolve(ROOT, rel);

  if (!isPathInsideRoot(filePath)) {
    res.statusCode = 403;
    res.end("Forbidden");
    return;
  }

  fs.stat(filePath, function (err, st) {
    if (err || !st.isFile()) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }
    fs.readFile(filePath, function (err2, data) {
      if (err2) {
        res.statusCode = 500;
        res.end("Error");
        return;
      }
      var ext = path.extname(filePath).toLowerCase();
      res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
      res.statusCode = 200;
      res.end(data);
    });
  });
}

function requestHandler(req, res) {
  patchRes(res);

  var host = req.headers.host || "127.0.0.1";
  var url;
  try {
    url = new URL(req.url || "/", "http://" + host);
  } catch (e) {
    res.statusCode = 400;
    res.end("Bad request");
    return;
  }

  if (url.pathname === "/api/groq") {
    if (req.method === "POST") {
      readBody(req)
        .then(function (buf) {
          try {
            req.body = buf.length ? JSON.parse(buf.toString("utf8")) : {};
          } catch (e2) {
            return res.status(400).json({ error: "Некорректный JSON" });
          }
          return Promise.resolve(groqHandler(req, res));
        })
        .catch(function (err) {
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ error: String(err && err.message ? err.message : err) }));
          }
        });
      return;
    }
    Promise.resolve(groqHandler(req, res)).catch(function (err) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: String(err && err.message ? err.message : err) }));
      }
    });
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    res.end("Method Not Allowed");
    return;
  }

  serveStatic(req, res, url);
}

function listenWithFallback(port, attempt) {
  var server = http.createServer(requestHandler);

  server.once("error", function (err) {
    if (err.code === "EADDRINUSE" && attempt < PORT_ATTEMPTS) {
      var next = port + 1;
      console.warn(
        "[start] Порт " +
          port +
          " занят (часто порт 5500 держит Live Server). Пробую " +
          next +
          "..."
      );
      listenWithFallback(next, attempt + 1);
      return;
    }
    console.error("[dev-server] Не удалось занять порт:", err.message);
    process.exit(1);
  });

  server.listen(port, "127.0.0.1", function () {
    console.log("http://127.0.0.1:" + port + "/  (Groq: POST /api/groq)");
  });
}

listenWithFallback(PORT_START, 0);
