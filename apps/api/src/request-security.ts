import type { RequestHandler } from "express";

function httpOrigin(value: string) {
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function requestSecurity(
  publicOrigin = "",
  allowedOrigins: string[] = [],
): RequestHandler {
  const configured = publicOrigin.trim()
    ? httpOrigin(publicOrigin.trim())
    : null;
  if (publicOrigin.trim() && !configured)
    throw new Error(
      "PUBLIC_ORIGIN must be an HTTP(S) origin without a path or credentials",
    );
  return (req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Frame-Options", "DENY");
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers.origin &&
      !req.headers.authorization?.startsWith("Bearer ")
    ) {
      const supplied = httpOrigin(req.headers.origin);
      // Reverse-proxy HTTPS is trusted only through explicit deployment configuration.
      // Direct same-origin LAN access also remains valid; forwarded headers grant no trust.
      const direct = httpOrigin(`${req.protocol}://${req.headers.host}`);
      if (
        !supplied ||
        (supplied !== direct &&
          supplied !== configured &&
          !allowedOrigins.includes(supplied))
      ) {
        res.status(403).json({ error: "请求来源不匹配" });
        return;
      }
    }
    next();
  };
}
