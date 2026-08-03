/*
 * Mermaid companion script.
 *
 * Material for MkDocs owns Mermaid initialization: when it mounts a diagram it
 * calls `mermaid.initialize({ startOnLoad: false, themeCSS, sequence })` itself
 * and renders into a shadow root. A second `mermaid.initialize()` call from this
 * file would be a competing initializer racing the theme's, so this file
 * deliberately does not configure Mermaid at all. Leaving Mermaid's own default
 * `securityLevel` in place also keeps it at "strict" rather than the "loose"
 * value this file used to force, which is the setting the Mermaid advisories
 * name as the one that disables their mitigations.
 *
 * What this file is for is the failure path. The runtime is fetched from a CDN,
 * so it can be absent - offline, behind a restrictive proxy, or blocked by an
 * enterprise policy. When that happens the theme silently leaves the raw
 * Mermaid source text in place: horizontally truncated monospace DSL where a
 * picture should be, with no explanation, and with the diagram's `accTitle` and
 * `accDescr` never reaching the accessibility tree because no SVG is ever
 * created. This script converts that into an honest, announced, properly named
 * fallback that still exposes the diagram's own description.
 *
 * It never references a bare `mermaid` identifier, so it cannot throw the
 * `ReferenceError` that the previous version threw on every page load whenever
 * the runtime failed to load.
 *
 * Finding the blocks is the whole difficulty, and it is a race. The theme's
 * bundle is not deferred, so it runs during parsing and subscribes to
 * `document$` first; its mount function's very first statement is
 * `element.classList.remove("mermaid")`, and it runs that whether or not the
 * runtime ever arrives. Any subscriber that looks for `pre.mermaid` after that
 * point - this file's previous version did - finds nothing and the fallback
 * never appears. Three independent identifications are therefore used, in the
 * order they become reliable:
 *
 *   1. At this script's own execution time. Deferred scripts run after parsing
 *      but before `DOMContentLoaded`, which is when the theme's `document$`
 *      first emits, so `pre.mermaid` is still intact here on a full page load.
 *   2. The `.cec-diagram` wrapper, which is authored around each diagram on the
 *      migration mapping page and survives everything the theme does.
 *   3. A `pre` whose class attribute is present but empty - the exact signature
 *      the theme's `classList.remove` leaves behind - whose source begins with
 *      a Mermaid diagram keyword. This is what covers pages without wrappers
 *      when they are reached by instant navigation, where the theme's
 *      subscriber has already run before this one.
 */
(function () {
  "use strict";

  /* Long enough for a multi-megabyte CDN bundle on a slow link, short enough
   * that a reader is not left staring at an empty box. */
  var GRACE_PERIOD_MS = 12000;

  var PENDING_ATTR = "data-rdk-mermaid-pending";
  var DONE_ATTR = "data-rdk-mermaid-fallback";

  /* Diagram keywords Mermaid accepts as the first meaningful line of a graph.
   * Used only to confirm that an already de-classed `pre` really is a diagram. */
  var DIAGRAM_KEYWORD = new RegExp(
    "^(flowchart|graph|sequenceDiagram|classDiagram(-v2)?|stateDiagram(-v2)?|" +
      "erDiagram|journey|gantt|pie|mindmap|timeline|gitGraph|quadrantChart|" +
      "requirementDiagram|C4Context|C4Container|C4Component|C4Dynamic|" +
      "sankey-beta|block-beta|xychart-beta|packet-beta|architecture-beta)\\b"
  );

  var timer = null;

  /** Read `accTitle:` / `accDescr:` out of a Mermaid source block. */
  function readAccessibleText(source) {
    var result = { title: "", description: "" };
    var lines = String(source).split("\n");
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!result.title && line.indexOf("accTitle:") === 0) {
        result.title = line.slice("accTitle:".length).trim();
      } else if (!result.description && line.indexOf("accDescr:") === 0) {
        result.description = line.slice("accDescr:".length).trim();
      }
    }
    return result;
  }

  /**
   * Does this text read as Mermaid source?
   *
   * Leading init directives, `%%` comments and blank lines are skipped, then the
   * first meaningful line must start with a diagram keyword.
   */
  function looksLikeMermaid(source) {
    var lines = String(source).split("\n");
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line || line.indexOf("%%") === 0) {
        continue;
      }
      return DIAGRAM_KEYWORD.test(line);
    }
    return false;
  }

  /** Mark one block as a diagram that is still waiting to be drawn. */
  function mark(block) {
    if (
      block.getAttribute(DONE_ATTR) === "1" ||
      block.getAttribute(PENDING_ATTR) === "1" ||
      block.querySelector("svg")
    ) {
      return;
    }
    block.setAttribute(PENDING_ATTR, "1");
  }

  /** Apply all three identifications that are valid at the time of the call. */
  function markPending() {
    var i;

    /* 1 + 2: the class while it still exists, and the authored wrapper. */
    var certain = document.querySelectorAll(
      "pre.mermaid, .cec-diagram > pre, .cec-diagram > div.mermaid > pre"
    );
    for (i = 0; i < certain.length; i++) {
      mark(certain[i]);
    }

    /* 3: a block the theme has already de-classed, confirmed by its source. */
    var candidates = document.querySelectorAll('pre[class=""]');
    for (i = 0; i < candidates.length; i++) {
      if (looksLikeMermaid(candidates[i].textContent || "")) {
        mark(candidates[i]);
      }
    }
  }

  /**
   * Replace an unrendered diagram with a labelled, announced fallback.
   *
   * The diagram source is kept - it is the only remaining representation of the
   * content - but it is moved into a named, scrollable region so that keyboard
   * users can reach it and screen-reader users are told what it is.
   */
  function renderFallback(block) {
    if (block.getAttribute(DONE_ATTR) === "1") {
      return;
    }
    block.setAttribute(DONE_ATTR, "1");

    var source = block.textContent || "";
    var accessible = readAccessibleText(source);
    var label = accessible.title
      ? "Diagram source: " + accessible.title
      : "Diagram source";

    var notice = document.createElement("p");
    notice.className = "rdk-mermaid-fallback__notice";
    notice.setAttribute("role", "alert");
    notice.textContent = accessible.title
      ? "This diagram could not be drawn because the diagram runtime is " +
        "unavailable. Its content is described below, followed by its source. " +
        "Diagram: " +
        accessible.title +
        "."
      : "This diagram could not be drawn because the diagram runtime is " +
        "unavailable. Its source is shown below.";

    /*
     * Group the fallback. Where the page authored a `.cec-diagram` wrapper that
     * is the right container; where it did not, `block.parentNode` is the whole
     * `<article>`, and marking that as the fallback would frame the entire page
     * with the error treatment instead of the one diagram - so generate a
     * wrapper around the block and use that.
     */
    var parent = block.parentNode;
    if (!parent) {
      return;
    }
    var container;
    if (parent.classList && parent.classList.contains("cec-diagram")) {
      container = parent;
    } else {
      container = document.createElement("div");
      parent.insertBefore(container, block);
      container.appendChild(block);
    }
    container.classList.add("rdk-mermaid-fallback");
    container.insertBefore(notice, block);

    if (accessible.description) {
      var description = document.createElement("p");
      description.className = "rdk-mermaid-fallback__description";
      description.textContent = accessible.description;
      container.insertBefore(description, block);
    }

    /*
     * The source is long and wide: make the region reachable and scrollable.
     *
     * Dropping the pending mark is what reveals it - while a diagram is still
     * expected, the stylesheet keeps the source out of the reserved box. The
     * `mermaid` class goes too: the theme puts that class back on the block when
     * it re-mounts the content during an in-page navigation, and while it is
     * there the same stylesheet rule would hide the source again - leaving a
     * notice that promises a source listing above nothing at all. The
     * stylesheet also excludes `[data-rdk-mermaid-fallback]` from that rule, so
     * the source stays visible however many times the class comes back.
     */
    block.classList.remove("mermaid");
    block.removeAttribute(PENDING_ATTR);
    block.setAttribute("role", "region");
    block.setAttribute("aria-label", label);
    block.setAttribute("tabindex", "0");
  }

  /** Diagram blocks on this page that have not been replaced by an SVG. */
  function unrenderedBlocks() {
    return Array.prototype.filter.call(
      document.querySelectorAll("pre.mermaid, pre[" + PENDING_ATTR + '="1"]'),
      function (block) {
        return !block.querySelector("svg");
      }
    );
  }

  function check() {
    timer = null;
    var blocks = unrenderedBlocks();
    for (var i = 0; i < blocks.length; i++) {
      renderFallback(blocks[i]);
    }
  }

  function schedule() {
    markPending();
    if (!document.querySelector("pre[" + PENDING_ATTR + '="1"]')) {
      return;
    }
    if (timer !== null) {
      window.clearTimeout(timer);
    }
    timer = window.setTimeout(check, GRACE_PERIOD_MS);
  }

  /* Identification 1 has to happen now, while the class is still on the block. */
  markPending();

  if (typeof window.document$ !== "undefined" && window.document$.subscribe) {
    window.document$.subscribe(schedule);
  } else if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", schedule);
  } else {
    schedule();
  }
})();
