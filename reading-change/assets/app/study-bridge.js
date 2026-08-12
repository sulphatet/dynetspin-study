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

  /* How often the measures are pushed to reVISit while a trial is in progress.
     They CANNOT be posted once at the end: reVISit saves the answer and unmounts
     the iframe the moment the participant presses Next, and a `pagehide` handler
     posts into a store that has already moved on. The 2026-08-09 pilot is the
     evidence — every trial that did not post during the trial stored no measures
     at all. So the store is kept continuously up to date instead, and whatever
     it holds when Next is pressed is what gets saved. */
  var PUSH_MS = 1500;

  var cfg = null;                  // the trial's `parameters` block
  var appReady = false;            // the tool has rendered at least one slice
  var applied = false;             // guard: apply the condition exactly once
  var log = [];                    // interaction trace, mirrored to reVISit
  var setup = {};                  // what the BRIDGE did before the clock started
  var answerSurface = null;        // which view the last answer came from
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
    /* The alpha IN FORCE, which is not the same as the last one the participant
       chose: someone who never touches the slider still analysed the layout at
       some alpha, and recording null there would drop them from the paired
       comparison that is Block B's headline result. Read it off the control. */
    var sl = document.getElementById("AlphaSlider");
    var alphaNow = sl && sl.value !== "" ? parseFloat(sl.value) : null;
    return {
      sliceChanges: log.filter(function (e) { return e.event === "slice_change"; }).length,
      // USER opens only. The bridge's own auto-open happens before the clock
      // starts and is reported separately as setup.overviewAutoOpened, so
      // "did they reach for it" stays distinguishable from "it was already up".
      overviewOpens: log.filter(function (e) { return e.event === "overview_open"; }).length,
      overviewCloses: log.filter(function (e) { return e.event === "overview_close"; }).length,
      egoOpened: log.some(function (e) { return e.event === "ego_open"; }),
      cohortsAdded: log.filter(function (e) { return e.event === "cohort_add"; }).length,
      communityPicks: log.filter(function (e) { return e.event === "community_pick"; }).length,
      alphaChanges: alphaVals.length,
      alphaSettled: alphaVals.length ? alphaVals[alphaVals.length - 1] : alphaNow,
      alphaMoved: alphaVals.length > 0,
      alphaPath: alphaVals,
      durationMs: Date.now() - t0,
      // [ms since trial start, x, y] inside the stimulus frame
      pointerTrack: pointer,
      pointerSamples: pointer.length,
      pointerTruncated: pointer.length >= POINTER_CAP,
      // "overview" | "chart" | null. Only meaningful where both surfaces can
      // answer (answerMode "overviewCommunity"). For a claim that the whole
      // evolution is one image, whether they answered from the overview or
      // went back to a single slice is a finding, not noise.
      answerSurface: answerSurface,
      setup: setup,
      trace: log
    };
  }

  /* The answer is STICKY and re-sent with every push. It has to be.
     IframeController.tsx handles each ANSWERS message with

         updateResponseBlockValidation({ location: 'stimulus', identifier,
                                         status: true, values: data.message })

     which REPLACES the stimulus block's values rather than merging into them.
     A measures-only push therefore deletes the answer the participant just
     gave — it appeared for a second and vanished — and because `status` stays
     true, the trial could still be submitted, silently, with no answer in it.
     (The sidebar block merges properly, via mergeReactiveAnswers; only this
     one path overwrites.) */
  var lastAnswer = {};

  function postAnswer(extra) {
    if (!window.Revisit || !Revisit.postAnswers) return;
    var k;
    for (k in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, k)) lastAnswer[k] = extra[k];
    }
    var payload = { studyMeasures: measures() };
    for (k in lastAnswer) {
      if (Object.prototype.hasOwnProperty.call(lastAnswer, k)) payload[k] = lastAnswer[k];
    }
    try { Revisit.postAnswers(payload); } catch (e) {}
  }

  /* Keep the store current. Only posts when something has actually been logged
     since the last push, so an idle trial costs one message and no re-renders.
     `answer` is never included, so a push can never overwrite a pick: the merge
     on reVISit's side copies only the keys present in the payload. */
  /* Upper bound on how stale the stored durationMs can be. Every push that
     changes the payload re-renders reVISit's response block, so this is not set
     to zero: reVISit's own endTime-startTime is the authoritative response time
     and durationMs is only the in-frame cross-check. Four seconds keeps the two
     within noise of each other without churning the sidebar form while someone
     is typing into it. */
  var PUSH_STALE_MS = 4000;
  var pushedAt = 0, pushedLen = -1, pushedPts = -1;
  function pushMeasures(force) {
    if (!applied) return;
    // Refresh at least every PUSH_STALE_MS even when nothing was logged, or a
    // participant who reads the frame without moving the pointer inside it
    // records durationMs 0 — reVISit's own timing still covers them, but the
    // in-frame clock should not disagree with it.
    var stale = Date.now() - pushedAt > PUSH_STALE_MS;
    if (!force && !stale && log.length === pushedLen && pointer.length === pushedPts) return;
    pushedAt = Date.now(); pushedLen = log.length; pushedPts = pointer.length;
    postAnswer({});
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

  /* The time rail is navigation. It must not also be a readout.

     BarChartPopulator.js:307-335 hangs a per-slice churn breakdown off every
     `.ts-btn` — a `.ts-mini` stacked bar of Incoming/Outgoing/Transient/Stable,
     a `.ts-hot-dot` on the highest-churn interior slice, and a `title` spelling
     the counts out in words. That is exactly the quantity Block A asks about,
     available identically in all three colour arms, so A/when could be answered
     without ever looking at the visualization. Worse, checked against the
     shipped CSVs the hot dot lands on the first week of the correct answer in
     all three A1 stimuli.

     study-mode.css hides the drawn marks; the titles are set from JS and have
     to be rewritten here. Runs after every slice change, because
     BarChartPopulator rebuilds the rail when the dataset or granularity
     changes. Trials opt IN via `timeRailCues` — only the open-ended insight
     step, which manipulates nothing, does. */
  function stripTimeRailCues() {
    if (cfg && cfg.timeRailCues) return;
    var btns = document.querySelectorAll("#year-buttons .ts-btn, #ts-unfurl .ts-btn");
    for (var i = 0; i < btns.length; i++) {
      var lab = btns[i].dataset ? btns[i].dataset.sliceLabel : null;
      btns[i].title = lab || btns[i].textContent.trim();
      var dot = btns[i].querySelector(".ts-hot-dot");
      if (dot) dot.title = "";
    }
    // The rail's own help bubble still advertises shift-click compare mode,
    // which study-bridge blocks (see blockShiftCompare below).
    var help = document.querySelector("#timeStrip .ts-help");
    if (help) help.title = "";
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
    /* Two different things route through here: using the Cohort Tracker, and
       ANSWERING by clicking a group. Logging both as `cohort_add` made
       cohortsAdded read 1 on every Block B trial, where the tracker is off —
       tracker usage confounded with the answer mechanism. Name them apart. */
    evt((cfg && cfg.widgets && cfg.widgets.cohort) ? "cohort_add" : "community_pick", id);
    if (cfg && cfg.answerMode === "overviewCommunity" &&
        typeof id === "string" && id.indexOf("evo") === 0) {
      // communityEvolution.js labels overview picks "evo<sliceLabel>#<community>"
      var m = /^evo(.*)#(\d+)$/.exec(id);
      if (m) {
        answerSurface = "overview";
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

    /* Same argument as the overview and the tracker, and it was missing here.
       EgoSpiral.show() is reached only by clicking a node on the chart, and the
       study suppresses the `.info-tooltip` that explains the widget — so the
       `ego` arm was "a panel you might discover", which measures
       discoverability rather than whether the widget helps, and makes a null
       result uninterpretable. Open it on the prompt's target. */
    if (cfg.openEgo && cfg.highlightNodes && cfg.highlightNodes.length &&
        window.EgoSpiral && typeof window.EgoSpiral.show === "function") {
      try {
        window.EgoSpiral.show(cfg.highlightNodes[0]);
        window.__studyEgoOpened = document
          .querySelectorAll("#egoSpiralSection .ego-dot, #egoSpiral circle").length;
      } catch (e) { console.error("[study] could not open the ego spiral", e); }
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
      // Outside `applied` too: the rail is rebuilt on every dataset/granularity
      // change, which puts the churn titles straight back.
      stripTimeRailCues();
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
        /* The tool calls this on every node click regardless of the condition;
           the widget is merely display:none when the trial says ego:false. Log
           it only where it is visible, or egoOpened reads true in Block B where
           the participant cannot have seen it. */
        if (applied && cfg && cfg.widgets && cfg.widgets.ego) evt("ego_open", nodeID);
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

  /* answerMode: "community" | "node" | "overviewCommunity" | undefined.
     Undefined means reVISit's own sidebar control carries the answer and the
     tool is only a stimulus.

     "overviewCommunity" used to be handled ONLY in handleCommunityPick, i.e.
     only for a pick originating in the all-slices overview. But the overview
     offers a legitimate drill-down — a ring's year pill calls enterSlice(),
     which closes the overlay and opens that slice on the main chart — and
     #evoToggle is live in that condition, so round-tripping is exactly the
     behaviour the widget invites. A participant who took it, found the bloc on
     the chart and clicked it got NOTHING recorded, and sat in front of a
     required response that would not fill.

     Both surfaces now answer. Which one they used is recorded rather than
     suppressed: for a claim that the whole evolution is one image, "did they
     answer from the overview or go back to the slices" is a result. */
  function captureReactiveAnswer(d) {
    if (!cfg || !cfg.answerMode) return;
    if (cfg.answerMode === "community") {
      evt("answer_submit", d.community);
      postAnswer({ answer: String(d.community) });
    } else if (cfg.answerMode === "node") {
      evt("answer_submit", d.node);
      postAnswer({ answer: String(d.node) });
    } else if (cfg.answerMode === "overviewCommunity") {
      // The chart only ever shows the slice the participant is on, so that is
      // the ring this answer belongs to. export_results.py scores the pair.
      answerSurface = "chart";
      evt("answer_submit", "chart#" + d.community);
      var here = window.currentYearRange;
      // Only carry the slice if we actually know it. Writing "" would clobber a
      // correct answerSlice from an earlier overview pick, and export_results
      // scores the (answer, answerSlice) PAIR.
      var payload = { answer: String(d.community) };
      if (here) payload.answerSlice = String(here);
      postAnswer(payload);
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
    /* Both OFF by default — a trial must opt in. The time rail's churn marks
       answer Block A outright, and the widget help bubbles explain the very
       widget a block is manipulating, so each is a side channel unless the
       trial manipulates nothing. Only the insight step qualifies. */
    if (cfg.timeRailCues)  root.classList.add("study-timerail-cues");
    if (cfg.helpBubbles)   root.classList.add("study-help-bubbles");
    stripTimeRailCues();
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
      /* A single-node prompt ("the outlined person") is one 2px stroke among
         ~600 dots, and finding it is not the task being measured. Block D used
         to solve that by dimming everything else, but the dim rule is
         `opacity !important` while the chart's hover sets opacity INLINE — so
         dimming also disabled the one affordance for seeing WHO the neighbours
         are, which is exactly what Block D now counts.

         Marked instead of dimmed, and NOT framed by the camera:
         zoomToNodeIDs on one node has a zero-area bbox, so its scale clamps to
         the maximum and the participant gets one dot filling the viewport with
         no context at all. The halo is CSS, identical in both arms, and leaves
         the whole picture visible. */
      if (cfg.highlightNodes && cfg.highlightNodes.length) {
        root.classList.add("study-single-target");
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
    lastAnswer = {};                                  // never carry across trials
    answerSurface = null;
    /* Everything above happened during setup and must not be counted as
       participant behaviour — hence the reset. But the analysis still has to
       know what state the trial STARTED in, or "overview never opened" is
       ambiguous between "withheld", "offered and ignored", and "already up". */
    setup = {
      overviewAutoOpened: !!cfg.openOverview,
      overviewHighlighted: window.__studyEvoHighlighted || 0,
      cohortSeeded: !!cfg.seedCohort,
      egoAutoOpened: !!cfg.openEgo,
      egoMarksDrawn: window.__studyEgoOpened || 0,
      cohortRows: window.__studyCohortSeeded || 0,
      alphaStart: (function () {
        var s = document.getElementById("AlphaSlider");
        return s && s.value !== "" ? parseFloat(s.value) : null;
      })(),
      alphaMode: (cfg.alpha && cfg.alpha.mode) || "default",
      widgets: cfg.widgets || {},
      encoding: cfg.encoding || null,
      viewport: [window.innerWidth, window.innerHeight]
    };
    evt("trial_start", cfg.dataset + "/" + (cfg.slice || "?"));

    // First push seeds the store, so even a trial answered instantly and with
    // no interaction still records its duration, setup state and settled alpha.
    pushMeasures(true);
    setInterval(function () { pushMeasures(false); }, PUSH_MS);

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

  /* Belt and braces. The interval above is what actually keeps the store
     current; these only shorten the window between the last push and the
     participant pressing Next. `pagehide` on its own is NOT sufficient — by the
     time it fires reVISit has already saved the answer for this trial. */
  ["pagehide", "blur", "visibilitychange"].forEach(function (t) {
    window.addEventListener(t, function () { pushMeasures(true); });
  });
  document.addEventListener("click", function () {
    setTimeout(function () { pushMeasures(true); }, 0);
  }, true);

  window.__studyBridge = {
    measures: measures,
    config: function () { return cfg; },
    // verify_bridge.js drives these to check the answer survives a later push
    postAnswerForTest: postAnswer,
    pushForTest: function () { pushMeasures(true); },
    // ...and that a main-chart click answers under every answerMode that
    // should accept one, without synthesising a click on an SVG node
    captureForTest: captureReactiveAnswer
  };
})();
