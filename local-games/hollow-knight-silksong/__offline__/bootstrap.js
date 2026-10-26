/* Registers the offline mapper and reloads once so every request is controlled. */
(function () {
  const origin = location.origin;
  const isExternal = (url) => {
    try {
      return new URL(String(url), location.href).origin !== origin;
    } catch {
      return false;
    }
  };

  // Service workers cannot intercept sendBeacon, WebSocket or EventSource.
  // Block those when they point off-origin so a mirrored game can never phone
  // home silently.
  if (navigator.sendBeacon) {
    const nativeBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      if (isExternal(url)) {
        console.warn("offline: blocked external beacon", String(url));
        return false;
      }
      return nativeBeacon(url, data);
    };
  }

  for (const [name, Native] of [
    ["WebSocket", window.WebSocket],
    ["EventSource", window.EventSource],
  ]) {
    if (!Native) continue;
    try {
      window[name] = new Proxy(Native, {
        construct(target, args) {
          if (isExternal(args[0])) {
            console.warn(`offline: blocked external ${name}`, String(args[0]));
            throw new DOMException("Blocked by offline mode", "SecurityError");
          }
          return new target(...args);
        },
      });
    } catch {}
  }

  // Keep the game from replacing our mapper with its own service worker.
  if (navigator.serviceWorker && navigator.serviceWorker.register) {
    const nativeRegister = navigator.serviceWorker.register.bind(navigator.serviceWorker);
    navigator.serviceWorker.register = function (url, options) {
      const target = String(url || "");
      if (target.includes("offline-sw.js")) return nativeRegister(url, options);
      console.warn("offline: blocked game service worker registration", target);
      return Promise.reject(new DOMException("Blocked by offline mode", "SecurityError"));
    };
  }

  if (!("serviceWorker" in navigator)) return;
  const scriptUrl = document.currentScript?.src;
  const gameRoot = new URL("../", scriptUrl || location.href);
  const KEY = `__obsidian_offline_reloaded__:${gameRoot.pathname}`;
  navigator.serviceWorker
    .register(new URL("offline-sw.js", gameRoot), { scope: gameRoot.pathname })
    .then((registration) => {
      if (registration.active) return registration;
      const worker = registration.installing || registration.waiting;
      if (!worker) throw new Error("Offline service worker was not installed.");
      return new Promise((resolve, reject) => {
        const onStateChange = () => {
          if (worker.state === "activated") {
            worker.removeEventListener("statechange", onStateChange);
            resolve(registration);
          } else if (worker.state === "redundant") {
            worker.removeEventListener("statechange", onStateChange);
            reject(new Error("Offline service worker became redundant."));
          }
        };
        worker.addEventListener("statechange", onStateChange);
        onStateChange();
      });
    })
    .then(() => undefined)
    .then(() => {
      if (!navigator.serviceWorker.controller && !sessionStorage.getItem(KEY)) {
        sessionStorage.setItem(KEY, "1");
        location.reload();
      }
    })
    .catch((err) => console.error("Offline service worker registration failed:", err));
})();
