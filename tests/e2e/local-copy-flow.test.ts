import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { readFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { chromium, type BrowserContext, type Page, type Worker } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const dist = path.join(root, "dist");
const fixturePath = path.join(root, "tests/e2e/fixtures/local-page.html");
const artifacts = path.join(root, "out/e2e/playwright/local-copy");
const userDataDir = path.join(artifacts, "browser-profile");
const privateCanary = "PRIVATE_CANARY_DO_NOT_TRANSMIT_7F12";

let server: Server;
let fixtureUrl: string;

beforeAll(async () => {
  const build = spawnSync("pnpm", ["run", "build"], { cwd: root, encoding: "utf8" });
  if (build.status !== 0) throw new Error(`${build.stdout}\n${build.stderr}`);
  await rm(artifacts, { recursive: true, force: true });
  await mkdir(artifacts, { recursive: true });
  const fixture = await readFile(fixturePath);
  server = createServer((request, response) => {
    if (request.url === "/" || request.url === "/local-page.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(fixture);
      return;
    }
    response.writeHead(404);
    response.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not bind");
  fixtureUrl = `http://127.0.0.1:${address.port}/local-page.html`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe.sequential("real MV3 local Copy for Figma flow", () => {
  it(
    "captures Visible Area and Full Page, copies locally, and survives service-worker restart",
    async () => {
      const evidence: Array<{ url: string; method: string; body: string | null; headers: Record<string, string> }> = [];
      const consoleMessages: string[] = [];
      const { context, extensionId } = await launchExtension(userDataDir);
      observeContext(context, evidence, consoleMessages);
      const target = await openFixture(context);
      await target.screenshot({ path: path.join(artifacts, "visible-source.png") });

      const popup = await openExtensionPopup(context, extensionId);
      await target.bringToFront();
      await popup.evaluate(() => window.dispatchEvent(new Event("focus")));
      await popup.getByText("⚡ 1280px").waitFor({ state: "visible" });
      await popup.screenshot({ path: path.join(artifacts, "popup-idle.png") });
      await clickInInactivePopup(popup, "Browser viewport and Browser theme");
      await popup.screenshot({ path: path.join(artifacts, "popup-environment-open.png") });
      const viewportGroup = popup.getByRole("radiogroup", { name: "Capture viewport" });
      const themeGroup = popup.getByRole("radiogroup", { name: "Capture theme" });
      expect(await viewportGroup.getByRole("radio").count()).toBe(6);
      expect(await themeGroup.getByRole("radio").count()).toBe(3);

      await viewportGroup.getByRole("radio", { name: /390/u }).evaluate((element) => {
        (element as HTMLButtonElement).click();
      });
      await themeGroup.getByRole("radio", { name: "Dark" }).evaluate((element) => {
        (element as HTMLButtonElement).click();
      });
      await popup.getByText("⚡ 390px").waitFor({ state: "visible" });
      await popup.getByText("🎨 DARK").waitFor({ state: "visible" });
      await popup.screenshot({ path: path.join(artifacts, "popup-390-dark.png") });

      const fullPageBox = await popup.getByRole("button", { name: "Capture full page" }).boundingBox();
      const visibleBox = await popup.getByRole("button", { name: "Capture visible area" }).boundingBox();
      if (!fullPageBox || !visibleBox) throw new Error("capture card geometry unavailable");
      expect(fullPageBox.y).toBe(visibleBox.y);
      expect(fullPageBox.height).toBe(120);
      expect(visibleBox.height).toBe(120);
      expect(Math.round(visibleBox.x - (fullPageBox.x + fullPageBox.width))).toBe(10);
      expect(fullPageBox.width).toBeGreaterThan(visibleBox.width);
      expect(await viewportGroup.locator('[aria-checked="true"]').count()).toBe(1);
      expect(await themeGroup.locator('[aria-checked="true"]').count()).toBe(1);
      expect(await popup.evaluate(() => document.documentElement.scrollWidth)).toBe(380);

      await clickInInactivePopup(popup, "Browser viewport and Browser theme");
      await target.bringToFront();
      await popup.getByRole("button", { name: "Capture visible area" }).waitFor({ state: "visible" });
      await clickInInactivePopup(popup, "Capture visible area");
      await waitForReadyState(popup, 10_000, consoleMessages);
      await popup.getByRole("button", { name: /Copy for Figma|Copied — paste in Figma/u }).waitFor({
        state: "visible",
        timeout: 30_000,
      });
      const readyState = await popup.evaluate(async () => {
        return chrome.runtime.sendMessage({ type: "get-state" }) as Promise<{
          ok: true;
          state: { status: string; warningCount?: number };
        }>;
      });
      expect(readyState.state.warningCount).toBeGreaterThan(0);
      const fidelityLink = popup.getByRole("link", {
        name: "Explore higher-fidelity managed capture in the commercial Web2UI Cloud edition",
      });
      await fidelityLink.waitFor({ state: "visible", timeout: 5_000 });
      expect(await fidelityLink.getAttribute("href")).toBe("https://web2ui.lynavo.io/");
      expect(await fidelityLink.getAttribute("target")).toBe("_blank");
      await popup.screenshot({ path: path.join(artifacts, "visible-ready-popup.png") });
      await popup.getByRole("button", { name: "Copy for Figma" }).click();
      await popup.getByRole("button", { name: "Copied — paste in Figma" }).waitFor({
        state: "visible",
        timeout: 10_000,
      });
      await popup.screenshot({ path: path.join(artifacts, "visible-copied-popup.png") });
      const visiblePayload = await requestClipboardPayload(popup);
      const visibleSize = svgSize(visiblePayload.svg);
      expect(visibleSize.width).toBe(390);
      expect(visibleSize.height).toBe(720);
      await screenshotClipboardPreview(
        context,
        visiblePayload.html,
        path.join(artifacts, "visible-clipboard-preview.png"),
        false,
      );

      await popup.getByRole("button", { name: "Capture another page" }).click();
      await popup.getByRole("button", { name: "Browser viewport and Browser theme" }).click();
      await popup.getByRole("radiogroup", { name: "Capture viewport" })
        .getByRole("radio", { name: /^Browser/u })
        .click();
      await popup.getByRole("radiogroup", { name: "Capture theme" })
        .getByRole("radio", { name: "Browser" })
        .click();
      await popup.getByText("🎨 BROWSER").waitFor({ state: "visible" });
      await popup.getByRole("button", { name: "Browser viewport and Browser theme" }).click();
      await target.bringToFront();
      await target.screenshot({ path: path.join(artifacts, "full-page-source.png"), fullPage: true });
      await clickInInactivePopup(popup, "Capture full page");
      await waitForReadyState(popup, 30_000, consoleMessages);
      await popup.getByRole("button", { name: "Copy for Figma" }).waitFor({
        state: "visible",
        timeout: 30_000,
      });
      const fullPayload = await requestClipboardPayload(popup);
      const fullSize = svgSize(fullPayload.svg);
      expect(fullSize.width).toBe(1280);
      expect(fullSize.height).toBeGreaterThan(2_000);
      expect(fullPayload.svg).toContain("Full-page end marker.");
      await screenshotClipboardPreview(
        context,
        fullPayload.html,
        path.join(artifacts, "full-page-clipboard-preview.png"),
        true,
      );

      await restartExtensionServiceWorker(context, extensionId, target);
      await target.bringToFront();
      await popup.reload({ waitUntil: "domcontentloaded" });
      await popup.evaluate(() => window.dispatchEvent(new Event("focus")));
      await popup.getByRole("button", { name: "Copy for Figma" }).waitFor({
        state: "visible",
        timeout: 10_000,
      });
      expect(extensionId).toMatch(/^[a-p]{32}$/u);

      const serializedEvidence = JSON.stringify(evidence);
      expect(serializedEvidence).not.toContain(privateCanary);
      expect(consoleMessages.join("\n")).not.toContain(privateCanary);
      expect(evidence.map(({ url }) => url).join("\n")).not.toMatch(
        /web2ui\.lynavo\.io|workers\.dev|r2\.dev|cloudflarestorage\.com/iu,
      );
      await context.close();
    },
    120_000,
  );

  it(
    "keeps A, B, and C state independent when protected D is opened",
    async () => {
      const profile = path.join(artifacts, "multi-tab-profile");
      await rm(profile, { recursive: true, force: true });
      const { context, extensionId } = await launchExtension(profile);
      const popup = await openExtensionPopup(context, extensionId);
      const tabA = await openFixture(context);
      const tabB = await openFixture(context);
      const tabC = await openFixture(context);
      const tabD = await openFixture(context);

      await startCaptureOnTab(popup, tabA, "visible-area");
      await startCaptureOnTab(popup, tabB, "visible-area");
      await startCaptureOnTab(popup, tabC, "visible-area");
      await waitForReadyOnTab(popup, tabA);
      await waitForReadyOnTab(popup, tabB);
      await waitForReadyOnTab(popup, tabC);

      const beforeProtected = await Promise.all([
        readStateOnTab(popup, tabA),
        readStateOnTab(popup, tabB),
        readStateOnTab(popup, tabC),
      ]);
      expect(beforeProtected.map((response) => response.state?.status)).toEqual([
        "ready",
        "ready",
        "ready",
      ]);

      await tabD.goto("about:blank");
      await tabD.bringToFront();
      const blocked = await popup.evaluate(async () =>
        chrome.runtime.sendMessage({ type: "start-capture", mode: "visible-area" }),
      );
      expect(blocked).toMatchObject({ ok: false });

      const afterProtected = await Promise.all([
        readStateOnTab(popup, tabA),
        readStateOnTab(popup, tabB),
        readStateOnTab(popup, tabC),
      ]);
      expect(afterProtected.map((response) => response.state?.status)).toEqual([
        "ready",
        "ready",
        "ready",
      ]);
      expect(afterProtected.map((response) => response.state?.tabId)).toEqual(
        beforeProtected.map((response) => response.state?.tabId),
      );

      await context.close();
    },
    120_000,
  );
});

async function launchExtension(profile: string): Promise<{
  context: BrowserContext;
  extensionId: string;
}> {
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    viewport: { width: 1280, height: 720 },
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 15_000 }));
  const extensionId = new URL(worker.url()).host;
  return { context, extensionId };
}

async function openFixture(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(fixtureUrl, { waitUntil: "networkidle" });
  await page.bringToFront();
  return page;
}

async function openExtensionPopup(context: BrowserContext, extensionId: string): Promise<Page> {
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 380, height: 580 });
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.waitForLoadState("domcontentloaded");
  return popup;
}

async function restartExtensionServiceWorker(
  context: BrowserContext,
  extensionId: string,
  target: Page,
): Promise<void> {
  const session = await context.newCDPSession(target);
  const version = new Promise<{ versionId: string }>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("extension service worker version unavailable")),
      10_000,
    );
    session.on("ServiceWorker.workerVersionUpdated", ({ versions }) => {
      const match = versions.find((candidate) => {
        try {
          return new URL(candidate.scriptURL).host === extensionId;
        } catch {
          return false;
        }
      });
      if (!match) return;
      clearTimeout(timeout);
      resolve(match);
    });
  });
  await session.send("ServiceWorker.enable");
  const { versionId } = await version;
  await session.send("ServiceWorker.stopWorker", { versionId });
  await session.detach();
}

async function clickInInactivePopup(popup: Page, name: string): Promise<void> {
  const button = popup.getByRole("button", { name });
  await button.waitFor({ state: "visible" });
  await button.evaluate((element) => (element as HTMLButtonElement).click());
}

async function requestClipboardPayload(popup: Page): Promise<{ svg: string; html: string; text: string }> {
  return popup.evaluate(async () => {
    const stateResponse = (await chrome.runtime.sendMessage({ type: "get-state" })) as {
      ok: boolean;
      state?: { tabId?: number };
    };
    const tabId = stateResponse.state?.tabId;
    if (!stateResponse.ok || !Number.isInteger(tabId)) {
      throw new Error("ready tab unavailable");
    }
    const response = (await chrome.runtime.sendMessage({
      type: "prepare-clipboard",
      tabId,
    })) as {
      ok: boolean;
      payload?: { svg: string; html: string; text: string };
    };
    if (!response.ok || !response.payload) throw new Error("clipboard payload unavailable");
    return response.payload;
  });
}

async function waitForReadyState(
  popup: Page,
  timeout: number,
  consoleMessages: string[],
): Promise<void> {
  const deadline = Date.now() + timeout;
  let lastState: unknown = null;
  while (Date.now() < deadline) {
    const response = await popup.evaluate(async () => chrome.runtime.sendMessage({ type: "get-state" }));
    lastState = response;
    if (
      typeof response === "object" &&
      response !== null &&
      "state" in response &&
      typeof response.state === "object" &&
      response.state !== null
    ) {
      const state = response.state as { status?: string };
      if (state.status === "ready") return;
      if (state.status === "error") throw new Error(`capture entered error state: ${JSON.stringify(response)}`);
    }
    await popup.waitForTimeout(250);
  }
  throw new Error(
    `capture did not become ready: ${JSON.stringify(lastState)}; console: ${consoleMessages.join(" | ")}`,
  );
}

async function startCaptureOnTab(
  popup: Page,
  target: Page,
  mode: "visible-area" | "full-page",
): Promise<void> {
  await target.bringToFront();
  const response = await popup.evaluate(async (captureMode) =>
    chrome.runtime.sendMessage({ type: "start-capture", mode: captureMode }), mode);
  if (typeof response !== "object" || response === null || !("state" in response)) {
    throw new Error(`capture did not start: ${JSON.stringify(response)}`);
  }
}

async function readStateOnTab(
  popup: Page,
  target: Page,
): Promise<{ ok: boolean; state?: { status?: string; tabId?: number } }> {
  await target.bringToFront();
  return popup.evaluate(async () => chrome.runtime.sendMessage({ type: "get-state" })) as Promise<{
    ok: boolean;
    state?: { status?: string; tabId?: number };
  }>;
}

async function waitForReadyOnTab(popup: Page, target: Page): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastResponse: unknown = null;
  while (Date.now() < deadline) {
    const response = await readStateOnTab(popup, target);
    lastResponse = response;
    if (response.state?.status === "ready") return;
    if (response.state?.status === "error") {
      throw new Error(`tab capture entered error state: ${JSON.stringify(response)}`);
    }
    await popup.waitForTimeout(250);
  }
  throw new Error(`tab capture did not become ready: ${JSON.stringify(lastResponse)}`);
}

function svgSize(svg: string): { width: number; height: number } {
  const match = /<svg[^>]*\bwidth="([\d.]+)"[^>]*\bheight="([\d.]+)"/u.exec(svg);
  if (!match?.[1] || !match[2]) throw new Error("clipboard SVG has no numeric size");
  return { width: Number(match[1]), height: Number(match[2]) };
}

async function screenshotClipboardPreview(
  context: BrowserContext,
  html: string,
  output: string,
  fullPage: boolean,
): Promise<void> {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.setContent(`<style>html,body{margin:0;background:#fff}svg{display:block}</style>${html}`);
  await page.screenshot({ path: output, fullPage });
  await page.close();
}

function observeContext(
  context: BrowserContext,
  evidence: Array<{ url: string; method: string; body: string | null; headers: Record<string, string> }>,
  consoleMessages: string[],
): void {
  context.on("request", (request) => {
    void request.allHeaders().then((headers) => {
      evidence.push({
        url: request.url(),
        method: request.method(),
        body: request.postData(),
        headers,
      });
    });
  });
  context.on("page", (page) => {
    page.on("console", (message) => consoleMessages.push(message.text()));
    page.on("pageerror", (error) => consoleMessages.push(`pageerror:${error.message}`));
  });
  const observeWorker = (worker: Worker) => {
    worker.on("console", (message) => consoleMessages.push(`worker:${message.text()}`));
  };
  context.serviceWorkers().forEach(observeWorker);
  context.on("serviceworker", observeWorker);
}
