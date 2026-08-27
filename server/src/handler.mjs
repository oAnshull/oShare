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
  TransactWriteCommand,
  UpdateCommand,
  DynamoDBDocumentClient
} from "@aws-sdk/lib-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { CancelJobCommand, CreateJobCommand, GetJobCommand, MediaConvertClient } from "@aws-sdk/client-mediaconvert";
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
const mediaConvert = new MediaConvertClient({});

const bucketName = process.env.BUCKET_NAME;
const tableName = process.env.TABLE_NAME;
const uploadSecret = process.env.UPLOAD_SECRET ?? "";
const adminPassword = process.env.ADMIN_PASSWORD ?? "";
const publicBaseUrl = (process.env.PUBLIC_BASE_URL ?? "").replace(/\/$/, "");
const brandName = process.env.BRAND_NAME?.trim() || "oShare";
const mediaConvertRoleArn = process.env.MEDIACONVERT_ROLE_ARN ?? "";
const statsKey = "__STATS__";
const dailyStatsPrefix = `${statsKey}:`;
const discordVideoLimit = 80 * 1024 * 1024;
const adminHtml = readFileSync(new URL("./admin.html", import.meta.url), "utf8")
  .replaceAll("{{BRAND_NAME}}", escapeHtml(brandName));
const adminLogo = readFileSync(new URL("./brand-logo.png", import.meta.url)).toString("base64");

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function dailyStatsKey(timestamp = nowSeconds()) {
  return `${dailyStatsPrefix}${new Date(timestamp * 1000).toISOString().slice(0, 10)}`;
}

export function trafficPeriods(items, timestamp = nowSeconds()) {
  const now = new Date(timestamp * 1000);
  const today = now.toISOString().slice(0, 10);
  const month = `${today.slice(0, 7)}-01`;
  const weekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ((now.getUTCDay() + 6) % 7)))
    .toISOString().slice(0, 10);
  const total = items.find((item) => item.token === statsKey) ?? {};
  const daily = items.filter((item) => item.token?.startsWith(dailyStatsPrefix));
  const sumSince = (start) => daily
    .filter((item) => item.token.slice(dailyStatsPrefix.length) >= start)
    .reduce((sum, item) => ({
      uploadedBytes: sum.uploadedBytes + (item.uploadedBytes ?? 0),
      downloadedBytes: sum.downloadedBytes + (item.downloadedBytes ?? 0)
    }), { uploadedBytes: 0, downloadedBytes: 0 });
  return {
    today: sumSince(today),
    week: sumSince(weekStart),
    month: sumSince(month),
    all: { uploadedBytes: total.uploadedBytes ?? 0, downloadedBytes: total.downloadedBytes ?? 0 }
  };
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

export function mediaPreview(item, token) {
  const filename = escapeHtml(item.filename);
  const pageUrl = shareUrl(token);
  const rawUrl = `${shareUrl(token)}?raw=1`;
  const logoUrl = `${publicBaseUrl}/admin/logo.png`;
  const embedUrl = item.discordS3Key ? `${rawUrl}&amp;discord=1` : rawUrl;
  const posterUrl = item.thumbnailS3Key ? `${rawUrl}&amp;thumbnail=1` : logoUrl;
  const media = item.contentType.startsWith("image/")
    ? `<img src="${rawUrl}" alt="${filename}">`
    : `<video src="${rawUrl}" poster="${posterUrl}" controls playsinline preload="metadata"></video>`;
  const openGraph = item.contentType.startsWith("image/")
    ? `<meta property="og:type" content="website"><meta property="og:image" content="${rawUrl}"><meta property="og:image:type" content="${escapeHtml(item.contentType)}">`
    : `<meta property="og:type" content="video.other"><meta property="og:image" content="${posterUrl}"><meta property="og:image:type" content="${item.thumbnailS3Key ? "image/jpeg" : "image/png"}"><meta property="og:video" content="${embedUrl}"><meta property="og:video:url" content="${embedUrl}"><meta property="og:video:secure_url" content="${embedUrl}"><meta property="og:video:type" content="video/mp4"><meta property="og:video:width" content="1280"><meta property="og:video:height" content="720">`;
  return {
    statusCode: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; img-src 'self' https://*.amazonaws.com; media-src 'self' https://*.amazonaws.com; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff"
    },
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${filename}</title><meta property="og:title" content="${filename}"><meta property="og:url" content="${pageUrl}"><meta property="og:site_name" content="${escapeHtml(brandName)}">${openGraph}<style>html{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#080b12;color:#f4f6fb;font:14px system-ui}main{width:min(1100px,calc(100% - 32px));text-align:center}img,video{display:block;max-width:100%;max-height:calc(100vh - 110px);margin:auto;border-radius:12px;box-shadow:0 18px 60px #0008}p{margin:16px 0 0;color:#a9b1c3}a{color:#b9afff}</style></head><body><main>${media}<p>${filename} · <a href="${rawUrl}&amp;download=1">Download</a></p></main></body></html>`
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

export function discordTranscodeSettings(input, destination) {
  return {
    OutputGroups: [
      {
        Name: "Discord video",
        OutputGroupSettings: { Type: "FILE_GROUP_SETTINGS", FileGroupSettings: { Destination: destination } },
        Outputs: [{
          NameModifier: "-discord",
          ContainerSettings: { Container: "MP4", Mp4Settings: { MoovPlacement: "PROGRESSIVE_DOWNLOAD" } },
          VideoDescription: {
            Width: 1280,
            Height: 720,
            ScalingBehavior: "DEFAULT",
            CodecSettings: { Codec: "H_264", H264Settings: {
              RateControlMode: "CBR",
              // ponytail: This keeps 3-minute clips well below Discord's proxy limit; make it duration-aware if longer clips matter.
              Bitrate: 3200000,
              CodecProfile: "HIGH",
              CodecLevel: "AUTO",
              FramerateControl: "INITIALIZE_FROM_SOURCE",
              GopSize: 2,
              GopSizeUnits: "SECONDS",
              SceneChangeDetect: "ENABLED",
              QualityTuningLevel: "SINGLE_PASS_HQ"
            } }
          },
          AudioDescriptions: [{
            AudioSourceName: "Default Audio",
            CodecSettings: { Codec: "AAC", AacSettings: {
              Bitrate: 96000,
              CodingMode: "CODING_MODE_2_0",
              CodecProfile: "LC",
              RateControlMode: "CBR",
              SampleRate: 48000
            } }
          }]
        }]
      },
      {
        Name: "Thumbnail",
        OutputGroupSettings: { Type: "FILE_GROUP_SETTINGS", FileGroupSettings: { Destination: destination } },
        Outputs: [{
          NameModifier: "-thumbnail",
          ContainerSettings: { Container: "RAW" },
          VideoDescription: { CodecSettings: { Codec: "FRAME_CAPTURE", FrameCaptureSettings: {
            FramerateNumerator: 1,
            FramerateDenominator: 1,
            MaxCaptures: 1,
            Quality: 80
          } } }
        }]
      }
    ],
    Inputs: [{
      FileInput: input,
      AudioSelectors: { "Default Audio": { DefaultSelection: "DEFAULT" } },
      VideoSelector: {},
      TimecodeSource: "ZEROBASED"
    }],
    TimecodeConfig: { Source: "ZEROBASED" }
  };
}

function needsDiscordTranscode(item) {
  return item.contentType.startsWith("video/") && item.expectedSize > discordVideoLimit;
}

function processingResponse(item, token) {
  return json(202, { processing: true, shareUrl: shareUrl(token), expiresAt: item.expiresAt });
}

async function startDiscordTranscode(item, token) {
  const result = await mediaConvert.send(new CreateJobCommand({
    ClientRequestToken: token,
    Role: mediaConvertRoleArn,
    Settings: discordTranscodeSettings(
      `s3://${bucketName}/${item.s3Key}`,
      `s3://${bucketName}/discord/${token}`
    ),
    StatusUpdateInterval: "SECONDS_10",
    UserMetadata: { token }
  }));
  await ddb.send(new TransactWriteCommand({
    TransactItems: [
      { Update: {
        TableName: tableName,
        Key: { token },
        UpdateExpression: "SET #status = :processing, mediaConvertJobId = :jobId",
        ConditionExpression: "#status = :pending",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":processing": "processing", ":pending": "pending", ":jobId": result.Job.Id }
      } },
      { Update: {
        TableName: tableName,
        Key: { token: statsKey },
        UpdateExpression: "ADD uploadedBytes :bytes",
        ExpressionAttributeValues: { ":bytes": item.expectedSize }
      } },
      { Update: {
        TableName: tableName,
        Key: { token: dailyStatsKey() },
        UpdateExpression: "ADD uploadedBytes :bytes",
        ExpressionAttributeValues: { ":bytes": item.expectedSize }
      } }
    ]
  }));
}

async function finishDiscordTranscode(item, token) {
  if (!item.mediaConvertJobId) return processingResponse(item, token);
  const result = await mediaConvert.send(new GetJobCommand({ Id: item.mediaConvertJobId }));
  if (["SUBMITTED", "PROGRESSING"].includes(result.Job.Status)) return processingResponse(item, token);
  if (result.Job.Status !== "COMPLETE") {
    throw new Error(`video processing ${result.Job.Status?.toLowerCase() || "failed"}`);
  }

  const discordS3Key = `discord/${token}-discord.mp4`;
  const thumbnailS3Key = `discord/${token}-thumbnail.0000000.jpg`;
  const head = await s3.send(new HeadObjectCommand({ Bucket: bucketName, Key: discordS3Key }));
  await s3.send(new HeadObjectCommand({ Bucket: bucketName, Key: thumbnailS3Key }));

  await ddb.send(new UpdateCommand({
    TableName: tableName,
    Key: { token },
    UpdateExpression: "SET #status = :ready, completedAt = :completedAt, discordS3Key = :discordS3Key, discordSize = :discordSize, thumbnailS3Key = :thumbnailS3Key",
    ConditionExpression: "#status = :processing AND mediaConvertJobId = :jobId",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: {
      ":ready": "ready",
      ":processing": "processing",
      ":completedAt": nowSeconds(),
      ":discordS3Key": discordS3Key,
      ":discordSize": head.ContentLength,
      ":thumbnailS3Key": thumbnailS3Key,
      ":jobId": item.mediaConvertJobId
    }
  }));
  return json(200, { shareUrl: shareUrl(token), expiresAt: item.expiresAt });
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
  if (item.status === "ready") return json(200, { shareUrl: shareUrl(token), expiresAt: item.expiresAt });
  if (item.status === "processing") return await finishDiscordTranscode(item, token);
  if (item.status !== "pending") return text(409, "share is not ready to complete");

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

  if (needsDiscordTranscode(item)) {
    await startDiscordTranscode(item, token);
    return processingResponse(item, token);
  }

  await ddb.send(new TransactWriteCommand({
    TransactItems: [
      { Update: {
        TableName: tableName,
        Key: { token },
        UpdateExpression: "SET #status = :ready, completedAt = :completedAt",
        ConditionExpression: "#status = :pending",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":ready": "ready", ":pending": "pending", ":completedAt": nowSeconds() }
      } },
      { Update: {
        TableName: tableName,
        Key: { token: statsKey },
        UpdateExpression: "ADD uploadedBytes :bytes",
        ExpressionAttributeValues: { ":bytes": item.expectedSize }
      } },
      { Update: {
        TableName: tableName,
        Key: { token: dailyStatsKey() },
        UpdateExpression: "ADD uploadedBytes :bytes",
        ExpressionAttributeValues: { ":bytes": item.expectedSize }
      } }
    ]
  }));

  return json(200, { shareUrl: shareUrl(token), expiresAt: item.expiresAt });
}

async function resolveShare(event) {
  const token = tokenFrom(event);
  const item = await getShare(token);
  if (!item || item.status !== "ready") return text(404, "share not found");

  const remainingSeconds = item.expiresAt - nowSeconds();
  if (remainingSeconds <= 0) return text(410, "share expired");

  const isMedia = item.contentType.startsWith("image/") || item.contentType.startsWith("video/");
  const thumbnail = event.queryStringParameters?.thumbnail === "1";
  const discord = event.queryStringParameters?.discord === "1";
  const raw = event.queryStringParameters?.raw === "1" || thumbnail || discord;
  const s3Key = thumbnail ? item.thumbnailS3Key : discord ? item.discordS3Key : item.s3Key;
  if (!s3Key) return text(404, "file not found");

  let head;
  try {
    head = await s3.send(new HeadObjectCommand({ Bucket: bucketName, Key: s3Key }));
  } catch {
    return text(404, "file not found");
  }
  if (isMedia && !raw) return mediaPreview(item, token);

  const responseContentType = thumbnail ? "image/jpeg" : discord ? "video/mp4" : item.contentType;
  const responseFilename = thumbnail ? `${item.filename}.jpg` : item.filename;

  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: bucketName,
      Key: s3Key,
      ResponseContentDisposition: `${event.queryStringParameters?.download === "1" || !isMedia ? "attachment" : "inline"}; filename="${downloadFilename(responseFilename)}"`,
      ResponseContentType: responseContentType
    }),
    { expiresIn: Math.max(1, Math.min(60, remainingSeconds)) }
  );

  await ddb.send(new TransactWriteCommand({
    TransactItems: [
      ...(!thumbnail ? [{ Update: {
        TableName: tableName,
        Key: { token },
        UpdateExpression: "ADD downloadCount :one",
        ExpressionAttributeValues: { ":one": 1 }
      } }] : []),
      { Update: {
        TableName: tableName,
        Key: { token: statsKey },
        UpdateExpression: "ADD downloadedBytes :bytes",
        ExpressionAttributeValues: { ":bytes": head.ContentLength }
      } },
      { Update: {
        TableName: tableName,
        Key: { token: dailyStatsKey() },
        UpdateExpression: "ADD downloadedBytes :bytes",
        ExpressionAttributeValues: { ":bytes": head.ContentLength }
      } }
    ]
  }));

  return {
    statusCode: 302,
    headers: {
      location: url,
      "cache-control": "no-store"
    },
    body: ""
  };
}

async function deleteShareObjects(item) {
  if (item.mediaConvertJobId && item.status === "processing") {
    await mediaConvert.send(new CancelJobCommand({ Id: item.mediaConvertJobId })).catch(() => {});
  }
  const processingOutputs = item.status === "processing"
    ? [`discord/${item.token}-discord.mp4`, `discord/${item.token}-thumbnail.0000000.jpg`]
    : [];
  await Promise.all([item.s3Key, item.discordS3Key, item.thumbnailS3Key, ...processingOutputs]
    .filter(Boolean)
    .map((Key) => s3.send(new DeleteObjectCommand({ Bucket: bucketName, Key }))));
}

async function cancelShare(event) {
  if (!mutationAuthorized(event)) return text(401, "unauthorized");

  const token = tokenFrom(event);
  const item = await getShare(token);
  if (!item) return text(404, "share not found");

  await deleteShareObjects(item);
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
      ProjectionExpression: "#token, filename, contentType, expectedSize, discordSize, #status, createdAt, expiresAt, downloadCount, uploadedBytes, downloadedBytes",
      ExpressionAttributeNames: { "#token": "token", "#status": "status" }
    }));
    shares.push(...(result.Items ?? []));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  const now = nowSeconds();
  const activeShares = shares
    .filter((item) => item.expiresAt > now)
    .sort((left, right) => left.expiresAt - right.expiresAt)
    .map((item) => ({ ...item, downloadCount: item.downloadCount ?? 0, shareUrl: shareUrl(item.token) }));
  return json(200, {
    shares: activeShares,
    stats: {
      storedBytes: activeShares.reduce((total, item) => total + item.expectedSize + (item.discordSize ?? 0), 0),
      traffic: trafficPeriods(shares)
    }
  });
}

async function extendAdminShare(event) {
  if (!adminAuthorized(event)) return text(401, "unauthorized");

  const token = tokenFrom(event);
  try {
    const result = await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { token },
      UpdateExpression: "ADD expiresAt :oneDay",
      ConditionExpression: "attribute_exists(#token) AND expiresAt > :now",
      ExpressionAttributeNames: { "#token": "token" },
      ExpressionAttributeValues: { ":oneDay": 24 * 60 * 60, ":now": nowSeconds() },
      ReturnValues: "ALL_NEW"
    }));
    return json(200, { expiresAt: result.Attributes.expiresAt });
  } catch (error) {
    if (error.name === "ConditionalCheckFailedException") return text(404, "active share not found");
    throw error;
  }
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
      await deleteShareObjects(item);
      await ddb.send(new DeleteCommand({ TableName: tableName, Key: { token: item.token } }));
      deleted += 1;
    } catch (error) {
      console.error("cleanup failed", { tokenPrefix: item.token.slice(0, 6), error });
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
    if (method === "PATCH" && path.startsWith("/admin/shares/")) return await extendAdminShare(event);
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
