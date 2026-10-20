/** A loaded desktop document may reload itself, but may not navigate to another document. */
export function isSameDesktopDocument(currentUrl: string, requestedUrl: string): boolean {
  try {
    const current = new URL(currentUrl), requested = new URL(requestedUrl);
    if (current.protocol !== "file:" && current.protocol !== "http:" && current.protocol !== "https:") return false;
    current.hash = "";
    requested.hash = "";
    return current.href === requested.href;
  } catch {
    return false;
  }
}

export function isTrustedDevelopmentRendererUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port === "1420"
      && url.pathname === "/" && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}
