/* ─────────────────────────────────────────────────────────────────────────
   study-bridge.js — reVISit ⇄ DyNetSpin glue for the controlled study.

   This is the ONLY new application code in the study build. It edits no
   existing file: everything below goes through globals and DOM clicks the
   dashboard already exposes, so deleting this file and study-mode.css
   restores the normal tool exactly.

   Four jobs:
     (a) receive the trial condition from reVISit and put the tool into it,
     (b) suppress every control that would let a participant change the
         independent variable,
     (c) highlight "this group" / "this person" without leaking the answer,
     (d) log every interaction that a dependent variable is computed from.

   The load dance
   --------------
   BarChartPopulator auto-clicks the first dataset on window load, which
   auto-clicks its first slice. We cannot stop that without editing the app, so
   instead we let it happen behind a "Loading…" veil, then drive the tool to the
   requested state and only then reveal it and call Revisit.postReady(). The
   participant never sees the default stimulus.

   `dyn:slice-loaded` (BarChartPopulator.js:571) is the only reliable "a slice
   has finished rendering" signal, so every step waits on it.
   ───────────────────────────────────────────────────────────────────────── */
(function () {
  "use strict";

  var root = document.documentElement;
  root.classList.add("study", "study-booting");

  /* Advisory only — see study-mode.css. These are measured on the IFRAME, which
     is already narrower than the browser window by reVISit's sidebar, so they
     must be well below any window-level figure. Set low enough that a normal
     laptop never sees the hint, and high enough that a genuinely cramped pane
     still gets one. */
  var HINT_W = 760, HINT_H = 480;
  var SETTLE_MS = 120;             // let a render finish before we touch it again

  /* Pointer track. reVISit records mousemove itself (StepRenderer.tsx attaches
     the listener to `window`), but the stimulus is an IFRAME and pointer events
     do not cross that boundary — so its track covers the sidebar and buttons
     and stops at the edge of the visualization, which is the only region worth
     having. We record inside the frame and ship it with the answer.

     Sampled, not raw: at 120 ms a 90-second trial is ~750 points, a few KB.
     CAP bounds the worst case so one long trial cannot bloat a participant's
     record. */
  var POINTER_MS = 120, POINTER_CAP = 2000;
  var pointer = [];

  var cfg = null;                  // the trial's `parameters` block
  var appReady = false;            // the tool has rendered at least one slice
  var applied = false;             // guard: apply the condition exactly once
  var log = [];                    // interaction trace, mirrored to reVISit
  var t0 = Date.now();

  /* ── logging ───────────────────────────────────────────────────────────── */

  var lastAt = {};
  function evt(name, id, throttleMs) {
    if (throttleMs) {
      var now = Date.now();
      if (lastAt[name] && now - lastAt[name] < throttleMs) return;
      lastAt[name] = now;
    }
    log.push({ t: Date.now() - t0, event: name, id: id === undefined ? null : id });
    if (window.Revisit && Revisit.postEvent) {
      try { Revisit.postEvent(name, id === undefined ? null : String(id)); } catch (e) {}
    }
  }

  /* Derived measures. Computed here rather than in analysis so the definition
     lives next to the instrumentation that feeds it. sliceChanges is Block C's
     primary DV: if the all-slices overview really does put the whole evolution
     in one image, it should collapse toward zero. */
  function measures() {
    var alphaVals = log.filter(function (e) { return e.event === "alpha_change"; })
                       .map(function (e) { return parseFloat(e.id); });
    return {
      sliceChanges: log.filter(function (e) { return e.event === "slice_change"; }).length,
      overviewOpened: log.some(function (e) { return e.event === "overview_open"; }),
      egoOpened: log.some(function (e) { return e.event === "ego_open"; }),
      cohortsAdded: log.filter(function (e) { return e.event === "cohort_add"; }).length,
      alphaChanges: alphaVals.length,
      alphaSettled: alphaVals.length ? alphaVals[alphaVals.length - 1] : null,
      alphaPath: alphaVals,
      durationMs: Date.now() - t0,
      // [ms since trial start, x, y] inside the stimulus frame
      pointerTrack: pointer,
      pointerSamples: pointer.length,
      pointerTruncated: pointer.length >= POINTER_CAP,
      trace: log
    };
  }

  function postAnswer(extra) {
    if (!window.Revisit || !Revisit.postAnswers) return;
    var payload = { studyMeasures: measures() };
    for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) payload[k] = extra[k];
    try { Revisit.postAnswers(payload); } catch (e) {}
  }

  /* ── waiting on the app ────────────────────────────────────────────────── */

  function onSliceLoaded() {
    return new Promise(function (resolve) {
      document.addEventListener("dyn:slice-loaded", function once(ev) {
        document.removeEventListener("dyn:slice-loaded", once);
        setTimeout(function () { resolve(ev.detail && ev.detail.label); }, SETTLE_MS);
      });
    });
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ── driving the tool ──────────────────────────────────────────────────── */

  function selectDataset(key) {
    if (!key || window.currentDataset === key) return Promise.resolve();
    // Buttons are d3-bound to the dataset key, so pick by datum rather than by
    // visible label — labels are display strings and may repeat.
    var hit = d3.select("#dataset-buttons").selectAll("button")
                .filter(function (d) { return d === key; });
    if (hit.empty()) {
      console.error("[study] dataset not available in this build:", key);
      return Promise.resolve();
    }
    var done = onSliceLoaded();
    hit.dispatch("click");
    return done;
  }

  function selectSlice(dirOrLabel) {
    if (!dirOrLabel) return Promise.resolve();
    var btn = document.querySelector('#year-buttons .ts-btn[data-dir="' + dirOrLabel + '"]') ||
              document.querySelector('#year-buttons .ts-btn[data-slice-label="' + dirOrLabel + '"]');
    if (!btn) {
      console.error("[study] slice not found:", dirOrLabel);
      return Promise.resolve();
    }
    if (btn.classList.contains("active")) return Promise.resolve();
    var done = onSliceLoaded();
    btn.click();
    return done;
  }

  var ENCODINGS = {
    local:  "colorNodesByLocalVolatility",   // ours — a ±1 window, so a frame says WHEN
    global: "colorNodesByVolatility",        // the DynTrix notion — whole-timeline score
    degree: "colorNodesByDegree",            // neutral control, nothing temporal
    density: "colorNodesByDensity"
  };

  /* The colour flags are `let` bindings at the top level of
     fitting_data_to_spiral3.js (:8-13, :72), NOT properties of window — so they
     cannot be read or reset from here at all. Two facts make that safe:

       1. reVISit loads a fresh iframe per trial, so every flag starts at its
          declared default and no state carries between conditions.
       2. Each colorNodesBy*() clears the flags that outrank it in the reader's
          if/else chain (fitting_data_to_spiral3.js:1358+), so one call lands
          exactly one encoding.

     The known gap — colorNodesByDegree/Density leave volatilityColFlag set —
     cannot bite here, because volatilityColFlag is tested AFTER degreeColFlag
     and we never call two encodings in one trial. Correctness is nonetheless
     asserted against the RENDERED fills, not against a flag, by
     tools/verify_bridge.js: what the participant sees is the thing that
     matters, and it is the thing a flag can silently misreport. */
  function applyEncoding(name) {
    var fn = ENCODINGS[name];
    if (!fn) { console.error("[study] unknown encoding:", name); return; }
    if (typeof window[fn] !== "function") {
      console.error("[study] encoding function missing:", fn);
      return;
    }
    window[fn]();
    window.__studyEncoding = name;   // declared intent, for the verifier
  }

  /* Re-enable one group of the encoding bar. study-mode.css hides every group
     by default, so a control is reachable only if a condition names it here. */
  function allowEncodingGroup(childSelector) {
    var el = document.querySelector(childSelector);
    var grp = el && el.closest ? el.closest("#encodingBar > *") : null;
    if (grp) grp.classList.add("study-allow");
    return !!grp;
  }

  function applyAlpha(alpha) {
    if (!alpha) return;
    if (alpha.mode === "slider") {
      root.classList.add("study-alpha");
      allowEncodingGroup("#AlphaSlider");
      // Start every participant from the same place. Opening at our suggested
      // value would anchor them to it, and Block B's whole question is which
      // alpha THEY settle on.
      if (typeof alpha.start === "number" && typeof window.updateAlpha === "function") {
        var s = document.getElementById("AlphaSlider");
        if (s) s.value = String(alpha.start);
        window.updateAlpha(alpha.start);
      }
    } else if (alpha.mode === "auto") {
      /* Leave the ordering the tool itself proposes (findBestAlpha ran at
         load) and hide the control. This is the "our layout" arm of the
         comparison, and it deliberately names no number — the claim is about
         the ordering DyNetSpin offers, not about a magic constant. */
      return;
    } else if (typeof alpha.value === "number" && typeof window.updateAlpha === "function") {
      var sl = document.getElementById("AlphaSlider");
      if (sl) sl.value = String(alpha.value);
      window.updateAlpha(alpha.value);
    }
  }

  function applyWidgets(w) {
    w = w || {};
    if (w.overview) {
      root.classList.add("study-overview");
      // #evoToggle lives inside #encodingBar, so it needs the group re-enabled
      // or Block C's "overview available" condition has no way in.
      allowEncodingGroup("#evoToggle");
    }
    if (w.cohort)    root.classList.add("study-cohort");
    if (w.ego)       root.classList.add("study-ego");
    // Only when explicitly asked for. Deriving it from `overview` meant a
    // trial that set inspector:false still got the panel, because the overview
    // has its own section in there.
    if (w.inspector) root.classList.add("study-inspector");

    // Hidden is not the same as unreachable, and Block C's result depends on
    // the difference. Stub the entry point too.
    if (!w.overview && window.CommunityEvolution) {
      window.CommunityEvolution.open = function () {};
      window.CommunityEvolution.toggle = function () {};
    }
    // The Cohort Tracker persists a highlight across slices. In Block B that
    // would hand over the answer, so neutralise it rather than just hide it.
    if (!w.cohort && typeof window.snapshotCommunityCohort === "function") {
      window.__realSnapshotCommunityCohort = window.snapshotCommunityCohort;
      // Suppress the tracker's SIDE EFFECT, not the event. The overview routes
      // every pick through here, so a bare no-op also swallowed the answer.
      window.snapshotCommunityCohort = function (d, opts) {
        handleCommunityPick(d, opts);
      };
    }
  }

  /* A community pick, from the chart or from the overview. Extracted because
     the Cohort Tracker stub below must still record the answer: replacing
     snapshotCommunityCohort with a bare no-op silently threw away every pick in
     any trial that had the tracker off, which is every overview trial. */
  function handleCommunityPick(d, opts) {
    if (!applied) return;
    var id = (opts && opts.id) || (d && d.community);
    evt("cohort_add", id);
    if (cfg && cfg.answerMode === "overviewCommunity" &&
        typeof id === "string" && id.indexOf("evo") === 0) {
      // communityEvolution.js labels overview picks "evo<sliceLabel>#<community>"
      var m = /^evo(.*)#(\d+)$/.exec(id);
      if (m) {
        evt("answer_submit", id);
        postAnswer({ answer: m[2], answerSlice: m[1] });
      }
    }
  }

  /* Put the condition's widget into its ACTIVE state, not merely its available
     one.

     Both of these are toggles: the overview opens on a button press, and the
     Cohort Tracker fills only once a community is clicked. Leaving them idle
     makes the manipulation "was the control discoverable", not "does the
     control help" — a participant who never presses the button experiences the
     withheld condition, and a null result becomes uninterpretable. Since the
     claim under test is about the view itself, the view is opened for them.
     `overview_close` and `cohort_add` stay instrumented, so opting back out is
     still visible in the trace. */
  function activateWidgets() {
    if (!cfg) return;

    if (cfg.openOverview && window.CommunityEvolution &&
        typeof window.CommunityEvolution.open === "function") {
      try {
        window.CommunityEvolution.open();
        evt("overview_open", "auto");
        var n = highlightInOverview();
        window.__studyEvoHighlighted = n;
        if (!n) console.warn("[study] overview opened but no member dots marked");
      } catch (e) { console.error("[study] could not open overview", e); }
    }

    if (cfg.seedCohort && cfg.highlightCommunity !== undefined) {
      var snap = window.__realSnapshotCommunityCohort || window.snapshotCommunityCohort;
      if (typeof snap === "function" && typeof global_data !== "undefined") {
        var ids = global_data
          .filter(function (d) { return d && +d.community === +cfg.highlightCommunity; })
          .map(function (d) { return +d.node; });
        if (ids.length) {
          try {
            snap(null, { nodeIds: ids, id: cfg.highlightCommunity,
                         label: "Tracked group" });
            // snapshotCommunityCohort expands the panel itself, but only if it
            // is present when it runs; assert the end state rather than trust it
            var cf = document.getElementById("cohortFloat");
            if (cf) cf.classList.remove("collapsed");
            document.body.classList.add("cohorts-active");
            window.__studyCohortSeeded =
              document.querySelectorAll("#communitySideContainer > *").length;
            evt("cohort_add", "auto:" + cfg.highlightCommunity);
          } catch (e) { console.error("[study] could not seed cohort", e); }
        }
      }
    }
  }

  /* Highlight the prompt's target. Deliberately NOT the Cohort Tracker — this
     is a plain stroke that dies on the next slice change, so "which group holds
     these people now" stays a question the participant has to answer. */
  function applyHighlight() {
    if (!cfg) return;
    var comm = cfg.highlightCommunity;
    var ids = cfg.highlightNodes;
    if (comm === undefined && !ids) return;

    var wanted = ids ? new Set(ids.map(Number)) : null;
    d3.selectAll("circle.happy").each(function (d) {
      if (!d) return;
      var hit = wanted ? wanted.has(+d.node) : (+d.community === +comm);
      this.classList.toggle("study-highlight", hit);
      if (cfg.dimOthers) this.classList.toggle("study-highlight-dim", !hit);
    });
  }
  /* The overview draws its own dots, so the stroke put on `circle.happy` never
     reaches it — a participant told to follow "the outlined group" opened the
     overview and found nothing outlined. Mark the SAME member ids on every
     ring, which is also the overview's whole point: where these people are in
     each period. */
  function highlightInOverview() {
    if (!cfg || cfg.highlightCommunity === undefined) return 0;
    if (typeof global_data === "undefined") return 0;
    var members = {};
    global_data.forEach(function (d) {
      if (d && +d.community === +cfg.highlightCommunity) members[+d.node] = 1;
    });
    var dots = document.querySelectorAll("#communityEvolution .evo-dot");
    var n = 0;
    for (var i = 0; i < dots.length; i++) {
      var id = +dots[i].getAttribute("data-node");
      if (members[id]) { dots[i].classList.add("study-evo-highlight"); n++; }
    }
    return n;
  }

  function clearHighlight() {
    d3.selectAll("circle.happy").each(function () {
      this.classList.remove("study-highlight", "study-highlight-dim");
    });
  }

  /* ── instrumentation ───────────────────────────────────────────────────── */

  function instrument() {
    document.addEventListener("dyn:slice-loaded", function (ev) {
      if (!applied) return;                       // ignore the boot sequence
      evt("slice_change", ev.detail && ev.detail.label);
      clearHighlight();                           // highlight is slice-local
    });

    var slider = document.getElementById("AlphaSlider");
    if (slider) {
      ["input", "change"].forEach(function (t) {
        slider.addEventListener(t, function () {
          if (applied) evt("alpha_change", slider.value, 150);
        });
      });
    }

    var evo = document.getElementById("evoToggle");
    if (evo) {
      evo.addEventListener("click", function () {
        setTimeout(function () {
          evt(window.CommunityEvolution && window.CommunityEvolution.isOpen
              ? "overview_open" : "overview_close");
        }, 50);
      });
    }

    // Node-level interaction. Delegated on the SVG so it survives the re-render
    // that every slice change performs.
    var chart = document.getElementById("chart");
    if (chart) {
      chart.addEventListener("mouseover", function (e) {
        if (!applied) return;
        var d = e.target && d3.select(e.target).datum();
        if (d && d.node !== undefined) evt("node_hover", d.node, 250);
      }, true);

      chart.addEventListener("click", function (e) {
        if (!applied) return;
        var d = e.target && d3.select(e.target).datum();
        if (!d || d.node === undefined) return;
        evt("community_click", d.community);
        captureReactiveAnswer(d);
      }, true);

      chart.addEventListener("wheel", function () {
        if (applied) evt("zoom", null, 500);
      }, { passive: true });
    }

    if (window.EgoSpiral && typeof window.EgoSpiral.show === "function") {
      var realShow = window.EgoSpiral.show;
      window.EgoSpiral.show = function (nodeID) {
        if (applied) evt("ego_open", nodeID);
        return realShow.apply(this, arguments);
      };
    }
    if (typeof window.snapshotCommunityCohort === "function") {
      var realSnap = window.snapshotCommunityCohort;
      window.snapshotCommunityCohort = function (d, opts) {
        handleCommunityPick(d, opts);
        return realSnap.apply(this, arguments);
      };
    }

    // Pointer position inside the frame — see POINTER_MS above for why this
    // cannot be left to reVISit.
    var lastPt = 0;
    document.addEventListener("mousemove", function (e) {
      if (!applied || pointer.length >= POINTER_CAP) return;
      var now = Date.now();
      if (now - lastPt < POINTER_MS) return;
      lastPt = now;
      pointer.push([now - t0, Math.round(e.clientX), Math.round(e.clientY)]);
    }, { passive: true });

    // Shift-click a slice button enters presence-partition compare mode
    // (BarChartPopulator.js:301). That silently changes the visualization
    // mid-trial, so swallow it before it reaches the app's own listener.
    document.addEventListener("click", function (e) {
      var btn = e.target && e.target.closest && e.target.closest(".ts-btn");
      if (btn && e.shiftKey) {
        e.stopImmediatePropagation();
        e.preventDefault();
        evt("blocked_shift_click");
      }
    }, true);
  }

  /* answerMode: "community" | "node" | undefined.
     Undefined means reVISit's own sidebar control carries the answer and the
     tool is only a stimulus. */
  function captureReactiveAnswer(d) {
    if (!cfg || !cfg.answerMode) return;
    if (cfg.answerMode === "community") {
      evt("answer_submit", d.community);
      postAnswer({ answer: String(d.community) });
    } else if (cfg.answerMode === "node") {
      evt("answer_submit", d.node);
      postAnswer({ answer: String(d.node) });
    }
  }

  /* ── viewport guard ────────────────────────────────────────────────────── */

  var hintDismissed = false;

  function checkViewport() {
    if (hintDismissed) return true;
    var tight = window.innerWidth < HINT_W || window.innerHeight < HINT_H;
    root.classList.toggle("study-viewport-tight", tight);
    return true;                       // never blocks: the layout scales
  }

  function wireViewportHint() {
    var el = document.querySelector(".study-toosmall");
    if (!el) return;
    var btn = el.querySelector(".study-toosmall__close");
    if (btn) {
      btn.addEventListener("click", function () {
        hintDismissed = true;
        el.classList.add("study-dismissed");
        evt("viewport_hint_dismissed", window.innerWidth + "x" + window.innerHeight);
      });
    }
    // Record the pane size once per trial regardless — if a result turns out to
    // depend on how much room people had, we want to be able to see that.
    evt("viewport", window.innerWidth + "x" + window.innerHeight);
  }

  /* ── apply the condition ───────────────────────────────────────────────── */

  async function applyCondition() {
    if (applied || !cfg || !appReady) return;
    applied = true;                                  // before awaits: no re-entry

    try {
      await selectDataset(cfg.dataset);
      await selectSlice(cfg.slice);

      if (cfg.labels) root.classList.add("study-labels");
    // A colour ramp with no key is unreadable, and even the categorical scheme
    // needs naming. On by default: a trial must opt OUT, not remember to opt in.
    if (cfg.legend !== false) root.classList.add("study-legend");
    // The dashboard's own sidebar (datasets, ranking, filters) — every control
    // in it is an IV, so only the open-ended insight step asks for it.
    if (cfg.dashboardSidebar) root.classList.add("study-dashboard");
      applyWidgets(cfg.widgets);
      if (cfg.encoding) applyEncoding(cfg.encoding);
      applyAlpha(cfg.alpha);

      await sleep(SETTLE_MS);
      applyHighlight();
      activateWidgets();

      if (window.SpinTrixMainZoom && window.SpinTrixMainZoom.fitAll) {
        window.SpinTrixMainZoom.fitAll(0);
      }
    } catch (err) {
      console.error("[study] failed to apply condition", err);
    }

    checkViewport();
    wireViewportHint();
    root.classList.remove("study-booting");
    t0 = Date.now();                                  // time on task starts now
    log = [];
    pointer = [];
    evt("trial_start", cfg.dataset + "/" + (cfg.slice || "?"));

    if (window.Revisit && Revisit.postReady) Revisit.postReady();
    window.__studyReady = true;                       // headless tests poll this
  }

  /* ── boot ──────────────────────────────────────────────────────────────── */

  if (!window.Revisit) {
    // Opened directly rather than inside reVISit — behave like the normal tool
    // so the build is still debuggable on its own.
    console.warn("[study] Revisit bridge absent; running unmanaged.");
    root.classList.remove("study", "study-booting");
    return;
  }

  Revisit.onDataReceive(function (data) {
    cfg = data || {};
    applyCondition();
  });

  document.addEventListener("dyn:slice-loaded", function first() {
    document.removeEventListener("dyn:slice-loaded", first);
    appReady = true;
    setTimeout(function () {
      instrument();
      applyCondition();
    }, SETTLE_MS);
  });

  window.addEventListener("resize", function () { if (applied) checkViewport(); });

  // If a trial has no reactive answer, reVISit still needs the measures. Post
  // them on unload so slice counts and the alpha path are never lost.
  window.addEventListener("pagehide", function () {
    if (applied && !cfg.answerMode) postAnswer({});
  });

  window.__studyBridge = { measures: measures, config: function () { return cfg; } };
})();
