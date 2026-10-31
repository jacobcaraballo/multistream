(function () {
  // only run inside iframes (stream embeds), not the main app frame
  if (window === window.top) return;

  // NOTE: never put the word "pause" in these message types; some embeds drop such messages
  var ACTIVATE = "MULTISTREAM_FRAME_ACTIVATE";
  var STATE = "MULTISTREAM_AUDIO_STATE";
  // after the selecting press is released, a quick second click is kept away from the player too
  var SWALLOW_MS = 400;
  // players reset their mute state while starting up (Twitch starts with muted=true)
  var ENFORCE_MS = 15000;
  var CONTROLS =
    'button, a, input, select, textarea, label, [contenteditable="true"], [role="button"], ' +
    '[role="slider"], [role="menu"], [role="menuitem"], [role="menuitemradio"], ' +
    '[role="menuitemcheckbox"], [role="checkbox"], [role="switch"], [role="tab"], ' +
    '[role="option"], [role="listbox"]';

  // only frames the app marks as stream tiles react (chat embeds are iframes too)
  var isTile = false;
  // null until the app shares an audio choice, then true (this tile has the audio) or false
  var active = null;
  // the selecting press is held back from the player until it is released, however long it lasts
  var swallowing = false;
  var swallowUntil = 0;
  var enforceUntil = 0;

  function isControl(target) {
    return !!(target && target.closest && target.closest(CONTROLS));
  }

  function findTwitchPlayer() {
    var root = document.querySelector("#root");
    if (!root) return null;
    var key = Object.keys(root).find(function (k) {
      return k.indexOf("__reactContainer") === 0;
    });
    var node =
      (root._reactRootContainer &&
        root._reactRootContainer._internalRoot &&
        root._reactRootContainer._internalRoot.current) ||
      (key && root[key]);
    var stack = node ? [node] : [];
    var visited = 0;
    while (stack.length && visited < 20000) {
      var current = stack.pop();
      visited++;
      var state = current.stateNode;
      if (state && state.setPlayerActive && state.props && state.props.mediaPlayerInstance) {
        var player = state.props.mediaPlayerInstance;
        return player.playerInstance || player;
      }
      if (current.sibling) stack.push(current.sibling);
      if (current.child) stack.push(current.child);
    }
    return null;
  }

  // the stream itself: the largest visible video (pages may keep previews / ads muted next to it)
  function mainVideo() {
    var videos = document.querySelectorAll("video");
    var best = null;
    var bestArea = 0;
    for (var i = 0; i < videos.length; i++) {
      var area = videos[i].clientWidth * videos[i].clientHeight;
      if (area > bestArea) {
        best = videos[i];
        bestArea = area;
      }
    }
    return best;
  }

  // the platform's own player API keeps its controls in sync; returns true when one handled it
  function setPlayerMuted(muted) {
    try {
      var twitch = location.hostname.indexOf("twitch.tv") !== -1 ? findTwitchPlayer() : null;
      if (twitch && typeof twitch.setMuted === "function") {
        twitch.setMuted(muted);
        if (!muted && typeof twitch.getVolume === "function" && twitch.getVolume() === 0) {
          twitch.setVolume(0.5);
        }
        return true;
      }
    } catch (e) {
      // fall back to the media elements
    }
    try {
      var youtube = document.getElementById("movie_player");
      if (youtube && typeof youtube.mute === "function") {
        if (muted) youtube.mute();
        else {
          youtube.unMute();
          if (youtube.getVolume && youtube.getVolume() === 0) youtube.setVolume(50);
        }
        return true;
      }
    } catch (e) {
      // fall back to the media elements
    }
    return false;
  }

  function setMuted(muted) {
    if (window.__isGraveyard) return;
    var handled = setPlayerMuted(muted);
    if (muted) {
      // silence everything in a tile that doesn't have the audio
      var media = document.querySelectorAll("video, audio");
      for (var i = 0; i < media.length; i++) media[i].muted = true;
      return;
    }
    if (handled) return;
    var video = mainVideo();
    if (!video) return;
    video.muted = false;
    if (video.volume === 0) video.volume = 0.5;
  }

  // Twitch pauses embeds smaller than 400x300 (e.g. the big viewer's side column), so a tile that
  // gets the audio (often by moving into the big viewer) is started again if it sits paused
  function resumeIfPaused() {
    if (window.__isGraveyard || active !== true) return;
    try {
      var twitch = location.hostname.indexOf("twitch.tv") !== -1 ? findTwitchPlayer() : null;
      if (twitch && typeof twitch.isPaused === "function") {
        if (twitch.isPaused() && typeof twitch.play === "function") twitch.play();
        return;
      }
    } catch (e) {
      // fall back to the media element
    }
    try {
      var youtube = document.getElementById("movie_player");
      if (youtube && typeof youtube.getPlayerState === "function") {
        if (youtube.getPlayerState() === 2) youtube.playVideo();
        return;
      }
    } catch (e) {
      // fall back to the media element
    }
    var video = mainVideo();
    if (video && video.paused) video.play().catch(function () {});
  }

  var resumeTimers = [];

  // the user handling the player themselves (e.g. pausing it) ends the automatic resumes
  function cancelResumes() {
    resumeTimers.forEach(clearTimeout);
    resumeTimers = [];
  }

  function applyState(nextActive) {
    var gained = nextActive && active !== true;
    active = nextActive;
    enforceUntil = Date.now() + ENFORCE_MS;
    setMuted(!active);
    // the app confirming a tile that already has the audio keeps its pending resumes
    if (!nextActive || gained) cancelResumes();
    if (gained) {
      // the layout (and Twitch's size check) settles over the next moments
      resumeIfPaused();
      resumeTimers = [setTimeout(resumeIfPaused, 700), setTimeout(resumeIfPaused, 1600)];
    }
  }

  function relayToChildren(message) {
    for (var i = 0; i < window.frames.length; i++) {
      try {
        window.frames[i].postMessage(message, "*");
      } catch (e) {
        // ignore detached frames
      }
    }
  }

  window.addEventListener("message", function (e) {
    if (!e.data || e.data.type !== STATE || e.source !== window.parent) return;
    isTile = true;
    var next = typeof e.data.active === "boolean" ? e.data.active : null;
    if (next === null) active = null;
    else applyState(next);
    // muting reaches every nested frame; unmuting only when the player itself lives in one
    if (next !== true || !mainVideo()) relayToChildren({ type: STATE, active: next });
  });

  // a player (re)starting media within the enforcement window gets the shared choice again
  function reapply() {
    if (active !== null && Date.now() < enforceUntil) setMuted(!active);
  }
  document.addEventListener("playing", reapply, true);
  document.addEventListener("loadedmetadata", reapply, true);

  function swallow(e) {
    e.stopImmediatePropagation();
    if (e.cancelable) e.preventDefault();
  }

  // the first press on an inactive tile selects it instead of pausing / toggling the player
  window.addEventListener(
    "pointerdown",
    function (e) {
      swallowing = false;
      if (!isTile || e.button !== 0 || window.__isGraveyard) return;
      if (active === true || isControl(e.target)) {
        cancelResumes();
        return;
      }
      swallowing = true;
      swallow(e);
      // unmute inside the user's gesture; the app then confirms and mutes the other tiles
      applyState(true);
      window.top.postMessage({ type: ACTIVATE }, "*");
    },
    true
  );

  ["mousedown", "pointerup", "mouseup", "click", "dblclick"].forEach(function (type) {
    window.addEventListener(
      type,
      function (e) {
        if (swallowing && (e.type === "pointerup" || e.type === "mouseup")) {
          // released: the click that follows (and a quick second click) still belongs to it
          swallowing = false;
          swallowUntil = Date.now() + SWALLOW_MS;
          swallow(e);
          return;
        }
        if (swallowing || Date.now() < swallowUntil) swallow(e);
      },
      true
    );
  });

  window.addEventListener(
    "pointercancel",
    function () {
      swallowing = false;
    },
    true
  );

  window.addEventListener("keydown", cancelResumes, true);
})();
