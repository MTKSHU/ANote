package cn.anote.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.print.PrintManager;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebStorage;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.PopupMenu;
import android.widget.TextView;
import android.widget.Toast;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONTokener;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;

/** A network-only client. The renderer and all account permissions stay on the selected server. */
public final class MainActivity extends Activity {
    private static final int PICK_FILE = 10;
    private static final int SAVE_FILE = 11;
    private final ExecutorService transfers = Executors.newSingleThreadExecutor();
    private final Set<String> authenticationOrigins = new HashSet<>();
    private LinearLayout root;
    private FrameLayout content;
    private TextView originLabel;
    private TextView errorBanner;
    private WebView web;
    private String serverOrigin;
    private boolean authenticationFlow;
    private ValueCallback<Uri[]> fileCallback;
    private String pendingDownload;
    private String pendingMarkdown;
    private String pendingMarkdownOrigin;
    private String pendingMime;
    private ZipExport pendingZip, activeZip;
    private static final class ZipExport {
        String url, origin, name; int length, offset; Uri destination; volatile OutputStream output; volatile boolean closed;
    }
    private View fullscreenView;
    private WebChromeClient.CustomViewCallback fullscreenCallback;

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.rgb(248, 250, 252));
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            } else {
                view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            }
            return insets;
        });
        setContentView(root);
        String savedServer = getPreferences(MODE_PRIVATE).getString("server", "");
        if (savedServer.isEmpty()) showServerPicker();
        else {
            try { connect(OriginPolicy.server(savedServer, BuildConfig.DEBUG, BuildConfig.PREVIEW_ORIGIN)); }
            catch (IllegalArgumentException error) { showServerPicker(); }
        }
    }

    private int dp(int size) { return Math.round(size * getResources().getDisplayMetrics().density); }
    private Button button(String text) {
        Button result = new Button(this);
        result.setText(text);
        result.setAllCaps(false);
        result.setMinWidth(0);
        result.setMinimumWidth(0);
        result.setTextSize(14);
        return result;
    }
    private void showServerPicker() {
        if (web != null) { web.stopLoading(); web.destroy(); web = null; }
        root.removeAllViews();
        serverOrigin = null;
        authenticationFlow = false;
        authenticationOrigins.clear();
        LinearLayout form = new LinearLayout(this);
        form.setOrientation(LinearLayout.VERTICAL);
        form.setGravity(Gravity.CENTER_VERTICAL);
        form.setPadding(dp(24), dp(24), dp(24), dp(24));
        TextView title = new TextView(this);
        title.setText(BuildConfig.DEBUG ? "ANote · " + BuildConfig.VERSION_NAME + " 预览" : "ANote");
        title.setTextSize(27);
        title.setTextColor(Color.rgb(31, 41, 55));
        form.addView(title);
        TextView description = new TextView(this);
        description.setText("连接你的 ANote 服务器。登录、笔记与附件只发送到你选择的服务器。");
        description.setTextSize(16);
        description.setPadding(0, dp(18), 0, dp(24));
        form.addView(description);
        EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setHint("https://你的服务器");
        input.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI);
        input.setText(getPreferences(MODE_PRIVATE).getString("server", BuildConfig.PREVIEW_ORIGIN));
        input.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        form.addView(input);
        TextView errorText = new TextView(this);
        errorText.setTextColor(Color.rgb(185, 28, 28));
        form.addView(errorText);
        Button connect = button("连接服务器");
        connect.setOnClickListener(view -> {
            try {
                String origin = OriginPolicy.server(input.getText().toString(), BuildConfig.DEBUG, BuildConfig.PREVIEW_ORIGIN);
                getPreferences(MODE_PRIVATE).edit().putString("server", origin).apply();
                connect(origin);
            } catch (IllegalArgumentException error) { errorText.setText(error.getMessage()); }
        });
        form.addView(connect);
        if (BuildConfig.DEBUG) {
            TextView warning = new TextView(this);
            warning.setText("此为内部预览客户端；HTTP 测试连接不加密，请只使用隔离测试账号。首次打开不会自动连接。");
            warning.setPadding(0, dp(18), 0, 0);
            form.addView(warning);
        }
        root.addView(form, new LinearLayout.LayoutParams(-1, -1));
    }

    private void connect(String origin) {
        serverOrigin = origin;
        root.removeAllViews();
        LinearLayout toolbar = new LinearLayout(this);
        toolbar.setGravity(Gravity.CENTER_VERTICAL);
        Button back = button("‹");
        back.setContentDescription("返回");
        back.setOnClickListener(view -> navigateBack());
        toolbar.addView(back, new LinearLayout.LayoutParams(dp(44), dp(44)));
        originLabel = new TextView(this);
        originLabel.setGravity(Gravity.CENTER_VERTICAL);
        originLabel.setSingleLine(true);
        originLabel.setEllipsize(android.text.TextUtils.TruncateAt.MIDDLE);
        originLabel.setText(origin);
        originLabel.setTextSize(12);
        toolbar.addView(originLabel, new LinearLayout.LayoutParams(0, dp(44), 1));
        Button menuButton = button("⋮");
        menuButton.setContentDescription("客户端菜单");
        menuButton.setOnClickListener(this::openMenu);
        toolbar.addView(menuButton, new LinearLayout.LayoutParams(dp(44), dp(44)));
        root.addView(toolbar);
        errorBanner = new TextView(this);
        errorBanner.setTextColor(Color.rgb(185, 28, 28));
        errorBanner.setPadding(dp(12), dp(8), dp(12), dp(8));
        errorBanner.setVisibility(View.GONE);
        errorBanner.setOnClickListener(view -> { if (web != null) web.reload(); });
        root.addView(errorBanner);
        content = new FrameLayout(this);
        root.addView(content, new LinearLayout.LayoutParams(-1, 0, 1));
        web = new WebView(this);
        content.addView(web, new FrameLayout.LayoutParams(-1, -1));
        WebView.setWebContentsDebuggingEnabled(false);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true); // SAF uploads; content:// navigation is blocked below.
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSafeBrowsingEnabled(true);
        settings.setGeolocationEnabled(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setBuiltInZoomControls(false);
        settings.setUserAgentString(settings.getUserAgentString() + " ANoteMobile/" + BuildConfig.VERSION_NAME);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!request.isForMainFrame()) return false;
                return navigate(request.getUrl().toString());
            }
            @Override public void onPageCommitVisible(WebView view, String url) {
                if (OriginPolicy.sameOrigin(url, serverOrigin)) view.evaluateJavascript("window.__anoteNativeExportVersion=2", null);
            }
            @Override public void onPageFinished(WebView view, String url) {
                if (OriginPolicy.sameOrigin(url, serverOrigin)) view.evaluateJavascript("window.__anoteNativeExportVersion=2", null);
            }
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                originLabel.setText(OriginPolicy.origin(url));
                errorBanner.setVisibility(View.GONE);
                if (OriginPolicy.isAuthenticationStart(url, serverOrigin)) authenticationFlow = true;
                if (OriginPolicy.sameOrigin(url, serverOrigin) && (url.contains("auth_success=") || url.contains("auth_error="))) {
                    authenticationFlow = false;
                    authenticationOrigins.clear();
                }
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showError("无法连接服务器。检查网络后轻触此处重试，或在客户端菜单切换服务器。");
            }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel();
                showError("服务器 HTTPS 证书无效，连接已取消。请检查服务器证书。");
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                if (!OriginPolicy.sameOrigin(view.getUrl(), serverOrigin)) { callback.onReceiveValue(null); return true; }
                fileCallback = callback;
                Intent intent = params.createIntent();
                intent.setAction(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try { startActivityForResult(intent, PICK_FILE); }
                catch (ActivityNotFoundException error) { callback.onReceiveValue(null); fileCallback = null; showError("系统文件选择器不可用"); }
                return true;
            }
            @Override public void onPermissionRequest(PermissionRequest request) { request.deny(); }
            @Override public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) { callback.invoke(origin, false, false); }
            @Override public void onShowCustomView(View view, CustomViewCallback callback) {
                if (fullscreenView != null) { callback.onCustomViewHidden(); return; }
                fullscreenView = view;
                fullscreenCallback = callback;
                content.addView(view, new FrameLayout.LayoutParams(-1, -1));
                web.setVisibility(View.GONE);
            }
            @Override public void onHideCustomView() { exitFullscreen(); }
        });
        web.setDownloadListener((url, userAgent, disposition, mime, length) -> {
            if (pendingDownload != null || pendingMarkdown != null || pendingZip != null || activeZip != null) { showError("请先完成当前文件保存"); return; }
            if (OriginPolicy.sameBlobOrigin(url, serverOrigin) && OriginPolicy.sameOrigin(web.getUrl(), serverOrigin)) {
                prepareMarkdown(url); return;
            }
            if (!OriginPolicy.sameOrigin(url, serverOrigin)) {
                showError(url.startsWith("blob:") ? "此导出由网页在内存中生成。可使用客户端菜单中的“打印 / 保存 PDF”，或在系统浏览器导出。" : "只允许下载当前 ANote 服务器上的附件");
                return;
            }
            pendingDownload = url;
            pendingMime = mime == null || mime.isEmpty() ? "application/octet-stream" : mime;
            Intent save = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            save.addCategory(Intent.CATEGORY_OPENABLE);
            save.setType(pendingMime);
            save.putExtra(Intent.EXTRA_TITLE, OriginPolicy.safeFilename(URLUtil.guessFileName(url, disposition, pendingMime)));
            try { startActivityForResult(save, SAVE_FILE); }
            catch (ActivityNotFoundException error) { pendingDownload = null; showError("系统保存对话框不可用"); }
        });
        // Cookies are keyed by host, not port. Erase the old web account before
        // changing origins, including when two test servers share one hostname.
        String previousCookieOrigin = getPreferences(MODE_PRIVATE).getString("cookie-origin", "");
        if (!origin.equals(previousCookieOrigin)) {
            CookieManager.getInstance().removeAllCookies(ignored -> {
                WebStorage.getInstance().deleteAllData();
                CookieManager.getInstance().flush();
                getPreferences(MODE_PRIVATE).edit().putString("cookie-origin", origin).apply();
                if (web != null && origin.equals(serverOrigin)) web.loadUrl(origin + "/");
            });
        } else web.loadUrl(origin + "/");
    }
    private void prepareMarkdown(String url) {
        final String expectedOrigin = serverOrigin;
        String script = "(()=>{const v=window.__anoteMarkdownExport;if(!v||v.url!==" + JSONObject.quote(url) + "||typeof v.content!=='string'&&typeof v.readChunk!=='function')return null;const binary=typeof v.readChunk==='function'&&v.mime==='application/zip';return JSON.stringify({filename:v.filename,length:binary?v.length:v.content.length,binary});})()";
        web.evaluateJavascript(script, result -> {
            try {
                Object encoded = new JSONTokener(result).nextValue();
                if (!(encoded instanceof String)) throw new IllegalArgumentException();
                JSONObject metadata = new JSONObject((String) encoded);
                int length = metadata.getInt("length");
                if (metadata.optBoolean("binary")) {
                    if (length < 1 || length > 128 * 1024 * 1024 || !expectedOrigin.equals(serverOrigin)) throw new IllegalArgumentException();
                    ZipExport transfer = new ZipExport(); transfer.url = url; transfer.origin = expectedOrigin; transfer.name = OriginPolicy.safeFilename(metadata.getString("filename")); transfer.length = length;
                    pendingZip = transfer;
                    Intent save = new Intent(Intent.ACTION_CREATE_DOCUMENT); save.addCategory(Intent.CATEGORY_OPENABLE); save.setType("application/zip"); save.putExtra(Intent.EXTRA_TITLE, transfer.name);
                    try { startActivityForResult(save, SAVE_FILE); } catch (ActivityNotFoundException error) { pendingZip = null; throw error; }
                    return;
                }
                if (length < 0 || length > 8 * 1024 * 1024) throw new IllegalArgumentException();
                readMarkdown(url, expectedOrigin, OriginPolicy.safeFilename(metadata.getString("filename")), length, new StringBuilder());
            } catch (Exception error) { ZipExport rejected = new ZipExport(); rejected.url = url; rejected.origin = expectedOrigin; completeExport(rejected, "failed"); showError("此文件无法在应用内保存，请重新导出或使用系统浏览器。"); }
        });
    }
    private void readMarkdown(String url, String expectedOrigin, String name, int length, StringBuilder text) {
        if (isFinishing() || isDestroyed() || web == null) return;
        if (!expectedOrigin.equals(serverOrigin) || !OriginPolicy.sameOrigin(web.getUrl(), expectedOrigin)) { showError("服务器已切换，请重新导出"); return; }
        if (text.length() == length) {
            if (text.toString().getBytes(StandardCharsets.UTF_8).length > 8 * 1024 * 1024) { showError("Markdown 过大，请使用系统浏览器导出"); return; }
            pendingMarkdown = text.toString(); pendingMarkdownOrigin = expectedOrigin;
            Intent save = new Intent(Intent.ACTION_CREATE_DOCUMENT); save.addCategory(Intent.CATEGORY_OPENABLE); save.setType("text/markdown");
            save.putExtra(Intent.EXTRA_TITLE, name.endsWith(".md") ? name : name + ".md");
            try { startActivityForResult(save, SAVE_FILE); }
            catch (ActivityNotFoundException error) { pendingMarkdown = null; pendingMarkdownOrigin = null; showError("系统保存对话框不可用"); }
            return;
        }
        int offset = text.length();
        String script = "(()=>{const v=window.__anoteMarkdownExport;if(!v||v.url!==" + JSONObject.quote(url) + ")return null;let end=Math.min(v.content.length," + (offset + 65536) + ");const c=v.content.charCodeAt(end-1);if(end<v.content.length&&c>=55296&&c<=56319)end--;return v.content.slice(" + offset + ",end);})()";
        web.evaluateJavascript(script, result -> {
            try {
                Object value = new JSONTokener(result).nextValue();
                if (!(value instanceof String)) throw new IllegalArgumentException();
                String chunk = (String) value;
                if (chunk.isEmpty() || chunk.length() > 65536 || text.length() + chunk.length() > length) throw new IllegalArgumentException();
                text.append(chunk); readMarkdown(url, expectedOrigin, name, length, text);
            } catch (Exception error) { showError("导出内容已失效，请重新导出"); }
        });
    }

    private void readZip(ZipExport transfer) {
        if (transfer.closed) return;
        if (isFinishing() || isDestroyed() || web == null || !transfer.origin.equals(serverOrigin) || !OriginPolicy.sameOrigin(web.getUrl(), transfer.origin)) { finishZip(transfer, false); return; }
        if (transfer.offset == transfer.length) { finishZip(transfer, true); return; }
        int count = Math.min(32768, transfer.length - transfer.offset);
        String script = "(()=>{const v=window.__anoteMarkdownExport;return v&&v.url===" + JSONObject.quote(transfer.url) + "&&typeof v.readChunk==='function'?v.readChunk(" + transfer.offset + "," + count + "):null;})()";
        web.evaluateJavascript(script, result -> {
            try {
                Object encoded = new JSONTokener(result).nextValue();
                if (!(encoded instanceof String)) throw new IllegalArgumentException();
                byte[] chunk = android.util.Base64.decode((String) encoded, android.util.Base64.NO_WRAP);
                if (chunk.length != count) throw new IllegalArgumentException();
                if (transfer.closed || transfers.isShutdown()) return;
                transfers.execute(() -> {
                    try { if (transfer.closed) return; transfer.output.write(chunk); transfer.offset += chunk.length; runOnUiThread(() -> readZip(transfer)); }
                    catch (Exception error) { runOnUiThread(() -> finishZip(transfer, false)); }
                });
            } catch (Exception error) { finishZip(transfer, false); }
        });
    }
    private void completeExport(ZipExport transfer, String status) {
        if (web != null && !isDestroyed() && OriginPolicy.sameOrigin(web.getUrl(), transfer.origin)) web.evaluateJavascript("(()=>{const v=window.__anoteMarkdownExport;if(v&&v.url===" + JSONObject.quote(transfer.url) + "){v.finish?.(" + JSONObject.quote(status) + ");v.dispose?.();}})()", null);
    }
    private void finishZip(ZipExport transfer, boolean success) {
        if (transfer.closed) return; transfer.closed = true;
        if (transfers.isShutdown()) return;
        transfers.execute(() -> {
            boolean saved = success;
            try { if (transfer.output != null) transfer.output.close(); } catch (Exception error) { saved = false; }
            if (!saved && transfer.destination != null) try { android.provider.DocumentsContract.deleteDocument(getContentResolver(), transfer.destination); } catch (Exception ignored) {}
            final boolean completed = saved;
            runOnUiThread(() -> { if (activeZip == transfer) activeZip = null; completeExport(transfer, completed ? "saved" : "failed"); if (!isDestroyed()) { if (completed) Toast.makeText(this, "Markdown 与附件已导出，解压后打开 .md", Toast.LENGTH_LONG).show(); else showError("附件归档保存失败，请重新导出"); } });
        });
    }
    private boolean navigate(String url) {
        if (OriginPolicy.sameBlobOrigin(url, serverOrigin) && OriginPolicy.sameOrigin(web.getUrl(), serverOrigin)) return false;
        if (OriginPolicy.sameOrigin(url, serverOrigin)) {
            if (OriginPolicy.isAuthenticationStart(url, serverOrigin)) authenticationFlow = true;
            return false;
        }
        String destination = OriginPolicy.origin(url);
        if (destination == null || !destination.startsWith("https://")) { showError("已阻止不受信任的页面地址"); return true; }
        if (authenticationFlow) {
            if (authenticationOrigins.contains(destination)) return false;
            new AlertDialog.Builder(this).setTitle("继续统一登录")
                .setMessage("ANote 正在跳转到认证服务器：\n" + destination + "\n\n确认这是你的团队认证服务后继续。")
                .setPositiveButton("继续", (dialog, which) -> { authenticationOrigins.add(destination); web.loadUrl(url); })
                .setNegativeButton("取消", (dialog, which) -> { authenticationFlow = false; web.loadUrl(serverOrigin + "/"); }).show();
            return true;
        }
        new AlertDialog.Builder(this).setTitle("在浏览器打开链接")
            .setMessage(destination).setPositiveButton("打开", (dialog, which) -> openExternal(url)).setNegativeButton("取消", null).show();
        return true;
    }
    private void openExternal(String url) {
        try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE)); }
        catch (ActivityNotFoundException error) { showError("没有可打开该链接的系统浏览器"); }
    }
    private void openMenu(View anchor) {
        PopupMenu menu = new PopupMenu(this, anchor);
        menu.getMenu().add(0, 1, 0, "刷新页面");
        menu.getMenu().add(0, 2, 1, "打印 / 保存 PDF");
        menu.getMenu().add(0, 3, 2, "在系统浏览器打开");
        menu.getMenu().add(0, 4, 3, "切换服务器");
        menu.setOnMenuItemClickListener(item -> {
            if (item.getItemId() == 1) web.reload();
            if (item.getItemId() == 2) {
                printPage();
            }
            if (item.getItemId() == 3) {
                String url = web.getUrl();
                if (OriginPolicy.sameOrigin(url, serverOrigin) && serverOrigin.startsWith("https:")) openExternal(url);
                else showError("HTTP 预览请直接在浏览器手动输入测试服务器地址");
            }
            if (item.getItemId() == 4) new AlertDialog.Builder(this).setTitle("切换服务器")
                .setMessage("请先确认当前笔记已经保存。切换到不同服务器后需要重新登录。")
                .setPositiveButton("继续", (dialog, which) -> showServerPicker()).setNegativeButton("取消", null).show();
            return true;
        });
        menu.show();
    }
    private void printPage() {
        if (web == null || !OriginPolicy.sameOrigin(web.getUrl(), serverOrigin)) {
            showError("请返回当前 ANote 服务器页面后再打印");
            return;
        }
        WebView target = web;
        // Read only a bounded title from the selected server; this is not a JS/native bridge.
        target.evaluateJavascript("(document.querySelector('input[aria-label=\"笔记标题\"]')?.value || document.title || '').slice(0,200)", raw -> {
            if (web != target || !OriginPolicy.sameOrigin(target.getUrl(), serverOrigin) || isFinishing()) return;
            String noteTitle = "";
            try {
                if (raw == null) throw new org.json.JSONException("No page title");
                Object value = new JSONTokener(raw).nextValue();
                if (value instanceof String) noteTitle = (String)value;
            } catch (org.json.JSONException ignored) { /* page title remains the safe fallback */ }
            String title = OriginPolicy.printTitle(noteTitle, target.getTitle());
            PrintManager manager = (PrintManager)getSystemService(PRINT_SERVICE);
            if (manager == null) { showError("系统打印服务不可用，请在系统浏览器导出 PDF"); return; }
            manager.print(title, target.createPrintDocumentAdapter(title), null);
        });
    }
    private void showError(String message) {
        if (errorBanner != null) { errorBanner.setText(message); errorBanner.setVisibility(View.VISIBLE); }
    }
    private void exitFullscreen() {
        if (fullscreenView == null) return;
        content.removeView(fullscreenView);
        fullscreenView = null;
        if (web != null) web.setVisibility(View.VISIBLE);
        if (fullscreenCallback != null) fullscreenCallback.onCustomViewHidden();
        fullscreenCallback = null;
    }
    private void navigateBack() {
        if (fullscreenView != null) { exitFullscreen(); return; }
        if (web != null && OriginPolicy.sameOrigin(web.getUrl(), serverOrigin)) {
            web.evaluateJavascript("(()=>{const event=new Event('anote:mobile-back',{cancelable:true});return !window.dispatchEvent(event);})()", consumed -> {
                if (!"true".equals(consumed) && !isFinishing()) navigateHistoryOrExit();
            });
            return;
        }
        navigateHistoryOrExit();
    }
    private void navigateHistoryOrExit() {
        if (web != null && web.canGoBack()) { web.goBack(); return; }
        new AlertDialog.Builder(this).setTitle("离开 ANote")
            .setMessage("请确认修改已保存。").setPositiveButton("离开", (dialog, which) -> finish()).setNegativeButton("取消", null).show();
    }
    @Override public void onBackPressed() { navigateBack(); }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == PICK_FILE && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fileCallback = null;
        }
        if (requestCode == SAVE_FILE && pendingZip != null) {
            ZipExport transfer = pendingZip; pendingZip = null;
            if (resultCode != RESULT_OK || data == null || data.getData() == null || !transfer.origin.equals(serverOrigin)) { completeExport(transfer, "canceled"); return; }
            transfer.destination = data.getData(); activeZip = transfer;
            transfers.execute(() -> {
                try { transfer.output = getContentResolver().openOutputStream(transfer.destination); if (transfer.output == null) throw new java.io.IOException("Cannot open export destination"); if (transfer.closed) { transfer.output.close(); try { android.provider.DocumentsContract.deleteDocument(getContentResolver(), transfer.destination); } catch (Exception ignored) {} return; } runOnUiThread(() -> readZip(transfer)); }
                catch (Exception error) { runOnUiThread(() -> finishZip(transfer, false)); }
            });
            return;
        }
        if (requestCode == SAVE_FILE && pendingMarkdown != null) {
            String markdown = pendingMarkdown, expectedOrigin = pendingMarkdownOrigin;
            pendingMarkdown = null; pendingMarkdownOrigin = null;
            if (resultCode != RESULT_OK || data == null || data.getData() == null || expectedOrigin == null || !expectedOrigin.equals(serverOrigin)) return;
            Uri destination = data.getData();
            transfers.execute(() -> {
                try {
                    try (OutputStream output = getContentResolver().openOutputStream(destination)) {
                        if (output == null) throw new java.io.IOException("Cannot open export destination");
                        output.write(markdown.getBytes(StandardCharsets.UTF_8));
                    }
                    runOnUiThread(() -> Toast.makeText(this, "Markdown 已导出", Toast.LENGTH_LONG).show());
                } catch (Exception error) {
                    try { android.provider.DocumentsContract.deleteDocument(getContentResolver(), destination); } catch (Exception ignored) {}
                    runOnUiThread(() -> showError("Markdown 保存失败，请重试"));
                }
            });
            return;
        }
        if (requestCode == SAVE_FILE && pendingDownload != null) {
            String url = pendingDownload;
            String expectedOrigin = serverOrigin;
            String cookies = CookieManager.getInstance().getCookie(url);
            pendingDownload = null;
            if (resultCode != RESULT_OK || data == null || data.getData() == null) return;
            Uri destination = data.getData();
            transfers.execute(() -> {
                try {
                    download(url, expectedOrigin, cookies, destination);
                    runOnUiThread(() -> Toast.makeText(this, "附件已保存", Toast.LENGTH_LONG).show());
                } catch (Exception error) {
                    // Remove a partial output rather than leave a corrupt file presented as complete.
                    try { android.provider.DocumentsContract.deleteDocument(getContentResolver(), destination); } catch (Exception ignored) {}
                    runOnUiThread(() -> showError("附件下载失败，请重试。服务器可能已断开或登录已过期。"));
                }
            });
        }
    }
    private void download(String url, String expectedOrigin, String cookies, Uri destination) throws Exception {
        for (int redirects = 0; redirects < 5; redirects++) {
            if (!OriginPolicy.sameOrigin(url, expectedOrigin)) throw new SecurityException("Cross-origin download");
            HttpURLConnection connection = (HttpURLConnection)new URL(url).openConnection();
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(30000);
            connection.setInstanceFollowRedirects(false);
            if (cookies != null) connection.setRequestProperty("Cookie", cookies);
            try {
                int status = connection.getResponseCode();
                if (status >= 300 && status < 400) {
                    String location = connection.getHeaderField("Location");
                    if (location == null) throw new java.io.IOException("Invalid redirect");
                    url = new URL(new URL(url), location).toString();
                    continue;
                }
                if (status != 200) throw new java.io.IOException("Download HTTP " + status);
                String disposition = connection.getHeaderField("Content-Disposition");
                String type = connection.getContentType();
                if (type != null && type.startsWith("text/html") && (disposition == null || !disposition.toLowerCase().contains("attachment"))) {
                    throw new java.io.IOException("Login page instead of attachment");
                }
                try (InputStream in = connection.getInputStream(); OutputStream out = getContentResolver().openOutputStream(destination, "wt")) {
                    if (out == null) throw new java.io.IOException("No output");
                    byte[] buffer = new byte[64 * 1024];
                    int read;
                    while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
                }
                return;
            } finally { connection.disconnect(); }
        }
        throw new java.io.IOException("Too many redirects");
    }
    @Override protected void onPause() {
        if (web != null) web.onPause();
        CookieManager.getInstance().flush();
        super.onPause();
    }
    @Override protected void onResume() { super.onResume(); if (web != null) web.onResume(); }
    @Override protected void onDestroy() {
        pendingMarkdown = null; pendingMarkdownOrigin = null; pendingZip = null;
        if (activeZip != null) {
            activeZip.closed = true;
            try { if (activeZip.output != null) activeZip.output.close(); } catch (Exception ignored) {}
            if (activeZip.destination != null) try { android.provider.DocumentsContract.deleteDocument(getContentResolver(), activeZip.destination); } catch (Exception ignored) {}
            activeZip = null;
        }
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        if (web != null) { web.stopLoading(); web.destroy(); }
        transfers.shutdownNow();
        super.onDestroy();
    }
}
