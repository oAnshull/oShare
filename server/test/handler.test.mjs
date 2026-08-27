import test from "node:test";
import assert from "node:assert/strict";

process.env.UPLOAD_SECRET = "test-upload-secret";
process.env.ADMIN_PASSWORD = "test-admin-password";
process.env.PUBLIC_BASE_URL = "https://share.example.com";

const { discordTranscodeSettings, handler, mediaPreview, trafficPeriods } = await import("../src/handler.mjs");

function event(method, path, body, headers = {}) {
  return { httpMethod: method, path, body: body && JSON.stringify(body), headers };
}

test("handler rejects unauthenticated mutations", async () => {
  const response = await handler(event("POST", "/shares", {}));
  assert.equal(response.statusCode, 401);
});

test("handler validates an authenticated create request before AWS calls", async () => {
  const response = await handler(event("POST", "/shares", { expiresInSeconds: 42 }, {
    authorization: "Bearer test-upload-secret"
  }));
  assert.equal(response.statusCode, 400);
  assert.match(JSON.parse(response.body).error, /filename/);
});

test("admin login issues a hardened session cookie", async () => {
  const response = await handler(event("POST", "/admin/login", { password: "test-admin-password" }));
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["set-cookie"], /HttpOnly; Secure; SameSite=Strict/);
});

test("handler returns 404 for unknown routes", async () => {
  const response = await handler(event("GET", "/missing"));
  assert.equal(response.statusCode, 404);
});

test("handler protects the admin extension route", async () => {
  const response = await handler(event("PATCH", "/admin/shares/example", {}));
  assert.equal(response.statusCode, 401);
});

test("media previews expose inline media and Open Graph metadata", () => {
  const image = mediaPreview({ filename: "photo & view.jpg", contentType: "image/jpeg" }, "image-token");
  assert.equal(image.statusCode, 200);
  assert.match(image.body, /property="og:image" content="https:\/\/share\.example\.com\/s\/image-token\?raw=1"/);
  assert.match(image.body, /<img src="https:\/\/share\.example\.com\/s\/image-token\?raw=1"/);
  assert.match(image.body, /photo &amp; view\.jpg/);

  const video = mediaPreview({ filename: "clip.mp4", contentType: "video/mp4" }, "video-token");
  assert.match(video.body, /property="og:url" content="https:\/\/share\.example\.com\/s\/video-token"/);
  assert.match(video.body, /property="og:site_name" content="oShare"/);
  assert.match(video.body, /property="og:image" content="https:\/\/share\.example\.com\/admin\/logo\.png"/);
  assert.match(video.body, /property="og:video:url" content="https:\/\/share\.example\.com\/s\/video-token\?raw=1"/);
  assert.match(video.body, /property="og:video:width" content="1280"/);
  assert.match(video.body, /property="og:video:height" content="720"/);
  assert.match(video.body, /<video .* controls playsinline/);

  const processed = mediaPreview({
    filename: "large.mp4",
    contentType: "video/mp4",
    discordS3Key: "discord/video.mp4",
    thumbnailS3Key: "discord/video.jpg"
  }, "processed-token");
  assert.match(processed.body, /og:image" content="https:\/\/share\.example\.com\/s\/processed-token\?raw=1&amp;thumbnail=1/);
  assert.match(processed.body, /og:video:url" content="https:\/\/share\.example\.com\/s\/processed-token\?raw=1&amp;discord=1/);
});

test("large-video processing creates a bounded MP4 and thumbnail", () => {
  const settings = discordTranscodeSettings("s3://bucket/input", "s3://bucket/output");
  const video = settings.OutputGroups[0].Outputs[0];
  const thumbnail = settings.OutputGroups[1].Outputs[0];
  assert.equal(video.VideoDescription.Width, 1280);
  assert.equal(video.VideoDescription.Height, 720);
  assert.equal(video.VideoDescription.CodecSettings.H264Settings.Bitrate, 3200000);
  assert.equal(video.ContainerSettings.Mp4Settings.MoovPlacement, "PROGRESSIVE_DOWNLOAD");
  assert.equal(thumbnail.VideoDescription.CodecSettings.Codec, "FRAME_CAPTURE");
});

test("network traffic is grouped into UTC calendar timeframes", () => {
  const periods = trafficPeriods([
    { token: "__STATS__", uploadedBytes: 100, downloadedBytes: 80 },
    { token: "__STATS__:2026-08-01", uploadedBytes: 10, downloadedBytes: 5 },
    { token: "__STATS__:2026-08-17", uploadedBytes: 20, downloadedBytes: 15 },
    { token: "__STATS__:2026-08-19", uploadedBytes: 30, downloadedBytes: 25 }
  ], Date.UTC(2026, 7, 19, 12) / 1000);
  assert.deepEqual(periods.today, { uploadedBytes: 30, downloadedBytes: 25 });
  assert.deepEqual(periods.week, { uploadedBytes: 50, downloadedBytes: 40 });
  assert.deepEqual(periods.month, { uploadedBytes: 60, downloadedBytes: 45 });
  assert.deepEqual(periods.all, { uploadedBytes: 100, downloadedBytes: 80 });
});
