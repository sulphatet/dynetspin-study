/* ─────────────────────────────────────────────────────────────────────────
   Ego Spiral — one node's neighbourhood across every time slice.

   DyNetSpin covers the Network level (the whole spiral) and the Subnetwork
   level (communities, the Cohort Tracker). This is the Individual level:
   "describe the evolution of the ego network of a selected node", "find the
   neighbours present for at least n time steps", "compare ego networks".

   THE WHOLE ENCODING, in one sentence:
     each ring is a time step, each spoke is one neighbour, and the two wedges
     separate neighbours who share this node's community from those who do not.

   Consequences of keeping it to that one sentence:
     • NO lines are drawn between data points. An earlier version connected a
       neighbour's position at t to its position at t+1, which in a node-link
       tool reads as "these two are connected" — it was showing time and being
       read as topology. Identity is now carried by radial alignment instead,
       supported by a faint polar grid that is obviously scaffold.
     • A neighbour missing from a ring simply has no dot there. That covers
       "left", "joined" and "left and came back" without a separate dashed-line
       or ✗ vocabulary.
     • Every dot in this view is connected to the ego — that is what being in
       the view MEANS. So no ego-to-neighbour edges are drawn either; the old
       version drew them for single-slice neighbours only, which implied the
       ego was connected to those and not the rest. Exactly backwards.

   Grouping never compares community ids ACROSS slices. Community ids are not
   stable between slices in this dataset family, so "which community was this
   person in over time" is not a question the labels can answer. The question
   asked instead is answerable one slice at a time: was this neighbour in the
   same community as the EGO, in that slice? A neighbour sits in the "outside"
   wedge when the answer was no in most of the slices they shared. A node whose
   neighbours are mostly outside is a bridge between groups.

   See splitByEgoCommunity() for why this replaced a pairwise "who travels with
   whom" grouping, and what the measurements said about it.

   Data comes entirely from allYearsNodeLinks / allYearsNodeData, already
   loaded for every slice by loadAllYearsData(), so nothing extra is fetched.
   ───────────────────────────────────────────────────────────────────────── */
(function () {
  const VB = 340;               // viewBox side; the SVG scales to its column
  /* The inner ring is kept well away from the pole because EVERY ring carries
     the same number of spokes, so the innermost one is always the binding
     constraint on angular resolution. (An earlier comment here claimed the
     inner ring mattered because early slices hold more neighbours — that was
     wrong: slots are allocated once from the union of all slices and rec.angle
     is fixed across rings, so per-slice degree never affects spacing.) */
  const R_INNER = 62;
  const R_OUTER = 146;
  const WEDGE_GAP = 0.09;       // radians between travel-group wedges
  const MAX_SHOWN = 80;         // legibility budget for very high-degree egos
  const WITH_EGO  = 0.5;        // share of shared slices in the ego's community

  const adjCache = new WeakMap();      // edges array -> Map<nodeId, neighbourIds[]>
  let current = null;                  // last rendered model, for interaction

  function adjacencyFor(label) {
    const edges = (typeof allYearsNodeLinks !== "undefined" && allYearsNodeLinks[label]) || null;
    if (!edges) return null;
    let m = adjCache.get(edges);
    if (m) return m;
    m = new Map();
    edges.forEach(e => {
      const s = +e.source, t = +e.target;
      if (!m.has(s)) m.set(s, []);
      if (!m.has(t)) m.set(t, []);
      m.get(s).push(t);
      m.get(t).push(s);
    });
    adjCache.set(edges, m);
    return m;
  }

  function stateColor(kind) {
    const SC = window.STATE_COLORS || {};
    return { core: SC.stable || "#8C8C8C", left: SC.outgoing || "#E69F00",
             joined: SC.incoming || "#0072B2", gap: SC.both || "#CC79A7" }[kind];
  }

  // The same four states as Local Volatility and the compare view.
  function presenceKind(slices, k) {
    if (slices.length === k) return "core";
    const contiguous = slices.every((v, i) => i === 0 || v === slices[i - 1] + 1);
    if (!contiguous) return "gap";
    if (slices[slices.length - 1] === k - 1) return "joined";
    if (slices[0] === 0) return "left";
    return "gap";
  }

  function nameOf(dicts, id) {
    for (const d of dicts) {
      const e = d[id];
      if (e && e.name && e.name !== "undefined") return e.name;
    }
    return "Node " + id;
  }

  const container = () => d3.select("#egoSpiral");

  function clear() {
    current = null;
    const c = container();
    if (!c.empty())
      c.html('<div class="ego-empty">Hover a node to see its neighbourhood across time.</div>');
  }

  /* ── grouping: one wedge per community IN THE DISPLAYED SLICE ─────────────
     The main chart is a snapshot — a node's spiral is its community in the
     slice on screen. This widget therefore groups by exactly the same thing.
     Anything else makes the two disagree, and measurably so: an earlier
     version put a neighbour in an "inside/outside" wedge by MAJORITY vote over
     all slices, which on Enron contradicted the chart for 88% of nodes (28% of
     all wedge memberships), because a neighbour inside for 3 of 4 slices still
     sits in a different spiral during the 4th. Grouping per slice removes the
     disagreement by construction rather than by annotating around it.

     Community ids are still only ever read WITHIN one slice, so this never
     assumes an id means the same thing from one slice to the next. */

  /* Wedge tints. A patchwork only reads as a patchwork if the patches are few
     and separable, so the palette is capped: the biggest communities get a
     hue each and the tail is pooled. These are light enough to sit under dots
     without competing with them. */
  const WEDGE_COLORS = ["#4E79A7", "#F28E2B", "#59A14F", "#B07AA1",
                        "#76B7B2", "#EDC948"];
  const OTHER_COLOR  = "#9AA0A6";   // pooled tail
  const ABSENT_COLOR = "#C7C9CC";   // not in this slice at all
  const MAX_WEDGES   = WEDGE_COLORS.length;

  function groupByCurrentCommunity(list, sliceComm, egoCommHere, sliceLabel) {
    const byComm = new Map();     // community id -> recs
    const absent = [];
    list.forEach(rec => {
      const c = sliceComm.get(rec.id);
      if (c === undefined) { absent.push(rec); return; }
      if (!byComm.has(c)) byComm.set(c, []);
      byComm.get(c).push(rec);
    });

    /* The ego's own community leads, then the rest by size. Leading means it
       starts at the top of the circle, so the "my own group" block is always
       in the same place no matter which slice you are on. */
    let order = [...byComm.entries()].sort((a, b) =>
      (b[1].length - a[1].length) || (a[0] - b[0]));
    if (egoCommHere !== undefined) {
      const i = order.findIndex(([c]) => c === egoCommHere);
      if (i > 0) order.unshift(order.splice(i, 1)[0]);
    }

    const byTenure = (a, b) => (b.slices.length - a.slices.length) || (a.id - b.id);
    const groups = [], meta = [];
    const named = order.slice(0, MAX_WEDGES);
    const tail  = order.slice(MAX_WEDGES);

    named.forEach(([c, recs], i) => {
      const own = c === egoCommHere;
      recs.sort(byTenure);
      groups.push(recs);
      meta.push({
        kind: own ? "own" : "comm",
        comm: c,
        color: own ? WEDGE_COLORS[0] : WEDGE_COLORS[i % WEDGE_COLORS.length],
        label: (own ? `${nameShort()}'s community` : `Community ${c}`) + ` · ${recs.length}`
      });
    });
    if (tail.length) {
      const pooled = tail.flatMap(([, recs]) => recs).sort(byTenure);
      groups.push(pooled);
      meta.push({ kind: "other", comm: null, color: OTHER_COLOR,
                  label: `${tail.length} other communities · ${pooled.length}` });
    }
    if (absent.length) {
      absent.sort(byTenure);
      groups.push(absent);
      meta.push({ kind: "absent", comm: null, color: ABSENT_COLOR,
                  label: `Not in ${sliceLabel} · ${absent.length}` });
    }
    return { groups, meta };
  }
  let _egoName = "";
  function nameShort() { return _egoName.split(/\s+/).slice(-1)[0] || "ego"; }

  /* ── main entry ───────────────────────────────────────────────────────── */
  function show(nodeID, labelsOpt) {
    const host = container();
    if (host.empty()) return;
    nodeID = +nodeID;

    const labels = (labelsOpt && labelsOpt.length >= 2) ? labelsOpt : (window.currentSlices || []);
    const k = labels.length;
    if (!k || typeof allYearsNodeData === "undefined") { clear(); return; }
    const dicts = labels.map(l => allYearsNodeData[l] || {});

    /* 1 ▸ the neighbourhood, slice by slice */
    const byId = new Map();
    const degree = new Array(k).fill(0);
    const sets = [];
    for (let i = 0; i < k; i++) {
      const adj = adjacencyFor(labels[i]);
      const set = new Set(adj ? (adj.get(nodeID) || []) : []);
      sets.push(set);
      degree[i] = set.size;
      set.forEach(a => {
        if (!byId.has(a)) byId.set(a, { id: a, slices: [], comm: new Map() });
        const rec = byId.get(a);
        rec.slices.push(i);
        const c = dicts[i][a]?.community;
        if (c !== undefined && c !== null && !Number.isNaN(c)) rec.comm.set(i, +c);
      });
    }

    if (!byId.size) {
      host.html(`<div class="ego-empty">${nameOf(dicts, nodeID)} has no recorded neighbours in these slices.</div>`);
      return;
    }

    // Trim for legibility: the most persistent neighbours win. The readout
    // below is computed from the FULL sets, so the numbers stay exact.
    let all = [...byId.values()];
    const total = all.length;
    all.sort((a, b) => (b.slices.length - a.slices.length) || (a.id - b.id));
    const trimmed = all.length > MAX_SHOWN;
    if (trimmed) all = all.slice(0, MAX_SHOWN);

    /* 2 ▸ group by community in the slice the CHART is showing, and give each
       neighbour one angular slot */
    _egoName = nameOf(dicts, nodeID);
    // The chart's slice is the reference. Fall back to the last slice only when
    // there is no current one, so the widget is never grouped by a slice the
    // user cannot see.
    let sliceIdx = labels.indexOf(window.currentYearRange);
    if (sliceIdx < 0) sliceIdx = k - 1;
    const sliceLabel = labels[sliceIdx];
    /* Read the community from the slice's node table directly, NOT from
       rec.comm. rec.comm is only filled for slices where the neighbour was
       ADJACENT to the ego, so a neighbour who is present in this slice but not
       connected to the ego right now would have fallen into the "not in this
       slice" wedge — while the chart happily draws it inside its community's
       spiral. Measured on Enron: 133 of a 145-ego test sample (NOT of the 800
       egos in the dataset — the sample was the first 150 egos with degree >= 5)
       were out of step. Existence in the slice and adjacency to the ego are different
       questions, and only the first one decides which spiral you are in. */
    const sliceComm = new Map();
    all.forEach(rec => {
      const c = dicts[sliceIdx][rec.id]?.community;
      if (c !== undefined && c !== null && !Number.isNaN(c)) sliceComm.set(rec.id, +c);
    });
    const egoRaw = dicts[sliceIdx][nodeID]?.community;
    const egoCommHere = (egoRaw === undefined || egoRaw === null || Number.isNaN(egoRaw))
      ? undefined : +egoRaw;

    const { groups, meta } = groupByCurrentCommunity(all, sliceComm, egoCommHere, sliceLabel);
    const slots = [];                       // flat, in wedge order
    groups.forEach(g => g.forEach(rec => slots.push(rec)));

    const usable = 2 * Math.PI - groups.length * WEDGE_GAP;
    const wedge = [];
    let cursor = -Math.PI / 2, slotIndex = 0;
    groups.forEach((g, gi) => {
      const w = Math.max(usable * g.length / Math.max(slots.length, 1), 0.06);
      wedge.push({ start: cursor, width: w, centre: cursor + w / 2, size: g.length, index: gi });
      g.forEach((rec, j) => {
        rec.angle = cursor + ((j + 0.5) / g.length) * w;
        rec.slot = slotIndex++;
      });
      cursor += w + WEDGE_GAP;
    });

    const radiusAt = i => (k === 1 ? R_OUTER : R_INNER + (i / (k - 1)) * (R_OUTER - R_INNER));

    /* 3 ▸ draw */
    host.html("");
    const svg = host.append("svg")
      .attr("class", "ego-svg")
      .attr("viewBox", `${-VB / 2} ${-VB / 2} ${VB} ${VB}`)
      .attr("preserveAspectRatio", "xMidYMid meet");
    const gWedge = svg.append("g");
    const gGrid  = svg.append("g");
    const gDots  = svg.append("g");
    const gHi    = svg.append("g");

    /* Wedge backgrounds ARE the community encoding now — one tint per community
       in the displayed slice. Colour is set here rather than in CSS because the
       assignment is data-driven (which community is biggest this slice), not a
       fixed set of classes. */
    const wedgeArc = d3.arc()
      .innerRadius(R_INNER - 12).outerRadius(R_OUTER + 6)
      .startAngle(d => d.start + Math.PI / 2)
      .endAngle(d => d.start + d.width + Math.PI / 2);
    wedge.forEach((w, i) => {
      gWedge.append("path")
        .attr("class", "ego-wedge ego-wedge--" + meta[i].kind)
        .attr("d", wedgeArc(w))
        .style("fill", meta[i].color)
        .style("fill-opacity", meta[i].kind === "own" ? 0.20 : 0.12)
        .append("title").text(meta[i].label);
    });

    /* Polar grid. Rings are time; the radial guides are what let a column of
       dots read as one person. Both are drawn at the same scaffold weight so
       neither can be mistaken for data — this is the whole reason no data
       lines are drawn anywhere in this view. */
    /* Every circle here carries a datum. Not because this view needs one, but
       because other code in the app runs document-wide d3.selectAll("circle")
       and dereferences the datum — a data-less circle in the Inspector once
       threw inside the Cohort Tracker's click handler and made it look dead. */
    /* The ring for the slice on screen is drawn heavier and its label bolded.
       The wedges describe THAT slice, so it has to be obvious which one it is —
       otherwise the colours look like a claim about all of time. */
    for (let i = 0; i < k; i++) {
      const active = i === sliceIdx;
      gGrid.append("circle").datum({ ring: i })
        .attr("class", "ego-ring" + (active ? " ego-ring--active" : ""))
        .attr("r", radiusAt(i));
      gGrid.append("text")
        .attr("class", "ego-ring-label" + (active ? " ego-ring-label--active" : ""))
        .attr("x", 0).attr("y", -radiusAt(i) - 3)
        .attr("text-anchor", "middle")
        .text(labels[i]);
    }
    slots.forEach(rec => {
      gGrid.append("line").attr("class", "ego-guide")
        .attr("x1", Math.cos(rec.angle) * (R_INNER - 10))
        .attr("y1", Math.sin(rec.angle) * (R_INNER - 10))
        .attr("x2", Math.cos(rec.angle) * (R_OUTER + 4))
        .attr("y2", Math.sin(rec.angle) * (R_OUTER + 4));
    });

    // dot size follows the busiest ring
    const dotR = Math.max(1.7, Math.min(3.2,
      (2 * Math.PI * R_INNER) / (Math.max(...degree, 1) * 3.4)));

    /* Three marks, and only three:
         dot      connected that slice
         nothing  not connected that slice
         ✕        connected up to here and never again
       Community is NOT encoded on the dot. It was, as a hollow ring, and it
       failed twice over: hollow at r≈1.7 is indistinguishable from filled, and
       it duplicated information the wedge colour now carries outright. */
    slots.forEach(rec => {
      const col = stateColor(presenceKind(rec.slices, k));
      const label = nameOf(dicts, rec.id);
      rec.slices.forEach(i => {
        gDots.append("circle")
          .datum(rec)
          .attr("class", "ego-dot")
          .attr("data-slot", rec.slot)
          .attr("cx", Math.cos(rec.angle) * radiusAt(i))
          .attr("cy", Math.sin(rec.angle) * radiusAt(i))
          .attr("r", dotR)
          .attr("fill", col)
          .append("title")
          .text(`${label} — connected in ${labels[i]}`);
      });

      /* Departure marker at the ring AFTER the last connection. Only for
         neighbours that never come back — a mid-series gap is already legible
         as a missing dot and does not earn a mark of its own. */
      const last = rec.slices[rec.slices.length - 1];
      if (last < k - 1) {
        const r = radiusAt(last + 1), s = dotR + 1.2;
        const x = Math.cos(rec.angle) * r, y = Math.sin(rec.angle) * r;
        const g = gDots.append("g")
          .datum(rec)
          .attr("class", "ego-x")
          .attr("data-slot", rec.slot);
        g.append("line").attr("x1", x - s).attr("y1", y - s).attr("x2", x + s).attr("y2", y + s);
        g.append("line").attr("x1", x - s).attr("y1", y + s).attr("x2", x + s).attr("y2", y - s);
        g.append("title").text(`${label} — last seen in ${labels[last]}, gone after that`);
      }
    });

    gDots.append("circle").datum({ ego: nodeID }).attr("class", "ego-centre").attr("r", 5.5)
      .append("title").text(nameOf(dicts, nodeID));

    /* 4 ▸ interaction: hovering anywhere in a neighbour's wedge lights up that
       whole spoke, which is what makes radial alignment legible. Clicking a
       group freezes it into the Cohort Tracker. */
    /* Legend, because a patchwork is unreadable without one. It also states the
       slice, which is what stops the colours being read as a claim about all
       of time. */
    const legend = host.append("div").attr("class", "ego-legend");
    legend.append("div").attr("class", "ego-legend__head")
      .text(`Communities in ${sliceLabel} — same grouping as the chart`);
    const legRow = legend.append("div").attr("class", "ego-legend__row");
    meta.forEach((m, i) => {
      const item = legRow.append("span")
        .attr("class", "ego-legend__item")
        .attr("data-wedge", i)
        .attr("title", m.kind === "absent"
          ? "Not present in this slice — nothing to track"
          : "Click the wedge to focus it in the Cohort Tracker");
      item.append("span").attr("class", "ego-legend__swatch")
        .style("background", m.color)
        .style("opacity", m.kind === "own" ? 0.55 : 0.35);
      item.append("span").text(m.label);
    });

    /* Wedge and legend entry are the same object shown twice, so hovering
       either one marks both. Without this the patchwork is a colour-matching
       exercise between a tinted arc and a 9px swatch. */
    function markWedge(i, on) {
      legRow.selectAll(".ego-legend__item")
        .classed("ego-legend__item--on", function () {
          return on && +this.getAttribute("data-wedge") === i;
        });
      gWedge.selectAll(".ego-wedge")
        .style("fill-opacity", function (_, j) {
          const base = meta[j].kind === "own" ? 0.20 : 0.12;
          return (on && j === i) ? 0.34 : base;
        });
    }
    gWedge.selectAll(".ego-wedge")
      .on("mouseenter", function () {
        markWedge(gWedge.selectAll(".ego-wedge").nodes().indexOf(this), true);
      })
      .on("mouseleave", () => markWedge(-1, false));
    legRow.selectAll(".ego-legend__item")
      .on("mouseenter", function () { markWedge(+this.getAttribute("data-wedge"), true); })
      .on("mouseleave", () => markWedge(-1, false));

    const caption = host.append("div").attr("class", "ego-caption");
    const defaultCaption = `${slots.length} neighbours across ${k} slices. `
      + `Wedge = community in ${sliceLabel}; ring = time; dot = connected. `
      + `Click a wedge to track it, the centre for the whole neighbourhood.`;
    caption.text(defaultCaption);

    svg.on("mousemove", function (event) {
      const [mx, my] = d3.pointer(event, svg.node());
      const r = Math.hypot(mx, my);
      if (r < R_INNER - 14 || r > R_OUTER + 8) return hoverOff();
      let a = Math.atan2(my, mx);
      // nearest slot by angle
      let best = null, bestD = Infinity;
      slots.forEach(rec => {
        // Angular distance, wrapped: 0 when the cursor is on the spoke, π when
        // it is on the antipode. It is already a distance — do not invert it.
        const d = Math.abs(((rec.angle - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        if (d < bestD) { bestD = d; best = rec; }
      });
      if (!best || bestD > 0.12) return hoverOff();
      hoverOn(best);
    }).on("mouseleave", hoverOff);

    function hoverOn(rec) {
      if (current && current.hovered === rec.slot) return;
      hoverOff();
      if (current) current.hovered = rec.slot;
      gHi.append("line").attr("class", "ego-guide--on")
        .attr("x1", Math.cos(rec.angle) * (R_INNER - 10))
        .attr("y1", Math.sin(rec.angle) * (R_INNER - 10))
        .attr("x2", Math.cos(rec.angle) * (R_OUTER + 4))
        .attr("y2", Math.sin(rec.angle) * (R_OUTER + 4));
      gDots.selectAll(".ego-dot, .ego-x").classed("ego-dot--dim", function () {
        return +this.getAttribute("data-slot") !== rec.slot;
      });
      /* The wedge only speaks for the displayed slice, so the caption is where
         a neighbour's community history over time lives — as text, which cannot
         be confused with the wedge's claim about now. */
      const present = rec.slices.map(i => {
        const c = rec.comm.get(i);
        return c === undefined ? labels[i] : `${labels[i]} (c${c})`;
      }).join(", ");
      const last = rec.slices[rec.slices.length - 1];
      const gone = last < k - 1 ? ` — gone after ${labels[last]}` : "";
      caption.html(`<b>${nameOf(dicts, rec.id)}</b> — connected in ${present}${gone}`);
    }
    function hoverOff() {
      if (current) current.hovered = null;
      gHi.selectAll("*").remove();
      gDots.selectAll(".ego-dot, .ego-x").classed("ego-dot--dim", false);
      caption.text(defaultCaption);
    }

    /* What a click freezes is always an EGO NETWORK — this node plus a set of
       its neighbours — never a bare bag of neighbours. Kale et al. 2023 put
       "compare the evolutionary patterns of ego networks of selected egos"
       (Table 2, Individual × Comparison) at this level, and the Tracker's three
       slots are exactly that comparison surface. A card without its ego in it
       cannot answer that question. The wedge only narrows WHICH neighbours. */
    /* A card is always ONE EGO'S NETWORK — the ego plus every neighbour present
       in this slice. The Tracker's three slots are for comparing different
       people's networks (Kale et al. Table 2, Individual × Comparison:
       Skilling vs Lay, Keim vs Ma), so spending them on subsets of one person
       is the wrong unit — five wedges used to evict every other ego after three
       clicks.

       A wedge therefore does not create a card. It focuses the card this ego
       already owns; only if the ego is not yet tracked does the click also
       create it. Same click, two outcomes, and the slot count is untouched. */
    function trackEgo(focus) {
      if (typeof window.snapshotCommunityCohort !== "function") return;
      if (focus && typeof window.focusTrackedEgo === "function"
          && window.focusTrackedEgo(nodeID, focus)) return;   // absorbed
      window.snapshotCommunityCohort(null, {
        nodeIds: [nodeID, ...slots.map(r => r.id)],
        id: `ego${nodeID}`,                    // identity is the EGO, not the wedge
        label: `Ego: ${_egoName}`,
        egoID: nodeID,
        focus: focus || null
      });
    }

    gWedge.selectAll(".ego-wedge")
      // "Not in this slice" members cannot appear in a current-slice snapshot,
      // so that wedge is not a control — saying so beats a card of one node.
      .style("cursor", (_, i) => meta[i].kind === "absent" ? "default" : "pointer")
      .on("click", function () {
        const gi = gWedge.selectAll(".ego-wedge").nodes().indexOf(this);
        if (!groups[gi] || meta[gi].kind === "absent") return;
        trackEgo({
          key: `${sliceLabel}:${meta[gi].kind}:${meta[gi].comm}`,
          label: `${meta[gi].label.split(" · ")[0]} (${groups[gi].length})`,
          ids: groups[gi].map(r => r.id)
        });
      });

    // The centre is the ego: track the whole neighbourhood, unfocused.
    gDots.select(".ego-centre")
      .style("cursor", "pointer")
      .on("click", () => trackEgo(null));

    /* 5 ▸ readout — computed from the untrimmed sets, so it stays exact even
       when the drawing is capped. "kept" is the Jaccard overlap with the
       previous slice, not a one-directional retention rate. */
    const rows = [];
    for (let i = 0; i < k; i++) {
      const prev = i > 0 ? sets[i - 1] : null;
      let gained = 0, lost = 0, jac = null;
      if (prev) {
        sets[i].forEach(a => { if (!prev.has(a)) gained++; });
        prev.forEach(a => { if (!sets[i].has(a)) lost++; });
        const union = new Set([...prev, ...sets[i]]).size;
        jac = union ? (prev.size + sets[i].size - union) / union : 0;
      }
      rows.push(`<tr><td>${labels[i]}</td><td>${degree[i]}</td>
                 <td>${prev ? "+" + gained : "—"}</td>
                 <td>${prev ? "−" + lost : "—"}</td>
                 <td>${jac === null ? "—" : (jac * 100).toFixed(0) + "%"}</td></tr>`);
    }
    host.append("div").attr("class", "ego-readout").html(
      `<div class="ego-title">${nameOf(dicts, nodeID)}</div>
       <table class="ego-table">
         <thead><tr><th>slice</th><th>deg</th><th>new</th><th>lost</th><th>overlap</th></tr></thead>
         <tbody>${rows.join("")}</tbody>
       </table>
       ${trimmed ? `<div class="ego-note">showing the ${MAX_SHOWN} most persistent of ${total} neighbours</div>` : ""}`);

    current = { nodeID, hovered: null };
  }

  /* The wedges describe one slice, so moving to another slice invalidates them.
     Called from the slice loader after the chart is rebuilt, which is what
     guarantees the two views can never be showing different slices. */
  function refresh() {
    if (current && current.nodeID != null) show(current.nodeID);
  }

  window.EgoSpiral = { show, clear, refresh };

  // Show the affordance rather than an empty box before the first hover.
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", clear);
  else clear();
})();
