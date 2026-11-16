(() => {
  const probe = document.querySelector("[data-probe-cookie]");
  // Direct access to the implementation route must not start another routing cycle.
  if (!probe || location.pathname.replace(/\/$/, "") !== "/kiosk") return;

  // Safari 16.4 added color-mix. This feature probe also covers desktop-site UAs that mask
  // the iPadOS version. Camera permissions never participate in renderer selection.
  const modern = window.CSS && CSS.supports("color", "color-mix(in srgb, black, white)");
  const target = modern ? "modern" : "legacy";
  const cookie = probe.dataset.probeCookie + "=" + target;
  try {
    document.cookie =
      cookie + "; Path=/kiosk; SameSite=Lax" + (location.protocol === "https:" ? "; Secure" : "");
    if (document.cookie.split(/;\s*/).includes(cookie)) {
      location.reload();
      return;
    }
  } catch {
    // Cookie storage is optional. The query marker is scoped to this navigation.
  }
  const url = new URL(location.href);
  url.searchParams.set(probe.dataset.probeParam, target);
  location.replace(url);
})();
