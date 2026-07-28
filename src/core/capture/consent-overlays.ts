/**
 * Best-effort in-page sanitizer for cookie/privacy consent overlays.
 *
 * This file is evaluated inside real pages by Playwright and bundled into the
 * Chrome extension content script, so keep it self-contained and DOM-only.
 */

export interface ConsentOverlaySanitizerResult {
  hiddenCount: number;
}

export interface ConsentOverlayRestoreResult {
  restoredCount: number;
}

export function hideConsentOverlaysInPage(): ConsentOverlaySanitizerResult {
  const consentHiddenAttr = "data-w2ui-consent-hidden";
  const consentPreviousStyleAttr = "data-w2ui-consent-previous-style";
  const knownConsentSelectors = [
    "#onetrust-consent-sdk",
    "#onetrust-banner-sdk",
    ".onetrust-pc-dark-filter",
    "#CybotCookiebotDialog",
    "#CookiebotWidget",
    ".cookiebot",
    ".cc-window",
    ".cc-banner",
    ".cky-consent-container",
    ".cookie-consent",
    ".cookie-banner",
    ".cookies-banner",
    ".cookie-notice",
    ".osano-cm-window",
    ".osano-cm-dialog",
    ".didomi-popup-container",
    ".didomi-consent-popup",
    ".qc-cmp2-container",
    ".iubenda-cs-container",
    ".termly-styles-root",
    "#usercentrics-root",
    "#truste-consent-track",
    ".truste_box_overlay",
    "#coiOverlay",
    "[id^='sp_message_container_']",
  ];
  const consentTextRe =
    /\b(cookie|cookies|consent|privacy|gdpr|ccpa)\b|Cookie|\u9690\u79c1|\u4e2a\u4eba\u4fe1\u606f|\u4e2a\u4eba\u6570\u636e|\u6570\u636e\u4fdd\u62a4|\u8ffd\u8e2a|\u8425\u9500/u;
  const consentActionRe =
    /\b(accept|agree|allow|reject|decline|manage|settings|preferences|continue|got it|understand)\b|\u5168\u90e8\u63a5\u53d7|\u5168\u90e8\u62d2\u7edd|\u63a5\u53d7|\u62d2\u7edd|\u540c\u610f|\u5141\u8bb8|\u7ba1\u7406|\u8bbe\u7f6e|\u504f\u597d|\u4e86\u89e3/u;

  const candidates = collectConsentOverlayCandidates();
  let hiddenCount = 0;
  for (const candidate of candidates) {
    if (hasHiddenConsentAncestor(candidate.element)) continue;
    if (hideConsentElement(candidate.element)) {
      hiddenCount += 1;
    }
  }
  if (hiddenCount > 0) {
    releaseRootScrollLock();
  }
  return { hiddenCount };

  function releaseRootScrollLock(): void {
    type SavedProperty = {
      element: HTMLElement;
      name: string;
      value: string;
      priority: string;
    };
    const key = Symbol.for("web2ui-extension:consent-root-scroll-lock");
    const globals = window as unknown as {
      [property: symbol]: SavedProperty[] | undefined;
    };
    if (globals[key] !== undefined) return;

    const saved: SavedProperty[] = [];
    const override = (element: HTMLElement, name: string, value: string): void => {
      saved.push({
        element,
        name,
        value: element.style.getPropertyValue(name),
        priority: element.style.getPropertyPriority(name),
      });
      element.style.setProperty(name, value, "important");
    };
    const roots = [document.documentElement, document.body].filter(
      (element): element is HTMLElement => element instanceof HTMLElement,
    );
    const verticallyLocked = roots.some((element) => {
      const overflowY = getComputedStyle(element).overflowY;
      return overflowY === "hidden" || overflowY === "clip";
    });
    const hasScrollableBody =
      Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0) >
      window.innerHeight + 1;
    for (const element of roots) {
      const style = getComputedStyle(element);
      if (style.overflowY === "hidden" || style.overflowY === "clip") {
        override(element, "overflow-y", "auto");
      }
      if (verticallyLocked && hasScrollableBody) {
        override(element, "height", "auto");
        override(element, "max-height", "none");
      }
      if (style.position === "fixed") {
        override(element, "position", "static");
        override(element, "top", "auto");
        override(element, "bottom", "auto");
      }
    }
    globals[key] = saved;
  }

  function collectConsentOverlayCandidates(): { element: HTMLElement; area: number }[] {
    const byElement = new Map<HTMLElement, number>();

    for (const selector of knownConsentSelectors) {
      for (const element of queryHtmlElements(selector)) {
        if (!isVisibleBox(element)) continue;
        byElement.set(element, areaOf(element.getBoundingClientRect()));
      }
    }

    for (const element of Array.from(document.body?.querySelectorAll<HTMLElement>("*") ?? [])) {
      if (!isLikelyConsentOverlay(element)) continue;
      byElement.set(element, areaOf(element.getBoundingClientRect()));
    }

    return Array.from(byElement, ([element, area]) => ({ element, area }))
      .sort((a, b) => b.area - a.area);
  }

  function queryHtmlElements(selector: string): HTMLElement[] {
    try {
      return Array.from(document.querySelectorAll(selector))
        .filter((element): element is HTMLElement => element instanceof HTMLElement);
    } catch {
      return [];
    }
  }

  function isLikelyConsentOverlay(element: HTMLElement): boolean {
    if (!isVisibleBox(element)) return false;
    if (isExcludedElement(element)) return false;

    const style = getComputedStyle(element);
    if (style.position !== "fixed" && style.position !== "sticky") return false;

    const rect = element.getBoundingClientRect();
    const viewportWidth = Math.max(1, window.innerWidth);
    const viewportHeight = Math.max(1, window.innerHeight);
    const viewportArea = viewportWidth * viewportHeight;
    const areaRatio = areaOf(rect) / viewportArea;
    if (rect.width < 120 || rect.height < 40 || areaRatio < 0.015 || areaRatio > 0.9) {
      return false;
    }

    const anchoredToEdge =
      rect.top <= 80 ||
      rect.bottom >= viewportHeight - 80 ||
      rect.left <= 80 ||
      rect.right >= viewportWidth - 80;
    const modalLike =
      rect.width <= viewportWidth * 0.92 &&
      rect.height <= viewportHeight * 0.85 &&
      rect.top >= 0 &&
      rect.left >= 0;
    if (!anchoredToEdge && !modalLike) return false;

    const text = normalizedText(element);
    if (!consentTextRe.test(text)) return false;
    return consentActionRe.test(text) || hasConsentActionControl(element);
  }

  function isExcludedElement(element: HTMLElement): boolean {
    const tag = element.tagName.toLowerCase();
    return tag === "html" || tag === "body" || tag === "script" || tag === "style" || tag === "svg";
  }

  function isVisibleBox(element: HTMLElement): boolean {
    if (element.hasAttribute(consentHiddenAttr)) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number.parseFloat(style.opacity || "1") === 0) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width >= 1 && rect.height >= 1;
  }

  function hasConsentActionControl(element: HTMLElement): boolean {
    const controls = Array.from(
      element.querySelectorAll<HTMLElement>("button,a,[role='button'],input[type='button'],input[type='submit']"),
    );
    return controls.some((control) => consentActionRe.test(normalizedText(control)));
  }

  function normalizedText(element: HTMLElement): string {
    return (element.innerText || element.textContent || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 4000);
  }

  function areaOf(rect: DOMRect): number {
    return Math.max(0, rect.width) * Math.max(0, rect.height);
  }

  function hasHiddenConsentAncestor(element: HTMLElement): boolean {
    let parent = element.parentElement;
    while (parent) {
      if (parent.hasAttribute(consentHiddenAttr)) return true;
      parent = parent.parentElement;
    }
    return false;
  }

  function hideConsentElement(element: HTMLElement): boolean {
    if (element.hasAttribute(consentHiddenAttr)) return false;
    const previousStyle = element.getAttribute("style");
    if (previousStyle !== null) {
      element.setAttribute(consentPreviousStyleAttr, previousStyle);
    }
    element.setAttribute(consentHiddenAttr, "1");
    element.style.setProperty("display", "none", "important");
    return true;
  }
}

export function restoreConsentOverlaysInPage(): ConsentOverlayRestoreResult {
  const consentHiddenAttr = "data-w2ui-consent-hidden";
  const consentPreviousStyleAttr = "data-w2ui-consent-previous-style";
  let restoredCount = 0;
  for (const element of Array.from(document.querySelectorAll<HTMLElement>(`[${consentHiddenAttr}]`))) {
    const previousStyle = element.getAttribute(consentPreviousStyleAttr);
    if (previousStyle === null) {
      element.removeAttribute("style");
    } else {
      element.setAttribute("style", previousStyle);
    }
    element.removeAttribute(consentHiddenAttr);
    element.removeAttribute(consentPreviousStyleAttr);
    restoredCount += 1;
  }
  type SavedProperty = {
    element: HTMLElement;
    name: string;
    value: string;
    priority: string;
  };
  const key = Symbol.for("web2ui-extension:consent-root-scroll-lock");
  const globals = window as unknown as {
    [property: symbol]: SavedProperty[] | undefined;
  };
  for (const saved of globals[key] ?? []) {
    if (saved.value === "") {
      saved.element.style.removeProperty(saved.name);
    } else {
      saved.element.style.setProperty(saved.name, saved.value, saved.priority);
    }
  }
  globals[key] = undefined;
  return { restoredCount };
}
