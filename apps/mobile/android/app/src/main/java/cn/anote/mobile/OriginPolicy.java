package cn.anote.mobile;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

/** No Android dependencies: the trust boundary is tested on the JVM. */
public final class OriginPolicy {
    private OriginPolicy() {}

    public static String origin(String value) {
        if (value == null) return null;
        try {
            URI uri = new URI(value);
            String scheme = uri.getScheme();
            String host = uri.getHost();
            if (scheme == null || host == null || uri.getRawUserInfo() != null ||
                !(scheme.equalsIgnoreCase("https") || scheme.equalsIgnoreCase("http"))) return null;
            int port = uri.getPort();
            if (port < -1 || port == 0 || port > 65535) return null;
            scheme = scheme.toLowerCase(Locale.ROOT);
            host = host.toLowerCase(Locale.ROOT);
            if (host.indexOf(':') >= 0 && !host.startsWith("[")) host = "[" + host + "]";
            String portPart = port == -1 || (scheme.equals("https") && port == 443) ||
                (scheme.equals("http") && port == 80) ? "" : ":" + port;
            return scheme + "://" + host + portPart;
        } catch (URISyntaxException | IllegalArgumentException error) {
            return null;
        }
    }

    public static String server(String value, boolean preview, String previewOrigin) {
        try {
            URI uri = new URI(value.trim());
            String result = origin(uri.toString());
            if (result == null || uri.getRawQuery() != null || uri.getRawFragment() != null ||
                !(uri.getRawPath() == null || uri.getRawPath().isEmpty() || uri.getRawPath().equals("/"))) {
                throw new IllegalArgumentException("请输入不含路径、账号或参数的服务器地址");
            }
            if (result.startsWith("http:") && !(preview && result.equals(origin(previewOrigin)))) {
                throw new IllegalArgumentException("服务器必须使用 HTTPS；预览版仅允许构建时指定的 HTTP 测试地址");
            }
            return result;
        } catch (URISyntaxException error) {
            throw new IllegalArgumentException("服务器地址格式不正确");
        }
    }

    public static boolean sameOrigin(String url, String expectedOrigin) {
        String parsed = origin(url);
        return parsed != null && parsed.equals(expectedOrigin);
    }
    public static boolean sameBlobOrigin(String url, String expectedOrigin) {
        return url != null && url.startsWith("blob:") && sameOrigin(url.substring(5), expectedOrigin);
    }

    public static boolean isAuthenticationStart(String url, String serverOrigin) {
        if (!sameOrigin(url, serverOrigin)) return false;
        try {
            return new URI(url).getPath().matches("/api/auth/casdoor/(start|link)");
        } catch (URISyntaxException error) { return false; }
    }

    public static String safeFilename(String name) {
        String result = name == null ? "附件" : name.replaceAll("[\\p{Cntrl}/\\\\:*?\"<>|]", "_").trim();
        return result.isEmpty() || result.equals(".") || result.equals("..") ? "附件" : result.substring(0, Math.min(result.length(), 180));
    }

    public static String printTitle(String noteTitle, String pageTitle) {
        String selected = noteTitle == null ? "" : noteTitle.trim();
        if (selected.isEmpty()) selected = pageTitle == null ? "" : pageTitle.trim();
        return safeFilename(selected.isEmpty() ? "笔记" : selected);
    }
}
