(function () {
  // Embeds' own fullscreen buttons would make only their iframe fullscreen, which draws nothing
  // else (no picture-in-picture tiles, no app UI) and on Windows also flips the whole window.
  // Inside embeds the fullscreen API is answered here instead: the app shows the tile in its
  // fullscreen layout and tells the frame when that layout closes.
  if (window === window.top) return;

  // NOTE: never put the word "pause" in these message types; some embeds drop such messages
  var REQUEST = "MULTISTREAM_FRAME_FULLSCREEN";
  var STATE = "MULTISTREAM_FULLSCREEN_STATE";

  var current = null;

  // Like the real API, only a recent click or key press in this frame may go fullscreen (an ad
  // can't on load). Tracked here because WebKit's navigator.userActivation stays inactive in
  // cross-origin frames even for real clicks.
  var GESTURE_MS = 2000;
  var lastGesture = -Infinity;
  ["pointerdown", "mousedown", "keydown", "touchstart"].forEach(function (type) {
    window.addEventListener(
      type,
      function (e) {
        if (e.isTrusted) lastGesture = Date.now();
      },
      true
    );
  });
  // native fullscreen also restyles the element to fill the screen; a page whose player isn't
  // already the whole frame (a custom stream's site) needs that too
  var MARK = "data-ms-fullscreen";
  var styled = false;

  function ensureStyle() {
    if (styled) return;
    styled = true;
    var style = document.createElement("style");
    style.textContent =
      "[" +
      MARK +
      "]{position:fixed!important;inset:0!important;width:100%!important;height:100%!important;" +
      "max-width:none!important;max-height:none!important;margin:0!important;z-index:2147483647!important}";
    (document.head || document.documentElement).appendChild(style);
  }

  function failed(element, reason) {
    announceError(element);
    return Promise.reject(new TypeError(reason));
  }

  function announceError(element) {
    var target = element && element.isConnected ? element : document;
    setTimeout(function () {
      ["fullscreenerror", "webkitfullscreenerror"].forEach(function (type) {
        target.dispatchEvent(new Event(type, { bubbles: true }));
      });
    }, 0);
  }

  function post(on) {
    try {
      window.top.postMessage({ type: REQUEST, on: on }, "*");
    } catch (err) {
      // the app is gone
    }
  }

  function announce(element) {
    var target = element && element.isConnected ? element : document;
    setTimeout(function () {
      ["fullscreenchange", "webkitfullscreenchange"].forEach(function (type) {
        target.dispatchEvent(new Event(type, { bubbles: true }));
      });
    }, 0);
  }

  function enter(element) {
    if (!(element instanceof Element)) return Promise.reject(new TypeError("Not an element"));
    if (current === element) return Promise.resolve();
    if (Date.now() - lastGesture > GESTURE_MS) {
      return failed(element, "Fullscreen needs a user gesture");
    }
    var wasOn = !!current;
    if (current) current.removeAttribute(MARK);
    current = element;
    ensureStyle();
    element.setAttribute(MARK, "");
    wakeCursor();
    if (!wasOn) post(true);
    announce(element);
    return Promise.resolve();
  }

  // The cursor rests invisible like the player controls do: mouse moves over a frame never reach
  // the app, so the frame hides it itself while it is fullscreen and the pointer sits still.
  var IDLE_MS = 2500;
  var idleTimer = 0;
  var idleStyle = null;

  function showCursor() {
    clearTimeout(idleTimer);
    idleTimer = 0;
    if (idleStyle && idleStyle.parentNode) idleStyle.parentNode.removeChild(idleStyle);
  }

  function wakeCursor() {
    if (!current) return;
    showCursor();
    idleTimer = setTimeout(function () {
      if (!current) return;
      if (!idleStyle) {
        idleStyle = document.createElement("style");
        idleStyle.textContent = "*,*::before,*::after{cursor:none!important}";
      }
      (document.head || document.documentElement).appendChild(idleStyle);
    }, IDLE_MS);
  }

  ["mousemove", "mousedown", "wheel", "keydown"].forEach(function (type) {
    window.addEventListener(type, wakeCursor, { capture: true, passive: true });
  });

  function leave(fromApp) {
    if (!current) return Promise.resolve();
    showCursor();
    var element = current;
    current = null;
    element.removeAttribute(MARK);
    if (!fromApp) post(false);
    announce(element);
    return Promise.resolve();
  }

  function define(proto, name, value) {
    try {
      Object.defineProperty(proto, name, { configurable: true, writable: true, value: value });
    } catch (err) {
      // leave the native one
    }
  }

  function getter(proto, name, get) {
    try {
      Object.defineProperty(proto, name, { configurable: true, get: get });
    } catch (err) {
      // leave the native one
    }
  }

  var request = function () {
    return enter(this);
  };
  define(Element.prototype, "requestFullscreen", request);
  define(Element.prototype, "webkitRequestFullscreen", request);
  define(Element.prototype, "webkitRequestFullScreen", request);

  var exit = function () {
    return leave(false);
  };
  define(Document.prototype, "exitFullscreen", exit);
  define(Document.prototype, "webkitExitFullscreen", exit);
  define(Document.prototype, "webkitCancelFullScreen", exit);

  var element = function () {
    return current;
  };
  getter(Document.prototype, "fullscreenElement", element);
  getter(Document.prototype, "webkitFullscreenElement", element);
  getter(Document.prototype, "webkitCurrentFullScreenElement", element);

  var isOn = function () {
    return !!current;
  };
  getter(Document.prototype, "fullscreen", isOn);
  getter(Document.prototype, "webkitIsFullScreen", isOn);

  // macOS WebViews report fullscreen as unavailable, which hides the players' buttons
  var enabled = function () {
    return true;
  };
  getter(Document.prototype, "fullscreenEnabled", enabled);
  getter(Document.prototype, "webkitFullscreenEnabled", enabled);

  // with fullscreen unavailable WebKit also drops the `on…` handler properties, and players
  // (Twitch's BigScreen) pick the change event to listen for by checking `"onfullscreenchange"
  // in document`: without them they never hear about changes and their state never flips
  function handlerProperty(proto, type) {
    var name = "on" + type;
    if (name in proto) return;
    var handlers = new WeakMap();
    try {
      Object.defineProperty(proto, name, {
        configurable: true,
        get: function () {
          return handlers.get(this) || null;
        },
        set: function (handler) {
          var previous = handlers.get(this);
          if (previous) this.removeEventListener(type, previous);
          if (typeof handler === "function") {
            handlers.set(this, handler);
            this.addEventListener(type, handler);
          } else {
            handlers.delete(this);
          }
        },
      });
    } catch (err) {
      // leave it missing
    }
  }
  [
    "fullscreenchange",
    "webkitfullscreenchange",
    "fullscreenerror",
    "webkitfullscreenerror",
  ].forEach(function (type) {
    handlerProperty(Document.prototype, type);
    handlerProperty(Element.prototype, type);
  });

  window.addEventListener("message", function (e) {
    if (!e.data || e.data.type !== STATE) return;
    if (e.data.on === false) leave(true);
    // the player may live in a frame nested inside the embed page
    for (var i = 0; i < window.frames.length; i++) {
      try {
        window.frames[i].postMessage(e.data, "*");
      } catch (err) {
        // detached frame
      }
    }
  });
})();
