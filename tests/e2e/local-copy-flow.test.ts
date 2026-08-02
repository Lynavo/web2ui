import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { readFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type BrowserContext, type Page, type Worker } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const dist = path.join(root, "dist");
const fixturePath = path.join(root, "tests/e2e/fixtures/local-page.html");
const artifacts = path.join(root, "out/e2e/playwright/local-copy");
const userDataDir = path.join(artifacts, "browser-profile");
const privateCanary = "PRIVATE_CANARY_DO_NOT_TRANSMIT_7F12";
const fixturePngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const fixturePngDataUrl = `data:image/png;base64,${fixturePngBase64}`;

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
    if (request.url === "/fixture-image.png") {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(Buffer.from(fixturePngBase64, "base64"));
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
      let { context, extensionId } = await launchExtension(userDataDir);
      observeContext(context, evidence, consoleMessages);
      let target = await openFixture(context);
      await target.screenshot({ path: path.join(artifacts, "visible-source.png") });

      let popup = await openExtensionPopup(context, extensionId);
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
      const visiblePayload = await requestClipboardPayload(popup);
      const visibleSize = svgSize(visiblePayload.svg);
      expect(visibleSize.width).toBe(390);
      expect(visibleSize.height).toBe(720);
      expect(visiblePayload.svg).toContain(fixturePngDataUrl);
      expect(countOccurrences(visiblePayload.svg, fixturePngDataUrl)).toBe(1);
      expect(visiblePayload.svg).not.toMatch(/<image\b[^>]*\bhref="https?:/iu);
      await screenshotClipboardPreview(
        visiblePayload.html,
        path.join(artifacts, "visible-clipboard-preview.png"),
      );

      await popup.getByRole("button", { name: "Capture another page" }).click();
      // Clearing Chrome's device metrics restores a real tab's physical
      // viewport. Playwright's persistent context uses its own emulation, so
      // restore that test-harness viewport explicitly before Browser mode.
      await target.setViewportSize({ width: 1279, height: 720 });
      await target.setViewportSize({ width: 1280, height: 720 });
      expect(await target.evaluate(() => window.innerWidth)).toBe(1280);
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
      expect(await target.evaluate(() => window.innerWidth)).toBe(1280);
      await target.screenshot({ path: path.join(artifacts, "full-page-source.png"), fullPage: true });
      expect(await target.locator("#nested-scroll").evaluate((element) => element.scrollLeft)).toBe(96);
      await clickInInactivePopup(popup, "Capture full page");
      await waitForReadyState(popup, 30_000, consoleMessages);
      expect(await target.locator("#nested-scroll").evaluate((element) => element.scrollLeft)).toBe(96);
      await popup.getByRole("button", { name: "Copy for Figma" }).waitFor({
        state: "visible",
        timeout: 30_000,
      });
      const fullPayload = await requestClipboardPayload(popup);
      await writeFile(path.join(artifacts, "full-page-clipboard.svg"), fullPayload.svg);
      const fullSize = svgSize(fullPayload.svg);
      const fullAssetIds = await requestStoredPlanAssetIds(popup);
      expect(fullSize.width).toBe(1280);
      expect(fullSize.height).toBeGreaterThan(2_000);
      expect(fullAssetIds.some((assetId) => assetId.startsWith("shot-background-"))).toBe(true);
      expect(fullPayload.svg).toContain("Full-page end marker.");
      expect(countOccurrences(fullPayload.svg, "Full-page end marker.")).toBe(1);
      expect(countOccurrences(fullPayload.svg, fixturePngDataUrl)).toBe(1);
      expect(fullPayload.svg.match(/<image\b/gu)?.length ?? 0).toBeGreaterThanOrEqual(2);
      expect(fullPayload.svg).not.toMatch(/<image\b[^>]*\bhref="https?:/iu);
      const fullPreviewPixels = await screenshotClipboardPreview(
        fullPayload.html,
        path.join(artifacts, "full-page-clipboard-preview.png"),
        [
          { x: 215, y: 1036 },
          { x: 420, y: 850 },
        ],
      );
      expect(fullPreviewPixels, consoleMessages.join("\n")).toEqual([
        { r: 23, g: 32, b: 51, a: 255 },
        { r: 255, g: 255, b: 255, a: 255 },
      ]);

      await popup.close();
      await context.close();

      ({ context, extensionId } = await launchExtension(userDataDir));
      observeContext(context, evidence, consoleMessages);
      target = await openFixture(context);
      popup = await openExtensionPopup(context, extensionId);
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

async function clickInInactivePopup(popup: Page, name: string): Promise<void> {
  const button = popup.getByRole("button", { name });
  await button.waitFor({ state: "visible" });
  await button.evaluate((element) => (element as HTMLButtonElement).click());
}

async function requestClipboardPayload(popup: Page): Promise<{ svg: string; html: string; text: string }> {
  return popup.evaluate(async () => {
    const response = (await chrome.runtime.sendMessage({ type: "prepare-clipboard" })) as {
      ok: boolean;
      payload?: { svg: string; html: string; text: string };
    };
    if (!response.ok || !response.payload) throw new Error("clipboard payload unavailable");
    return response.payload;
  });
}

async function requestStoredPlanAssetIds(popup: Page): Promise<string[]> {
  return popup.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("web2ui-extension", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("test database open failed"));
    });
    try {
      const record = await new Promise<unknown>((resolve, reject) => {
        const transaction = database.transaction("current-render-plan", "readonly");
        const request = transaction.objectStore("current-render-plan").get("current");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("test plan read failed"));
      });
      if (typeof record !== "object" || record === null || !("plan" in record)) return [];
      const plan = record.plan as { assets?: Array<{ assetId?: unknown }> };
      return (plan.assets ?? [])
        .map((asset) => asset.assetId)
        .filter((assetId): assetId is string => typeof assetId === "string");
    } finally {
      database.close();
    }
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

function svgSize(svg: string): { width: number; height: number } {
  const match = /<svg[^>]*\bwidth="([\d.]+)"[^>]*\bheight="([\d.]+)"/u.exec(svg);
  if (!match?.[1] || !match[2]) throw new Error("clipboard SVG has no numeric size");
  return { width: Number(match[1]), height: Number(match[2]) };
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

async function screenshotClipboardPreview(
  html: string,
  output: string,
  samples?: ReadonlyArray<{ x: number; y: number }>,
): Promise<Array<{ r: number; g: number; b: number; a: number }> | undefined> {
  // Keep evidence independent from the extension's persistent context: that
  // context intentionally receives transient debugger viewport emulation.
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.setContent(
      `<style>html,body{margin:0;background:#fff}svg{display:block}</style>${html}`,
    );
    const screenshot = await page.locator("svg").screenshot({ path: output });
    if (samples === undefined) return undefined;
    const pixels = await page.evaluate(
      async ({ dataUrl, samples: requestedSamples }) => {
        const image = new Image();
        image.src = dataUrl;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d");
        if (context === null) throw new Error("preview pixel canvas unavailable");
        context.drawImage(image, 0, 0);
        return requestedSamples.map(({ x, y }) => {
          const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(x, y, 1, 1).data;
          return { r, g, b, a };
        });
      },
      {
        dataUrl: `data:image/png;base64,${screenshot.toString("base64")}`,
        samples,
      },
    );
    return pixels;
  } finally {
    await browser.close();
  }
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
