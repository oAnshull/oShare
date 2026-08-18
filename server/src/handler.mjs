import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
  DynamoDBDocumentClient
} from "@aws-sdk/lib-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  ADMIN_COOKIE_NAME,
  ADMIN_SESSION_TTL_SECONDS,
  createAdminSession,
  verifyAdminSession
} from "./admin-auth.mjs";
import { validateCreateShare, safeFilename } from "./validation.mjs";

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const bucketName = process.env.BUCKET_NAME;
const tableName = process.env.TABLE_NAME;
const uploadSecret = process.env.UPLOAD_SECRET ?? "";
const adminPassword = process.env.ADMIN_PASSWORD ?? "";
const publicBaseUrl = (process.env.PUBLIC_BASE_URL ?? "").replace(/\/$/, "");
const brandName = process.env.BRAND_NAME?.trim() || "oShare";
const adminHtml = readFileSync(new URL("./admin.html", import.meta.url), "utf8")
  .replaceAll("{{BRAND_NAME}}", escapeHtml(brandName));
const adminLogo = readFileSync(new URL("./brand-logo.png", import.meta.url)).toString("base64");

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function json(statusCode, body, headers = {}) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers
    },
    body: JSON.stringify(body)
  };
}

function text(statusCode, body, headers = {}) {
  return {
    statusCode,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      ...headers
    },
    body
  };
}

function html(body) {
  return {
    statusCode: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'self'; connect-src 'self' https://*.amazonaws.com; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY"
    },
    body
  };
}

function png(body) {
  return {
    statusCode: 200,
    headers: {
      "content-type": "image/png",
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff"
    },
    isBase64Encoded: true,
    body
  };
}

function parseBody(event) {
  if (!event.body) return {};
  const body = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  return JSON.parse(body);
}

function header(event, name) {
  const headers = event.headers ?? {};
  const wanted = name.toLowerCase();
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === wanted);
  return key ? headers[key] : undefined;
}

function equalSecret(left, right) {
  const leftBuffer = Buffer.from(left ?? "");
  const rightBuffer = Buffer.from(right ?? "");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function uploaderAuthorized(event) {
  const authorization = header(event, "authorization");
  const supplied = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : header(event, "x-upload-secret");
  return Boolean(uploadSecret) && equalSecret(supplied, uploadSecret);
}

function cookie(event, name) {
  const cookieHeader = header(event, "cookie") ?? "";
  for (const part of cookieHeader.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

function adminAuthorized(event) {
  return verifyAdminSession(cookie(event, ADMIN_COOKIE_NAME), adminPassword);
}

function mutationAuthorized(event) {
  return uploaderAuthorized(event) || adminAuthorized(event);
}

function sessionCookie(value, maxAge) {
  return `${ADMIN_COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

function tokenFrom(event) {
  if (event.pathParameters?.token) return event.pathParameters.token;
  const match = (event.rawPath ?? event.path ?? "").match(/\/(?:shares|s)\/([^/]+)/);
  return match?.[1];
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function shareUrl(token) {
  return `${publicBaseUrl}/s/${encodeURIComponent(token)}`;
}

function downloadFilename(filename) {
  return safeFilename(filename).replace(/[^\x20-\x7e]/g, "_").slice(0, 200) || "download";
}

async function getShare(token) {
  const result = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { token }
    })
  );
  return result.Item;
}

async function createShare(event) {
  if (!mutationAuthorized(event)) return text(401, "unauthorized");

  let input;
  try {
    input = validateCreateShare(parseBody(event));
  } catch (error) {
    return json(400, { error: error.message });
  }

  const token = randomBytes(24).toString("base64url");
  const createdAt = nowSeconds();
  const expiresAt = createdAt + input.expiresInSeconds;
  const s3Key = `shares/${token}`;

  await ddb.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        token,
        gsiPk: "SHARES",
        s3Key,
        filename: input.filename,
        contentType: input.contentType,
        expectedSize: input.size,
        status: "pending",
        createdAt,
        expiresAt
      },
      ConditionExpression: "attribute_not_exists(#token)",
      ExpressionAttributeNames: { "#token": "token" }
    })
  );

  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: bucketName,
      Key: s3Key,
      ContentType: input.contentType
    }),
    { expiresIn: Math.min(input.expiresInSeconds, 60 * 60) }
  );

  return json(201, {
    token,
    uploadUrl,
    shareUrl: shareUrl(token),
    expiresAt,
    requiredUploadContentType: input.contentType
  });
}

async function completeShare(event) {
  if (!mutationAuthorized(event)) return text(401, "unauthorized");

  const token = tokenFrom(event);
  const item = await getShare(token);
  if (!item) return text(404, "share not found");
  if (item.expiresAt <= nowSeconds()) return text(410, "share expired");

  let head;
  try {
    head = await s3.send(new HeadObjectCommand({ Bucket: bucketName, Key: item.s3Key }));
  } catch {
    return text(409, "upload has not arrived");
  }

  if (head.ContentLength !== item.expectedSize) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucketName, Key: item.s3Key }));
    return text(400, "uploaded file size did not match the original file");
  }

  await ddb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { token },
      UpdateExpression: "SET #status = :status, completedAt = :completedAt",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":status": "ready", ":completedAt": nowSeconds() }
    })
  );

  return json(200, { shareUrl: shareUrl(token), expiresAt: item.expiresAt });
}

async function resolveShare(event) {
  const token = tokenFrom(event);
  const item = await getShare(token);
  if (!item || item.status !== "ready") return text(404, "share not found");

  const remainingSeconds = item.expiresAt - nowSeconds();
  if (remainingSeconds <= 0) return text(410, "share expired");

  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucketName, Key: item.s3Key }));
  } catch {
    return text(404, "file not found");
  }

  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: bucketName,
      Key: item.s3Key,
      ResponseContentDisposition: `attachment; filename="${downloadFilename(item.filename)}"`,
      ResponseContentType: item.contentType
    }),
    { expiresIn: Math.max(1, Math.min(60, remainingSeconds)) }
  );

  return {
    statusCode: 302,
    headers: {
      location: url,
      "cache-control": "no-store"
    },
    body: ""
  };
}

async function cancelShare(event) {
  if (!mutationAuthorized(event)) return text(401, "unauthorized");

  const token = tokenFrom(event);
  const item = await getShare(token);
  if (!item) return text(404, "share not found");

  await s3.send(new DeleteObjectCommand({ Bucket: bucketName, Key: item.s3Key }));
  await ddb.send(new DeleteCommand({ TableName: tableName, Key: { token } }));
  return json(200, { deleted: true });
}

function loginAdmin(event) {
  let suppliedPassword;
  try {
    suppliedPassword = parseBody(event).password;
  } catch {
    return json(400, { error: "invalid request" });
  }

  if (typeof suppliedPassword !== "string" || !adminPassword || !equalSecret(suppliedPassword, adminPassword)) {
    return json(401, { error: "invalid password" });
  }

  const session = createAdminSession(adminPassword);
  return json(200, { authenticated: true }, {
    "set-cookie": sessionCookie(session, ADMIN_SESSION_TTL_SECONDS)
  });
}

function logoutAdmin() {
  return json(200, { authenticated: false }, {
    "set-cookie": sessionCookie("", 0)
  });
}

async function listAdminShares(event) {
  if (!adminAuthorized(event)) return text(401, "unauthorized");

  const shares = [];
  let exclusiveStartKey;
  do {
    const result = await ddb.send(new ScanCommand({
      TableName: tableName,
      ExclusiveStartKey: exclusiveStartKey,
      ProjectionExpression: "#token, filename, contentType, expectedSize, #status, createdAt, expiresAt",
      ExpressionAttributeNames: { "#token": "token", "#status": "status" }
    }));
    shares.push(...(result.Items ?? []));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  const now = nowSeconds();
  return json(200, {
    shares: shares
      .filter((item) => item.expiresAt > now)
      .sort((left, right) => left.expiresAt - right.expiresAt)
      .map((item) => ({ ...item, shareUrl: shareUrl(item.token) }))
  });
}

async function cleanupExpiredShares() {
  const result = await ddb.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: "ExpiryIndex",
      KeyConditionExpression: "gsiPk = :gsiPk AND expiresAt <= :now",
      ExpressionAttributeValues: { ":gsiPk": "SHARES", ":now": nowSeconds() },
      Limit: 100
    })
  );

  let deleted = 0;
  for (const item of result.Items ?? []) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: bucketName, Key: item.s3Key }));
      await ddb.send(new DeleteCommand({ TableName: tableName, Key: { token: item.token } }));
      deleted += 1;
    } catch (error) {
      console.error("cleanup failed", { token: item.token, error });
    }
  }

  console.log("cleanup complete", { inspected: result.Items?.length ?? 0, deleted });
  return { inspected: result.Items?.length ?? 0, deleted };
}

function isScheduledEvent(event) {
  return event?.source === "aws.events" || event?.["detail-type"] === "Scheduled Event";
}

export async function handler(event) {
  if (isScheduledEvent(event)) return cleanupExpiredShares();

  const method = (event.requestContext?.http?.method ?? event.httpMethod ?? "GET").toUpperCase();
  const path = event.rawPath ?? event.path ?? "/";

  try {
    if (method === "GET" && (path === "/admin" || path === "/admin/")) return html(adminHtml);
    if (method === "GET" && path === "/admin/logo.png") return png(adminLogo);
    if (method === "POST" && path === "/admin/login") return loginAdmin(event);
    if (method === "POST" && path === "/admin/logout") return logoutAdmin();
    if (method === "GET" && path === "/admin/session") {
      return adminAuthorized(event) ? json(200, { authenticated: true }) : text(401, "unauthorized");
    }
    if (method === "GET" && path === "/admin/shares") return await listAdminShares(event);
    if (method === "POST" && path === "/shares") return await createShare(event);
    if (method === "POST" && path.endsWith("/complete")) return await completeShare(event);
    if (method === "DELETE" && path.startsWith("/shares/")) return await cancelShare(event);
    if (method === "GET" && path.startsWith("/s/")) return await resolveShare(event);
    return text(404, "not found");
  } catch (error) {
    console.error("request failed", error);
    return json(500, { error: "internal server error" });
  }
}
