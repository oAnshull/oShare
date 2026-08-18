package app.oshare.client;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import android.util.Log;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private static final String BASE_URL = BuildConfig.SERVICE_URL;
    private static final String ADMIN_URL = BASE_URL + "/admin";
    private static final String SERVICE_HOST = Uri.parse(BASE_URL).getHost();
    private static final long MAX_BYTES = 5L * 1024 * 1024 * 1024;
    private static final int PICK_FILE = 41;
    private static final int[] EXPIRY_SECONDS = {3600, 21600, 86400, 259200, 604800};
    private static final String[] EXPIRY_LABELS = {"1 hour", "6 hours", "1 day", "3 days", "7 days"};

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private WebView webView;
    private Uri sharedFile;
    private ValueCallback<Uri[]> chooserCallback;
    private int pendingExpirySeconds;
    private volatile boolean uploadStarted;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        readSharedFile(getIntent());

        webView = new WebView(this);
        webView.setBackgroundColor(0xff080b12);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowContentAccess(true);
        settings.setSupportMultipleWindows(false);
        settings.setUserAgentString(settings.getUserAgentString() + " TemporaryShareAndroid/1.0");
        webView.addJavascriptInterface(new AndroidBridge(), "oShareAndroid");
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (SERVICE_HOST != null && SERVICE_HOST.equalsIgnoreCase(uri.getHost())) return false;
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
                return true;
            }

            @Override public void onPageFinished(WebView view, String url) {
                Uri uri = Uri.parse(url);
                if (SERVICE_HOST != null && SERVICE_HOST.equalsIgnoreCase(uri.getHost())) {
                    view.evaluateJavascript("navigator.clipboard={writeText:(text)=>{oShareAndroid.copy(text);return Promise.resolve();}}", null);
                    armAutomaticUpload();
                }
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (chooserCallback != null) chooserCallback.onReceiveValue(null);
                chooserCallback = callback;
                Intent picker = params.createIntent();
                try {
                    startActivityForResult(picker, PICK_FILE);
                } catch (Exception error) {
                    chooserCallback = null;
                    callback.onReceiveValue(null);
                    Toast.makeText(MainActivity.this, "No file picker is available", Toast.LENGTH_SHORT).show();
                }
                return true;
            }
        });
        setContentView(webView);
        webView.loadUrl(ADMIN_URL);
        if (sharedFile != null) showExpiryDialog();
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        readSharedFile(intent);
        uploadStarted = false;
        pendingExpirySeconds = 0;
        webView.loadUrl(ADMIN_URL);
        if (sharedFile != null) showExpiryDialog();
    }

    private void readSharedFile(Intent intent) {
        if (!Intent.ACTION_SEND.equals(intent.getAction())) return;
        sharedFile = Build.VERSION.SDK_INT >= 33
            ? intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class)
            : intent.getParcelableExtra(Intent.EXTRA_STREAM);
    }

    private void showExpiryDialog() {
        final int[] selected = {2};
        new AlertDialog.Builder(this)
            .setTitle("Keep this file available for")
            .setSingleChoiceItems(EXPIRY_LABELS, selected[0], (dialog, which) -> selected[0] = which)
            .setNegativeButton("Cancel", (dialog, which) -> finish())
            .setPositiveButton("Upload", (dialog, which) -> {
                pendingExpirySeconds = EXPIRY_SECONDS[selected[0]];
                Toast.makeText(this, "Preparing upload…", Toast.LENGTH_SHORT).show();
                armAutomaticUpload();
            })
            .setOnCancelListener(dialog -> finish())
            .show();
    }

    private void armAutomaticUpload() {
        if (sharedFile == null || pendingExpirySeconds <= 0 || uploadStarted) return;
        webView.evaluateJavascript("(function(){clearInterval(window.__oshareAndroidWait);window.__oshareAndroidWait=setInterval(function(){const d=document.getElementById('dashboard');if(d&&!d.classList.contains('hidden')){clearInterval(window.__oshareAndroidWait);oShareAndroid.startUpload()}},400)})()", null);
    }

    private void uploadSharedFile() {
        if (uploadStarted || sharedFile == null || pendingExpirySeconds <= 0) return;
        uploadStarted = true;
        Uri uri = sharedFile;
        executor.execute(() -> {
            String token = null;
            try {
                FileInfo file = readFileInfo(uri);
                if (file.size <= 0) throw new Exception("Could not determine the file size.");
                if (file.size > MAX_BYTES) throw new Exception("Files must be 5 GB or smaller.");
                showPreparing(file);
                JSONObject request = new JSONObject()
                    .put("filename", file.name)
                    .put("size", file.size)
                    .put("contentType", file.type)
                    .put("expiresInSeconds", pendingExpirySeconds);
                JSONObject created = api("POST", "/shares", request);
                token = created.getString("token");
                upload(uri, file, created.getString("uploadUrl"));
                JSONObject complete = api("POST", "/shares/" + token + "/complete", new JSONObject());
                String link = complete.getString("shareUrl");
                copy(link);
                showComplete(link);
                sharedFile = null;
            } catch (Exception error) {
                Log.e("oShare", "Shared-file upload failed", error);
                if (token != null) {
                    try { api("DELETE", "/shares/" + token, null); } catch (Exception ignored) { }
                }
                String message = error.getMessage() == null ? "Upload failed." : error.getMessage();
                showError(message);
                uploadStarted = false;
            }
        });
    }

    private FileInfo readFileInfo(Uri uri) throws Exception {
        String name = "shared-file";
        long size = -1;
        try (Cursor cursor = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                int sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE);
                if (nameIndex >= 0 && !cursor.isNull(nameIndex)) name = cursor.getString(nameIndex);
                if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) size = cursor.getLong(sizeIndex);
            }
        }
        if (size <= 0) {
            try (ParcelFileDescriptor descriptor = getContentResolver().openFileDescriptor(uri, "r")) {
                if (descriptor != null) size = descriptor.getStatSize();
            }
        }
        String type = getContentResolver().getType(uri);
        if (type == null || type.isBlank()) type = "application/octet-stream";
        return new FileInfo(name, type, size);
    }

    private void upload(Uri uri, FileInfo file, String uploadUrl) throws Exception {
        HttpURLConnection connection = (HttpURLConnection)new URL(uploadUrl).openConnection();
        connection.setRequestMethod("PUT");
        connection.setRequestProperty("Content-Type", file.type);
        connection.setDoOutput(true);
        connection.setConnectTimeout(30000);
        connection.setReadTimeout(300000);
        connection.setFixedLengthStreamingMode(file.size);
        long started = System.nanoTime();
        long sent = 0;
        long lastUpdate = 0;
        byte[] buffer = new byte[1024 * 1024];
        try (InputStream input = new BufferedInputStream(getContentResolver().openInputStream(uri), buffer.length);
             OutputStream output = new BufferedOutputStream(connection.getOutputStream(), buffer.length)) {
            if (input == null) throw new Exception("Could not open the shared file.");
            int read;
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
                sent += read;
                long now = System.nanoTime();
                if (now - lastUpdate >= 250_000_000L || sent == file.size) {
                    showProgress(file, sent, (now - started) / 1_000_000_000.0);
                    lastUpdate = now;
                }
            }
        }
        int code = connection.getResponseCode();
        connection.disconnect();
        if (code < 200 || code >= 300) throw new Exception("Storage returned HTTP " + code + ".");
    }

    private JSONObject api(String method, String path, JSONObject body) throws Exception {
        HttpURLConnection connection = (HttpURLConnection)new URL(BASE_URL + path).openConnection();
        connection.setRequestMethod(method);
        String cookie = CookieManager.getInstance().getCookie(BASE_URL);
        if (cookie != null) connection.setRequestProperty("Cookie", cookie);
        connection.setRequestProperty("Accept", "application/json");
        connection.setConnectTimeout(30000);
        connection.setReadTimeout(30000);
        if (body != null) {
            byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setDoOutput(true);
            connection.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream output = connection.getOutputStream()) { output.write(bytes); }
        }
        int code = connection.getResponseCode();
        InputStream stream = code >= 200 && code < 300 ? connection.getInputStream() : connection.getErrorStream();
        String response = stream == null ? "" : readAll(stream);
        connection.disconnect();
        if (code < 200 || code >= 300) throw new Exception(code == 401 ? "Admin session expired. Sign in and share the file again." : response);
        return response.isBlank() ? new JSONObject() : new JSONObject(response);
    }

    private static String readAll(InputStream input) throws Exception {
        try (input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
            return output.toString(StandardCharsets.UTF_8);
        }
    }

    private void showPreparing(FileInfo file) {
        runJs("document.getElementById('selectedFile').textContent=" + JSONObject.quote(file.name + " · " + formatBytes(file.size)) + ";document.getElementById('progress').classList.remove('hidden');document.querySelector('#progress>div').style.width='0%';document.getElementById('uploadButton').disabled=true");
    }

    private void showProgress(FileInfo file, long sent, double seconds) {
        double speed = seconds > 0 ? sent / seconds : 0;
        double eta = speed > 0 ? (file.size - sent) / speed : Double.NaN;
        int percent = (int)Math.min(100, sent * 100.0 / file.size);
        String detail = file.name + " · " + percent + "% · " + formatBytes((long)speed) + "/s · ETA " + formatDuration(eta);
        runJs("document.getElementById('selectedFile').textContent=" + JSONObject.quote(detail) + ";document.querySelector('#progress>div').style.width='" + percent + "%'");
    }

    private void showComplete(String link) {
        runJs("document.getElementById('progress').classList.add('hidden');document.getElementById('selectedFile').textContent='Upload complete — link copied';showToast('Share link copied to clipboard');loadShares()");
    }

    private void showError(String message) {
        runJs("document.getElementById('progress').classList.add('hidden');document.getElementById('selectedFile').textContent='Upload failed';showToast(" + JSONObject.quote(message) + ",true)");
    }

    private void runJs(String script) { runOnUiThread(() -> webView.evaluateJavascript(script, null)); }

    private void copy(String text) {
        runOnUiThread(() -> {
            ClipboardManager clipboard = (ClipboardManager)getSystemService(Context.CLIPBOARD_SERVICE);
            clipboard.setPrimaryClip(ClipData.newPlainText(getString(R.string.app_name) + " link", text));
        });
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != PICK_FILE || chooserCallback == null) return;
        Uri[] result = resultCode == RESULT_OK && data != null && data.getData() != null ? new Uri[]{data.getData()} : null;
        chooserCallback.onReceiveValue(result);
        chooserCallback = null;
    }

    @Override public void onBackPressed() {
        if (webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override protected void onDestroy() {
        if (chooserCallback != null) chooserCallback.onReceiveValue(null);
        executor.shutdownNow();
        webView.destroy();
        super.onDestroy();
    }

    private final class AndroidBridge {
        @JavascriptInterface public void copy(String text) { MainActivity.this.copy(text); }
        @JavascriptInterface public void startUpload() { MainActivity.this.uploadSharedFile(); }
    }

    private static String formatBytes(long bytes) {
        String[] units = {"B", "KB", "MB", "GB", "TB"};
        double value = Math.max(0, bytes);
        int unit = 0;
        while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
        return unit == 0 ? String.format(Locale.US, "%.0f %s", value, units[unit]) : String.format(Locale.US, "%.1f %s", value, units[unit]);
    }

    private static String formatDuration(double seconds) {
        if (!Double.isFinite(seconds) || seconds < 0) return "--";
        long whole = (long)Math.ceil(seconds);
        if (whole >= 3600) return (whole / 3600) + "h " + ((whole % 3600) / 60) + "m";
        if (whole >= 60) return (whole / 60) + "m " + (whole % 60) + "s";
        return whole + "s";
    }

    private static final class FileInfo {
        final String name;
        final String type;
        final long size;
        FileInfo(String name, String type, long size) { this.name = name; this.type = type; this.size = size; }
    }
}
