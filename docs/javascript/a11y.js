/*
 * Accessibility and interaction hardening for the RDK Hardware Porting Kit
 * documentation site.
 *
 * Material for MkDocs drives its drawer, table-of-contents and search panels
 * from hidden checkboxes that are toggled by `<label>` proxies.  A `<label>`
 * exposes no interactive role and is not in the tab order, the panels stay in
 * the accessibility tree and the tab order while closed, and the search result
 * list is never cleared when the query is reset.  That combination leaves
 * keyboard and screen-reader users unable to operate mobile navigation, able to
 * tab into off-canvas content they cannot see, and looking at stale results
 * after pressing "Clear".
 *
 * This file is a progressive-enhancement layer over the stock theme.  It adds
 * no new UI and changes no visual design; it only supplies the semantics,
 * keyboard handling and state hygiene the underlying pattern is missing:
 *
 *   1. Toggle proxies become real, named, keyboard-operable buttons that report
 *      their expanded state - but only while they are actually visible, so no
 *      invisible tab stop is ever introduced.
 *   2. Purely decorative click-away overlays are hidden from assistive
 *      technology.
 *   3. Closed drawer and search panels are made inert and untabbable, so focus
 *      can no longer travel into off-canvas or zero-height content.
 *   4. Opening the drawer moves focus into it, traps Tab inside it, and Escape
 *      closes it and restores focus to the control that opened it.
 *   5. Resetting search clears the result count, the result cards and the
 *      highlight marks, and returns focus to the search field.
 *   6. A search index that never finishes loading reports a visible, announced
 *      error instead of sitting silently on "Initializing search".
 *   7. Horizontally scrollable content regions become keyboard reachable and
 *      scroll a focused descendant *fully* into view rather than partially.
 *   8. Following a deep link moves focus to the target heading, which keeps the
 *      URL fragment, `:target`, the table-of-contents highlight and the visible
 *      heading in agreement after reloads and history traversal.
 *
 * Every step feature-detects what it touches and is idempotent, because
 * Material re-emits `document$` on every instant-navigation page swap.
 */
(function () {
  "use strict";

  /* ----------------------------------------------------------------------- *
   * Utilities
   * ----------------------------------------------------------------------- */

  var FOCUSABLE = [
    "a[href]",
    "button:not([disabled])",
    "input:not([disabled]):not([type=hidden])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "summary",
    "[tabindex]:not([tabindex='-1'])"
  ].join(",");

  var SUPPORTS_INERT = "inert" in HTMLElement.prototype;

  /** Read the theme configuration block, which carries the UI translations. */
  function readConfig() {
    var el = document.getElementById("__config");
    if (!el) {
      return {};
    }
    try {
      return JSON.parse(el.textContent) || {};
    } catch (err) {
      return {};
    }
  }

  var CONFIG = readConfig();
  var STRINGS = CONFIG.translations || {};

  /**
   * Mark an element as having had a given enhancement applied, returning false
   * when it was already marked. Keeps every step safe to re-run on each
   * instant-navigation page swap.
   */
  function claim(el, key) {
    var attr = "data-rdk-" + key;
    if (!el || el.getAttribute(attr) === "1") {
      return false;
    }
    el.setAttribute(attr, "1");
    return true;
  }

  /** True when the element occupies space and can therefore be operated. */
  function isVisible(el) {
    if (!el) {
      return false;
    }
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }

  /** Collect the focusable descendants of a container, in document order. */
  function focusableWithin(container) {
    if (!container) {
      return [];
    }
    return Array.prototype.filter.call(
      container.querySelectorAll(FOCUSABLE),
      isVisible
    );
  }

  /**
   * The first focusable descendant that is safe to give initial focus to.
   *
   * A panel opened by a `<label>` proxy usually contains a second proxy for the
   * same toggle - the drawer's own title doubles as its close control. Focusing
   * that on open is unsafe: the theme's global Enter handler activates whatever
   * has focus, so the very keystroke that opened the panel would immediately
   * click the close proxy and shut it again. Skip any proxy for the same toggle
   * when choosing the entry point, while still leaving it inside the Tab cycle.
   */
  function firstEntryPoint(items, toggle) {
    var fallback = null;
    for (var i = 0; i < items.length; i++) {
      var candidate = items[i];
      if (
        toggle &&
        candidate.tagName === "LABEL" &&
        candidate.getAttribute("for") === toggle.id
      ) {
        continue;
      }
      if (!fallback) {
        fallback = candidate;
      }
      /*
       * Prefer a candidate that is actually the topmost element at its own
       * centre. A candidate that another element is painted over would receive
       * focus with no perceivable focus indicator.
       */
      if (isTopmost(candidate)) {
        return candidate;
      }
    }
    return fallback;
  }

  /** True when the element is the hit-test result at its own centre point. */
  function isTopmost(el) {
    var box = el.getBoundingClientRect();
    if (!box.width || !box.height) {
      return false;
    }
    var x = box.left + box.width / 2;
    var y = box.top + box.height / 2;
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
      return false;
    }
    var hit = document.elementFromPoint(x, y);
    return !!hit && (hit === el || el.contains(hit));
  }

  /**
   * Remove a subtree from the tab order and the accessibility tree. `inert`
   * does both in one step where it is available; otherwise fall back to
   * `aria-hidden` plus explicit tabindex removal so the behaviour still holds.
   */
  function deactivate(el) {
    if (!el) {
      return;
    }
    if (SUPPORTS_INERT) {
      el.inert = true;
    }
    el.setAttribute("aria-hidden", "true");
    Array.prototype.forEach.call(el.querySelectorAll(FOCUSABLE), function (node) {
      if (!node.hasAttribute("data-rdk-tabindex")) {
        node.setAttribute(
          "data-rdk-tabindex",
          node.hasAttribute("tabindex") ? node.getAttribute("tabindex") : ""
        );
      }
      node.setAttribute("tabindex", "-1");
    });
  }

  /** Reverse `deactivate`, restoring any tabindex value it displaced. */
  function activate(el) {
    if (!el) {
      return;
    }
    if (SUPPORTS_INERT) {
      el.inert = false;
    }
    el.removeAttribute("aria-hidden");
    Array.prototype.forEach.call(
      el.querySelectorAll("[data-rdk-tabindex]"),
      function (node) {
        var previous = node.getAttribute("data-rdk-tabindex");
        node.removeAttribute("data-rdk-tabindex");
        if (previous === "") {
          node.removeAttribute("tabindex");
        } else {
          node.setAttribute("tabindex", previous);
        }
      }
    );
  }

  /** Move focus without letting the browser perform its own scroll jump. */
  function focusQuietly(el) {
    if (!el) {
      return;
    }
    try {
      el.focus({ preventScroll: true });
    } catch (err) {
      el.focus();
    }
  }

  /* ----------------------------------------------------------------------- *
   * 1. Toggle proxies become real buttons
   * ----------------------------------------------------------------------- */

  /** Rendered text of an element, whitespace-collapsed. */
  function visibleText(el) {
    if (!el) {
      return "";
    }
    var text = el.innerText;
    if (typeof text !== "string" || !text) {
      text = el.textContent || "";
    }
    return text.replace(/\s+/g, " ").trim();
  }

  /**
   * A `<label for="…">` only *acts* as a control at the breakpoints where the
   * theme wires it to something. The text-bearing proxies - the drawer title
   * and the table-of-contents row - are controls only while the navigation is
   * the off-canvas drawer. At wide viewports the very same elements are the
   * sidebars' static headings, so enhancing them there would put a decorative
   * heading in the tab order, give it an accessible name that contradicts its
   * visible text (WCAG 2.5.3 Label in Name) and advertise an 18px "target" that
   * no pointer user can act on.
   *
   * Icon-only proxies render no text and are controls at every breakpoint, so
   * they are never decorative.
   */
  function isDecorativeProxy(label) {
    return !!visibleText(label) && !drawerIsOffCanvas();
  }

  /**
   * Remember the name the theme itself gave the proxy, once, before the first
   * enhancement overwrites it. Memoising is what keeps repeated syncs
   * idempotent: without it, each pass would prefix the previous pass's result.
   */
  function nativeProxyPurpose(label) {
    var stashed = label.getAttribute("data-rdk-purpose");
    if (stashed === null) {
      stashed = (label.getAttribute("aria-label") || "").trim();
      label.setAttribute("data-rdk-purpose", stashed);
    }
    return stashed;
  }

  /** Return the element to exactly the semantics the theme built it with. */
  function demoteToggleProxy(label) {
    var native = nativeProxyPurpose(label);
    label.removeAttribute("role");
    label.removeAttribute("aria-controls");
    label.removeAttribute("aria-expanded");
    label.removeAttribute("tabindex");
    if (native) {
      label.setAttribute("aria-label", native);
    } else {
      label.removeAttribute("aria-label");
    }
  }

  /**
   * Compose the accessible name. WCAG 2.5.3 requires the accessible name to
   * contain the visible label text, so a proxy that renders text is named
   * "<visible text>, <purpose>" instead of by purpose alone - naming it by
   * purpose alone is what made the sidebar heading, whose visible text reads
   * "RDK Hardware Porting Kit", report an accessible name of "Navigation menu".
   */
  function proxyName(label, purpose) {
    var text = visibleText(label);
    if (!text) {
      return purpose;
    }
    if (!purpose || text.toLowerCase().indexOf(purpose.toLowerCase()) !== -1) {
      return text;
    }
    return text + ", " + purpose.charAt(0).toLowerCase() + purpose.slice(1);
  }

  /**
   * Give every `<label for="…">` that drives a hidden toggle checkbox the
   * semantics of the button it visually is - but only where it really is one.
   * Tabbability tracks visibility, so a control that is hidden at the current
   * breakpoint never becomes a phantom tab stop.
   */
  function enhanceToggleProxy(label, toggle, name, controls) {
    if (!label || !toggle) {
      return;
    }
    /*
     * Hidden and decorative proxies are demoted rather than merely untabbed: a
     * zero-sized `role="button"` is still announced by assistive technology,
     * and a resize can cross the drawer breakpoint in either direction.
     */
    if (!isVisible(label) || isDecorativeProxy(label)) {
      demoteToggleProxy(label);
      return;
    }
    if (claim(label, "toggle")) {
      label.addEventListener("keydown", function (event) {
        if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") {
          return;
        }
        event.preventDefault();
        /*
         * Claim the keystroke. The theme also installs a global Enter handler
         * that clicks whatever label currently has focus, so an unclaimed Enter
         * would toggle the checkbox a second time within the same dispatch and
         * close the panel again the instant it opened.
         */
        event.stopImmediatePropagation();
        toggle.checked = !toggle.checked;
        toggle.dispatchEvent(new Event("change", { bubbles: true }));
      });
    }
    label.setAttribute("role", "button");
    label.setAttribute("aria-label", proxyName(label, nativeProxyPurpose(label) || name));
    if (controls) {
      label.setAttribute("aria-controls", controls);
    }
    label.setAttribute("aria-expanded", toggle.checked ? "true" : "false");
    label.setAttribute("tabindex", "0");
    /*
     * The theme nests an unrendered logo link inside the drawer title. A
     * focusable descendant of a button is both an ARIA violation and an
     * invisible tab stop, so anything unrendered inside the proxy is taken out
     * of the tab order.
     */
    Array.prototype.forEach.call(
      label.querySelectorAll("a[href], button, input, select, textarea"),
      function (child) {
        if (!isVisible(child)) {
          child.setAttribute("tabindex", "-1");
        }
      }
    );
  }

  /** Keep every proxy of a given toggle in sync with the toggle's state. */
  function syncToggleProxies(toggle, name, controls) {
    if (!toggle) {
      return;
    }
    var labels = document.querySelectorAll('label[for="' + toggle.id + '"]');
    Array.prototype.forEach.call(labels, function (label) {
      /* Click-away overlays are decorative duplicates of a real control. */
      if (
        label.classList.contains("md-overlay") ||
        label.classList.contains("md-search__overlay")
      ) {
        if (claim(label, "overlay")) {
          label.setAttribute("aria-hidden", "true");
        }
        return;
      }
      enhanceToggleProxy(label, toggle, name, controls);
    });
  }

  /* ----------------------------------------------------------------------- *
   * 2. Search: naming, state hygiene, focus management
   * ----------------------------------------------------------------------- */

  var searchInitializerText = null;
  var searchWatchdog = null;

  function searchPlaceholder() {
    return STRINGS["search.result.placeholder"] || "Type to start searching";
  }

  /** Clear the result count, the result cards and every highlight mark. */
  function resetSearchResults(search) {
    var meta = search.querySelector(".md-search-result__meta");
    var list = search.querySelector(".md-search-result__list");
    if (meta) {
      meta.textContent = searchPlaceholder();
    }
    if (list) {
      while (list.firstChild) {
        list.removeChild(list.firstChild);
      }
    }
    var wrap = search.querySelector(".md-search__scrollwrap");
    if (wrap) {
      wrap.scrollTop = 0;
    }
    /* Highlights are injected into the article, not into the search panel. */
    var article = document.querySelector("[data-md-component=content]");
    if (article) {
      Array.prototype.forEach.call(article.querySelectorAll("mark"), function (mark) {
        var parent = mark.parentNode;
        if (!parent) {
          return;
        }
        while (mark.firstChild) {
          parent.insertBefore(mark.firstChild, mark);
        }
        parent.removeChild(mark);
        parent.normalize();
      });
    }
  }

  /** Reflect the open/closed state of the search panel in the DOM. */
  function syncSearchState(search, toggle) {
    var output = search.querySelector(".md-search__output");
    var wrap = search.querySelector(".md-search__scrollwrap");
    if (toggle.checked) {
      activate(output);
      if (wrap) {
        wrap.setAttribute("tabindex", "0");
      }
    } else {
      deactivate(output);
      /* A zero-height scroll container must never be a tab stop. */
      if (wrap) {
        wrap.setAttribute("tabindex", "-1");
      }
    }
  }

  /**
   * Surface a visible, announced error when the search index never arrives.
   * The theme renders the "initializer" string server-side and swaps it for the
   * placeholder once the worker is ready, so an unchanged string after the
   * grace period means the index failed to load.
   */
  function armSearchWatchdog(search) {
    if (searchWatchdog !== null) {
      return;
    }
    var meta = search.querySelector(".md-search-result__meta");
    if (!meta || searchInitializerText === null) {
      return;
    }
    searchWatchdog = window.setTimeout(function () {
      var current = (meta.textContent || "").trim();
      if (current !== searchInitializerText) {
        return;
      }
      meta.setAttribute("role", "alert");
      meta.classList.add("rdk-search-error");
      meta.textContent =
        "Search is unavailable: the search index could not be loaded. " +
        "Reload the page to try again, or browse using the navigation menu.";
    }, 20000);
  }

  /**
   * "Share" and "Clear" belong in the tab order only while they are
   * perceivable. The theme reveals them with `opacity: 1; transform: scale(1)`
   * exclusively while the panel is open *and* the query field is non-empty
   * (`:checked ~ .md-header .md-search__input:valid ~ .md-search__options`);
   * until then they are zero-opacity 18px ghosts, positioned off-canvas
   * entirely at narrow widths, so an unconditional tab stop lands focus on
   * something the user cannot see, with a focus ring that inherits opacity 0.
   */
  function syncSearchOptions(search) {
    var toggle = document.getElementById("__search");
    var input = search.querySelector("[data-md-component=search-query]");
    var revealed = !!(toggle && toggle.checked && input && input.value.length > 0);
    Array.prototype.forEach.call(
      search.querySelectorAll(".md-search__options > *"),
      function (option) {
        option.setAttribute("tabindex", revealed ? "0" : "-1");
      }
    );
  }

  /**
   * Every search result reproduces the heading elements of the page it points
   * at, so an open result panel can add a second `<h1>` and dozens of duplicate
   * headings to this document's outline. Demoting the copies to level 2 keeps
   * heading-based navigation inside the panel intact while leaving the page
   * with exactly one level-1 heading. Results are re-rendered on every
   * keystroke, so the demotion is driven by an observer rather than a timer.
   */
  function demoteSearchResultHeadings(search) {
    Array.prototype.forEach.call(
      search.querySelectorAll(".md-search-result h1"),
      function (heading) {
        if (claim(heading, "demoted")) {
          heading.setAttribute("role", "heading");
          heading.setAttribute("aria-level", "2");
        }
      }
    );
  }

  function observeSearchResults(search) {
    var list = search.querySelector(".md-search-result__list");
    if (!list || !window.MutationObserver || !claim(list, "observed")) {
      return;
    }
    demoteSearchResultHeadings(search);
    new window.MutationObserver(function () {
      demoteSearchResultHeadings(search);
    }).observe(list, { childList: true, subtree: true });
  }

  function enhanceSearch() {
    var search = document.querySelector("[data-md-component=search]");
    var toggle = document.getElementById("__search");
    if (!search || !toggle) {
      return;
    }

    var input = search.querySelector("[data-md-component=search-query]");
    var accessibleName =
      (input && input.getAttribute("aria-label")) || "Search";

    if (!search.id) {
      search.id = "rdk-search";
    }

    if (claim(search, "search")) {
      /* A dialog and a landmark both need an accessible name. */
      search.setAttribute("aria-label", accessibleName);
      var inner = search.querySelector('[role="search"]');
      if (inner) {
        inner.setAttribute("aria-label", accessibleName);
      }
      var form = search.querySelector("form");
      if (form) {
        form.setAttribute("aria-label", accessibleName);
      }

      var meta = search.querySelector(".md-search-result__meta");
      if (meta) {
        searchInitializerText = (meta.textContent || "").trim();
      }

      /* "Share" and "Clear" enter the tab order only while they are visible. */
      syncSearchOptions(search);
      observeSearchResults(search);
      if (input) {
        input.addEventListener("input", function () {
          syncSearchOptions(search);
        });
      }

      if (form) {
        form.addEventListener("reset", function () {
          /* Let the browser clear the field first, then clear our own state. */
          window.setTimeout(function () {
            resetSearchResults(search);
            syncSearchOptions(search);
            focusQuietly(input);
          }, 0);
        });
      }

      /*
       * Escape must never leave focus stranded on an invisible control - not on
       * a result link inside the collapsed output, and not on the zero-opacity
       * Share/Clear icons either. The theme closes the panel and then blurs the
       * field, so the recovery is deferred to the next task in order to land
       * after that blur.
       *
       * The landing target is deliberately the search *button*, not the query
       * field: focusing the field makes the theme re-open the panel, which would
       * turn Escape into "reopen search" instead of "dismiss search". The button
       * that is visible at the current breakpoint is used - the header button on
       * narrow viewports, the in-field icon on wide ones - and the field is only
       * a last resort.
       */
      search.addEventListener("keydown", function (event) {
        if (event.key !== "Escape" && event.key !== "Esc") {
          return;
        }
        if (!search.contains(document.activeElement)) {
          return;
        }
        window.setTimeout(function () {
          var candidates = [
            document.querySelector('label.md-header__button[for="__search"]'),
            search.querySelector('label.md-search__icon[for="__search"]'),
            input
          ];
          for (var i = 0; i < candidates.length; i++) {
            if (isVisible(candidates[i])) {
              focusQuietly(candidates[i]);
              return;
            }
          }
        }, 0);
      });

      toggle.addEventListener("change", function () {
        syncSearchState(search, toggle);
        syncToggleProxies(toggle, accessibleName, search.id || undefined);
        syncSearchOptions(search);
        if (toggle.checked) {
          armSearchWatchdog(search);
          /*
           * Opening a search dialog must put the caret in the field. The theme
           * does this when the field itself is clicked, but not when the panel
           * is opened from the header button, which would otherwise leave focus
           * outside the dialog it just opened.
           */
          window.setTimeout(function () {
            if (toggle.checked && input && isVisible(input) && !search.contains(document.activeElement)) {
              focusQuietly(input);
            }
          }, 0);
        } else if (input && !input.value) {
          resetSearchResults(search);
        }
      });
    }

    syncSearchState(search, toggle);
    syncToggleProxies(toggle, accessibleName, search.id || undefined);
    syncSearchOptions(search);
  }

  /* ----------------------------------------------------------------------- *
   * 3. Drawer: inert while closed, focus managed while open
   * ----------------------------------------------------------------------- */

  var drawerReturnFocus = null;

  function drawerPanel() {
    return document.querySelector(".md-sidebar--primary");
  }

  /** True while the drawer is the off-canvas (narrow-viewport) variant. */
  function drawerIsOffCanvas() {
    return isVisible(document.querySelector('label.md-header__button[for="__drawer"]'));
  }

  /**
   * True when the element sits inside a collapsed navigation level.
   *
   * The off-canvas drawer stacks every navigation level in the same box and
   * reveals one at a time by transform, so the collapsed levels still measure as
   * laid-out boxes even though nothing of them is painted. Focusing into one
   * looks to the user like focus vanishing, and the browser's scroll-into-view
   * then drags the whole drawer sideways. A level is revealed exactly when the
   * `md-nav__toggle` checkbox that precedes it is checked.
   */
  function inCollapsedNavLevel(el, panel) {
    var node = el.parentNode;
    while (node && node !== panel && node.nodeType === 1) {
      if (node.tagName === "NAV" && node.classList.contains("md-nav")) {
        var sibling = node.previousElementSibling;
        while (sibling) {
          if (
            sibling.tagName === "INPUT" &&
            sibling.classList.contains("md-nav__toggle")
          ) {
            if (!sibling.checked) {
              return true;
            }
            break;
          }
          sibling = sibling.previousElementSibling;
        }
      }
      node = node.parentNode;
    }
    return false;
  }

  /** The focus cycle for the drawer, excluding collapsed navigation levels. */
  function drawerFocusable(panel) {
    var items = focusableWithin(panel);
    if (!drawerIsOffCanvas()) {
      return items;
    }
    var revealed = items.filter(function (item) {
      return !inCollapsedNavLevel(item, panel);
    });
    return revealed.length ? revealed : items;
  }

  /**
   * The off-canvas drawer never scrolls horizontally by design - it changes
   * level by transform. Any non-zero horizontal offset therefore comes from the
   * browser scrolling a focused descendant into view, and it leaves the drawer
   * looking empty until the page is reloaded. Clamp it back.
   */
  function clampDrawerScroll(panel) {
    if (!panel || !drawerIsOffCanvas()) {
      return;
    }
    if (panel.scrollLeft !== 0) {
      panel.scrollLeft = 0;
    }
    Array.prototype.forEach.call(
      panel.querySelectorAll(".md-sidebar__scrollwrap"),
      function (wrap) {
        if (wrap.scrollLeft !== 0) {
          wrap.scrollLeft = 0;
        }
      }
    );
  }

  /**
   * Run a callback once the drawer panel has finished sliding on-screen, so that
   * hit-testing for the entry point is done against the settled layout rather
   * than against the off-canvas position.
   */
  function whenDrawerSettled(panel, callback) {
    var deadline = Date.now() + 500;
    function poll() {
      if (!panel.isConnected) {
        return;
      }
      if (panel.getBoundingClientRect().left >= 0 || Date.now() > deadline) {
        callback();
        return;
      }
      window.requestAnimationFrame(poll);
    }
    window.requestAnimationFrame(poll);
  }

  function syncDrawerState(toggle) {
    var panel = drawerPanel();
    if (!panel) {
      return;
    }
    if (toggle.checked) {
      activate(panel);
      /* Reset any horizontal offset a stray focus left behind. */
      panel.scrollLeft = 0;
      var scrollwrap = panel.querySelector(".md-sidebar__scrollwrap");
      if (scrollwrap) {
        scrollwrap.scrollLeft = 0;
      }
    } else if (drawerIsOffCanvas()) {
      /*
       * Only the off-canvas (narrow-viewport) drawer is hidden content. The
       * test must name the header button specifically: the theme also has a
       * full-width click-away scrim `label[for="__drawer"]`, and a loose
       * selector would match that instead and wrongly make the permanent
       * desktop sidebar inert.
       */
      deactivate(panel);
    } else {
      activate(panel);
    }
  }

  function enhanceDrawer() {
    var toggle = document.getElementById("__drawer");
    if (!toggle) {
      return;
    }
    var proxy = document.querySelector('label.md-header__button[for="__drawer"]');

    if (claim(toggle, "drawer")) {
      toggle.addEventListener("change", function () {
        var panel = drawerPanel();
        syncDrawerState(toggle);
        syncToggleProxies(toggle, "Navigation menu", "rdk-drawer");
        if (!panel) {
          return;
        }
        if (toggle.checked && isVisible(proxy)) {
          drawerReturnFocus = proxy;
          /*
           * Wait for the slide-in to settle before choosing the entry point, so
           * that hit-testing sees the panel where the user does. This also keeps
           * the focus move out of the keydown dispatch, which matters because
           * the theme's global Enter handler activates `document.activeElement`.
           */
          whenDrawerSettled(panel, function () {
            if (!toggle.checked) {
              return;
            }
            clampDrawerScroll(panel);
            var entry = firstEntryPoint(drawerFocusable(panel), toggle);
            if (entry) {
              focusQuietly(entry);
              clampDrawerScroll(panel);
            }
          });
        } else if (drawerReturnFocus) {
          focusQuietly(drawerReturnFocus);
          drawerReturnFocus = null;
        }
      });

      document.addEventListener("keydown", function (event) {
        if (!toggle.checked) {
          return;
        }
        var panel = drawerPanel();
        if (!panel || !isVisible(proxy)) {
          return;
        }
        if (event.key === "Escape" || event.key === "Esc") {
          event.preventDefault();
          toggle.checked = false;
          toggle.dispatchEvent(new Event("change", { bubbles: true }));
          return;
        }
        if (event.key !== "Tab") {
          return;
        }
        var items = drawerFocusable(panel);
        if (!items.length) {
          return;
        }
        var first = items[0];
        var last = items[items.length - 1];
        var index = items.indexOf(document.activeElement);
        if (index === -1) {
          /* Focus is outside the cycle - re-enter it at the correct end. */
          event.preventDefault();
          focusQuietly(event.shiftKey ? last : first);
        } else if (event.shiftKey) {
          event.preventDefault();
          focusQuietly(index === 0 ? last : items[index - 1]);
        } else {
          event.preventDefault();
          focusQuietly(index === items.length - 1 ? first : items[index + 1]);
        }
        clampDrawerScroll(panel);
      });

      /* Undo any horizontal scroll the browser performs while moving focus. */
      document.addEventListener(
        "focusin",
        function (event) {
          var panel = drawerPanel();
          if (panel && panel.contains(event.target)) {
            clampDrawerScroll(panel);
          }
        },
        true
      );
    }

    var panel = drawerPanel();
    if (panel && !panel.id) {
      panel.id = "rdk-drawer";
    }
    syncDrawerState(toggle);
    syncToggleProxies(toggle, "Navigation menu", "rdk-drawer");

    /* The nested table-of-contents toggle inside the drawer needs the same. */
    var toc = document.getElementById("__toc");
    if (toc) {
      syncToggleProxies(toc, "Table of contents");
    }
  }

  /* ----------------------------------------------------------------------- *
   * 4. Horizontally scrollable regions
   * ----------------------------------------------------------------------- */

  /**
   * A container that scrolls horizontally is operable content: it needs a role,
   * a name and a place in the tab order. It also has to scroll a focused
   * descendant *fully* into view - the browser stops as soon as any part of the
   * element is visible, which leaves link text clipped at the container edge.
   */
  /**
   * Name a scroll region after the heading it belongs to. A page can expose a
   * dozen of these at 320px, and a dozen tab stops all called "Scrollable
   * content" tell a screen-reader user nothing about where they are; the
   * heading is the only thing that distinguishes them.
   */
  function scrollRegionName(container, seen) {
    var heading = "";
    var node = container;
    while (node && node !== document.body && !heading) {
      var sibling = node.previousElementSibling;
      while (sibling) {
        if (/^H[1-6]$/.test(sibling.tagName)) {
          heading = visibleText(sibling);
          if (heading) {
            break;
          }
        }
        sibling = sibling.previousElementSibling;
      }
      node = node.parentElement;
    }
    var base = heading ? "Scrollable content: " + heading : "Scrollable content";
    /*
     * Two regions can share a heading. Enhancement runs in document order, so
     * counting the names already handed out yields a stable ordinal. Names
     * already committed to the DOM are counted, and so are the ones decided
     * earlier in the current batch, which have not been written yet.
     */
    var taken = seen && seen[base] ? seen[base] : 0;
    Array.prototype.forEach.call(
      document.querySelectorAll('[data-rdk-scroll="1"][aria-label]'),
      function (other) {
        var label = other.getAttribute("aria-label");
        if (other !== container && (label === base || label.indexOf(base + " (") === 0)) {
          taken += 1;
        }
      }
    );
    if (seen) {
      seen[base] = taken + 1;
    }
    return taken ? base + " (" + (taken + 1) + ")" : base;
  }

  function enhanceScrollRegions(root) {
    var containers = (root || document).querySelectorAll(
      ".md-typeset__scrollwrap, .md-typeset__table, .rdk-scroll-region"
    );
    /*
     * Two passes, deliberately. Reading `scrollWidth` forces the browser to
     * flush pending layout, and writing an attribute invalidates it again, so
     * interleaving the two costs one forced reflow per container - and the
     * widest rendering of the mapping page has 34 of them, re-examined on every
     * navigation and every debounced resize. Measuring everything first and
     * mutating afterwards costs a single layout instead.
     */
    var plan = [];
    var seen = {};
    Array.prototype.forEach.call(containers, function (container) {
      var overflowing = container.scrollWidth > container.clientWidth + 1;
      plan.push({
        container: container,
        overflowing: overflowing,
        /* The name is derived here too: reading the heading reads layout. */
        name:
          overflowing && container.getAttribute("data-rdk-scroll") !== "1"
            ? scrollRegionName(container, seen)
            : null
      });
    });

    plan.forEach(function (item) {
      var container = item.container;
      if (!item.overflowing) {
        /* Nothing to scroll: adding a tab stop would only add noise. */
        if (container.getAttribute("data-rdk-scroll") === "1") {
          container.removeAttribute("tabindex");
        }
        return;
      }
      if (claim(container, "scroll")) {
        container.setAttribute("role", "region");
        container.setAttribute("aria-label", item.name || "Scrollable content");
        container.addEventListener("focusin", function (event) {
          var target = event.target;
          if (!target || target === container) {
            return;
          }
          var box = target.getBoundingClientRect();
          var frame = container.getBoundingClientRect();
          if (box.left < frame.left) {
            container.scrollLeft -= frame.left - box.left + 8;
          } else if (box.right > frame.right) {
            container.scrollLeft += box.right - frame.right + 8;
          }
        });
      }
      container.setAttribute("tabindex", "0");
    });
  }

  /* ----------------------------------------------------------------------- *
   * 5. Version selector naming
   * ----------------------------------------------------------------------- */

  /**
   * The theme builds the version selector only once `versions.json` resolves,
   * as `<button class="md-version__current" aria-label="Select version">0.21.0`.
   * Its visible text is the version and its accessible name is the purpose, so
   * the two share no words at all and WCAG 2.5.3 (Label in Name) is violated -
   * a speech-input user saying "zero point twenty-one" cannot reach it. The same
   * composition used for the navigation proxies applies: name it after what it
   * shows, then say what it does.
   */
  function enhanceVersionSelector() {
    var button = document.querySelector("button.md-version__current");
    if (!button || !visibleText(button)) {
      return;
    }
    button.setAttribute("aria-label", proxyName(button, nativeProxyPurpose(button)));
  }

  /**
   * The widget is appended asynchronously, after this script has already run, so
   * its arrival has to be watched for. Only `childList` is observed, never
   * attributes, so the rename above cannot re-trigger this observer.
   */
  function observeVersionSelector() {
    var topic = document.querySelector(".md-header__topic");
    if (!topic || !window.MutationObserver || !claim(topic, "versionwatch")) {
      return;
    }
    new window.MutationObserver(function () {
      enhanceVersionSelector();
    }).observe(topic, { childList: true, subtree: true });
  }

  /* ----------------------------------------------------------------------- *
   * 6. Deep-link target focus
   * ----------------------------------------------------------------------- */

  /**
   * Give the deep-linked heading focus so that the fragment, `:target`, the
   * table-of-contents highlight and the visible heading cannot drift apart
   * after a reload, a resize or history traversal.
   */
  function focusHashTarget() {
    var hash = window.location.hash;
    if (!hash || hash.length < 2) {
      return;
    }
    var target;
    try {
      target = document.getElementById(decodeURIComponent(hash.slice(1)));
    } catch (err) {
      target = null;
    }
    if (!target) {
      return;
    }
    if (!target.hasAttribute("tabindex")) {
      target.setAttribute("tabindex", "-1");
    }
    focusQuietly(target);
  }

  /* ----------------------------------------------------------------------- *
   * Wiring
   * ----------------------------------------------------------------------- */

  function apply() {
    enhanceSearch();
    enhanceDrawer();
    enhanceScrollRegions(document);
    enhanceVersionSelector();
    observeVersionSelector();
  }

  var resizeTimer = null;
  window.addEventListener(
    "resize",
    function () {
      if (resizeTimer !== null) {
        window.clearTimeout(resizeTimer);
      }
      resizeTimer = window.setTimeout(apply, 150);
    },
    { passive: true }
  );

  window.addEventListener("hashchange", function () {
    window.setTimeout(focusHashTarget, 0);
  });

  function bootstrap() {
    apply();
    /* Let the theme finish its own layout pass before claiming focus. */
    window.setTimeout(function () {
      apply();
      focusHashTarget();
    }, 250);
  }

  if (typeof window.document$ !== "undefined" && window.document$.subscribe) {
    window.document$.subscribe(bootstrap);
  } else if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap);
  } else {
    bootstrap();
  }
})();
