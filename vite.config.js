import { randomBytes, pbkdf2, timingSafeEqual } from "node:crypto";
import { appendFile, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const csvPath = fileURLToPath(new URL("./.private/students.csv", import.meta.url));
const legacyCsvPath = fileURLToPath(new URL("./data/students.csv", import.meta.url));
const csvHeader = "id,salt,password_hash,created_at\n";
const sessionLifetime = 12 * 60 * 60 * 1000;
const sessions = new Map();
let accountWriteQueue = Promise.resolve();

async function prepareCsvStorage() {
  await mkdir(dirname(csvPath), { recursive: true, mode: 0o700 });
  try {
    await readFile(csvPath);
    await chmod(csvPath, 0o600);
    return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    await rename(legacyCsvPath, csvPath);
    await chmod(csvPath, 0o600);
    return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await writeFile(csvPath, csvHeader, { flag: "wx", mode: 0o600 });
}

function derivePassword(password, salt) {
  return new Promise((resolve, reject) => {
    pbkdf2(password, Buffer.from(salt, "hex"), 600000, 32, "sha256", (error, key) => {
      if (error) reject(error);
      else resolve(key.toString("hex"));
    });
  });
}

async function readAccounts() {
  await mkdir(dirname(csvPath), { recursive: true, mode: 0o700 });
  try {
    return (await readFile(csvPath, "utf8")).split(/\r?\n/).slice(1).filter(Boolean).map(line => {
      const [id, salt, passwordHash, createdAt] = line.split(",");
      return { id, salt, passwordHash, createdAt };
    });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    try {
      await writeFile(csvPath, csvHeader, { flag: "wx", mode: 0o600 });
    } catch (createError) {
      if (createError.code !== "EEXIST") throw createError;
    }
    return [];
  }
}

function serializeAccountWrite(operation) {
  const result = accountWriteQueue.then(operation, operation);
  accountWriteQueue = result.catch(() => {});
  return result;
}

function sendJson(response, status, value, extraHeaders = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders
  });
  response.end(JSON.stringify(value));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let tooLarge = false;
    request.on("data", chunk => {
      if (body.length + chunk.length > 8192) tooLarge = true;
      else body += chunk;
    });
    request.on("end", () => {
      if (tooLarge) return reject(Object.assign(new Error("요청 내용이 너무 큽니다."), { status: 413 }));
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(Object.assign(new Error("요청 형식이 올바르지 않습니다."), { status: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function cookieValue(request, name) {
  const prefix = `${name}=`;
  const cookie = request.headers.cookie || "";
  const part = cookie.split(";").map(value => value.trim()).find(value => value.startsWith(prefix));
  return part ? part.slice(prefix.length) : "";
}

function sessionCookie(token, maxAge) {
  return `codeon_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function createSession(response, studentId) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + sessionLifetime;
  for (const [savedToken, session] of sessions) {
    if (session.expiresAt <= Date.now()) sessions.delete(savedToken);
  }
  sessions.set(token, { studentId, expiresAt });
  response.setHeader("Set-Cookie", sessionCookie(token, sessionLifetime / 1000));
  return { user: { id: studentId } };
}

function csvAuthPlugin() {
  return {
    name: "codeon-csv-auth",
    async configureServer(server) {
      await prepareCsvStorage();
      server.middlewares.use((request, response, next) => {
        let pathname = "";
        try {
          pathname = decodeURIComponent(new URL(request.url || "/", "http://localhost").pathname);
        } catch {
          return sendJson(response, 400, { error: "요청 주소가 올바르지 않습니다." });
        }
        if (pathname.split("/").includes(".private") || pathname.startsWith("/data/")) {
          response.writeHead(404);
          return response.end();
        }
        next();
      });
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url || "/", "http://localhost").pathname;
        if (!pathname.startsWith("/api/auth/")) return next();

        (async () => {
          if (pathname === "/api/auth/me" && request.method === "GET") {
            const token = cookieValue(request, "codeon_session");
            const session = sessions.get(token);
            if (!session || session.expiresAt <= Date.now()) {
              sessions.delete(token);
              return sendJson(response, 200, { user: null });
            }
            return sendJson(response, 200, { user: { id: session.studentId } });
          }

          if (pathname === "/api/auth/logout" && request.method === "POST") {
            sessions.delete(cookieValue(request, "codeon_session"));
            return sendJson(response, 200, { user: null }, {
              "Set-Cookie": sessionCookie("", 0)
            });
          }

          if (!["/api/auth/signup", "/api/auth/login"].includes(pathname) || request.method !== "POST") {
            return sendJson(response, 404, { error: "요청한 주소를 찾을 수 없습니다." });
          }

          const body = await readJson(request);
          const studentId = typeof body.id === "string" ? body.id.trim().toLowerCase() : "";
          const password = typeof body.password === "string" ? body.password : "";
          if (!/^[a-z0-9._-]{3,32}$/.test(studentId)) {
            return sendJson(response, 400, { error: "아이디는 영문 소문자, 숫자, 점, 밑줄, 하이픈을 사용해 3~32자로 입력해 주세요." });
          }
          if (password.length < 8 || password.length > 128) {
            return sendJson(response, 400, { error: "비밀번호는 8자 이상 128자 이하로 입력해 주세요." });
          }

          if (pathname === "/api/auth/signup") {
            const created = await serializeAccountWrite(async () => {
              const accounts = await readAccounts();
              if (accounts.some(account => account.id === studentId)) return false;
              const salt = randomBytes(16).toString("hex");
              const passwordHash = await derivePassword(password, salt);
              const row = `${studentId},${salt},${passwordHash},${new Date().toISOString()}\n`;
              await appendFile(csvPath, row, { encoding: "utf8", mode: 0o600 });
              await chmod(csvPath, 0o600);
              return true;
            });
            if (!created) return sendJson(response, 409, { error: "이미 사용 중인 아이디입니다." });
            return sendJson(response, 201, createSession(response, studentId));
          }

          const accounts = await readAccounts();
          const account = accounts.find(item => item.id === studentId);
          const salt = account?.salt || "00000000000000000000000000000000";
          const attemptedHash = await derivePassword(password, salt);
          const savedHash = account ? Buffer.from(account.passwordHash, "hex") : Buffer.alloc(32);
          const valid = account && savedHash.length === 32 && timingSafeEqual(Buffer.from(attemptedHash, "hex"), savedHash);
          if (!valid) return sendJson(response, 401, { error: "아이디 또는 비밀번호를 확인해 주세요." });
          return sendJson(response, 200, createSession(response, studentId));
        })().catch(error => {
          if (response.headersSent) return;
          sendJson(response, error.status || 500, {
            error: error.status ? error.message : "로그인 처리 중 오류가 발생했습니다."
          });
        });
      });
    }
  };
}

export default defineConfig({
  plugins: [csvAuthPlugin()]
});
