/**
 * The guest screens as a design: what has to be on the screen without scrolling, what has to be
 * readable on every role colour, and the handful of numbers (contrast, tap size) the look rests on.
 * Measured in the DOM, on the phones a QR scan really opens — including a 393x659 iPhone, which is
 * a 393x852 screen with Safari's bars showing.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { connectAsHost } from "./helpers/host-driver";

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const SMALLEST = { width: 320, height: 568 };
const SAFARI = { width: 393, height: 659 };

type Rgb = [number, number, number];

function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function hexToRgb(value: string): Rgb {
  const h = value.trim().replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
}

async function token(page: Page, name: string): Promise<Rgb> {
  return hexToRgb(await page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n), name));
}

interface Printed {
  text: string;
  ratio: number;
  /** WCAG "large text": 24 px, or 18.66 px bold. Needs 3:1 instead of 4.5:1. */
  large: boolean;
}

/**
 * Every piece of text inside <main>, with its real contrast: the text colour (its own alpha and
 * every ancestor's opacity) composited over the backgrounds actually behind it.
 */
async function printedText(page: Page): Promise<Printed[]> {
  const raw = await page.evaluate(() => {
    const parse = (c: string): [number, number, number, number] => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) return [0, 0, 0, 0];
      const p = m[1]!.split(/[,/\s]+/).filter(Boolean).map(Number);
      return [p[0]!, p[1]!, p[2]!, p[3] ?? 1];
    };
    const over = (top: [number, number, number, number], under: [number, number, number]): [number, number, number] =>
      [0, 1, 2].map((i) => top[i]! * top[3] + under[i]! * (1 - top[3])) as [number, number, number];
    const main = document.querySelector("main")!;
    const out: Array<{ text: string; fg: [number, number, number]; bg: [number, number, number]; size: number; weight: number }> = [];
    for (const el of main.querySelectorAll<HTMLElement>("*")) {
      const text = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim()).map((n) => n.textContent!.trim()).join(" ");
      if (!text || el.closest("[aria-hidden='true']") || el.closest(".sr-only")) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const chain: HTMLElement[] = [];
      for (let p: HTMLElement | null = el; p; p = p.parentElement) chain.unshift(p);
      let bg: [number, number, number] = [11, 15, 20];
      let opacity = 1;
      for (const node of chain) {
        const cs = getComputedStyle(node);
        opacity *= Number(cs.opacity);
        const layer = parse(cs.backgroundColor);
        if (layer[3] > 0) bg = over([layer[0], layer[1], layer[2], layer[3] * opacity], bg);
      }
      const cs = getComputedStyle(el);
      const color = parse(cs.color);
      out.push({ text: text.slice(0, 40), fg: over([color[0], color[1], color[2], color[3] * opacity], bg), bg, size: parseFloat(cs.fontSize), weight: Number(cs.fontWeight) });
    }
    return out;
  });
  return raw.map((p) => ({ text: p.text, ratio: contrast(p.fg, p.bg), large: p.size >= 24 || (p.size >= 18.66 && p.weight >= 700) }));
}

function tooFaint(printed: Printed[]): string[] {
  return printed.filter((p) => p.ratio < (p.large ? 3 : 4.5)).map((p) => `"${p.text}" ${p.ratio.toFixed(2)}:1`);
}

async function join(page: Page, name: string) {
  await page.goto("/j/BZQ7");
  await page.getByPlaceholder("Your name").fill(name);
  await page.getByRole("button", { name: "Tap to join" }).click();
}

async function myId(page: Page): Promise<string> {
  return (await page.evaluate(() => localStorage.getItem("hive:clientId:BZQ7")))!;
}

test.describe("contrast", () => {
  test.use({ mockScenario: "party-12.json" });

  test("tokens: helper text and control edges meet AA on every surface they are used on", async ({ page }) => {
    await page.goto("/");
    const stage = await token(page, "--stage");
    const surface = await token(page, "--surface");
    const raised = await token(page, "--raised");
    const faint = await token(page, "--faint");
    for (const [name, bg] of [["stage", stage], ["surface", surface], ["raised", raised]] as const) {
      expect(contrast(faint, bg), `--faint on --${name}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(await token(page, "--muted"), bg), `--muted on --${name}`).toBeGreaterThanOrEqual(4.5);
    }
    const edge = await token(page, "--border-strong");
    expect(contrast(edge, stage), "--border-strong on --stage").toBeGreaterThanOrEqual(3);
    expect(contrast(edge, surface), "--border-strong on --surface").toBeGreaterThanOrEqual(3);
    expect(contrast(await token(page, "--danger"), stage), "--danger on --stage").toBeGreaterThanOrEqual(4.5);
    expect(contrast(await token(page, "--role-bass-text"), surface), "--role-bass-text on --surface").toBeGreaterThanOrEqual(4.5);
    expect(contrast([248, 250, 252], await token(page, "--role-bass-screen")), "light ink on --role-bass-screen").toBeGreaterThanOrEqual(4.5);
  });

  test("playing screen: everything printed is AA on every role colour, sponsor line and mute edge included", async ({ page }) => {
    await page.setViewportSize({ width: 393, height: 852 });
    await join(page, "Readable");
    await expect(page.getByText("YOU ARE")).toBeVisible({ timeout: 10_000 });
    const id = await myId(page);
    const host = await connectAsHost("BZQ7");
    const roleLabel = page.locator("main span.font-display").last();

    for (const role of ["drums", "bass", "vocals", "other"] as const) {
      host.send({ type: "ASSIGN", clientId: id, role });
      await expect(roleLabel).toHaveText(new RegExp(role, "i"), { timeout: 10_000 });
      expect(tooFaint(await printedText(page)), `on ${role}`).toEqual([]);
      // The mute button's outline is its only edge: a control boundary needs 3:1 (WCAG 1.4.11).
      const edge = await page.getByRole("button", { name: "Mute my phone" }).evaluate((el) => {
        const parse = (c: string) => c.match(/rgba?\(([^)]+)\)/)![1]!.split(/[,/\s]+/).filter(Boolean).map(Number);
        const panel = parse(getComputedStyle(el.parentElement!).backgroundColor);
        const fill = parse(getComputedStyle(document.querySelector("main")!).backgroundColor);
        const under = [0, 1, 2].map((i) => panel[i]! * (panel[3] ?? 1) + fill[i]! * (1 - (panel[3] ?? 1)));
        const b = parse(getComputedStyle(el).borderTopColor);
        return { under, line: [0, 1, 2].map((i) => b[i]! * (b[3] ?? 1) + under[i]! * (1 - (b[3] ?? 1))) };
      });
      expect(contrast(edge.line as Rgb, edge.under as Rgb), `mute outline on ${role}`).toBeGreaterThanOrEqual(3);
    }

    host.send({ type: "SET_MODE", mode: "UNISON", params: {} });
    await expect(roleLabel).toHaveText(/unison/i, { timeout: 10_000 });
    expect(tooFaint(await printedText(page)), "on unison").toEqual([]);
    host.close();
  });

  test.describe("ready screen", () => {
    test.use({ mockScenario: "join.json" });

    test("ready screen: everything printed is AA, bass as a role name included", async ({ page }) => {
      await page.setViewportSize({ width: 393, height: 852 });
      await join(page, "Waiting");
      await expect(page.getByText("YOU'LL PLAY")).toBeVisible({ timeout: 10_000 });
      const host = await connectAsHost("BZQ7");
      host.send({ type: "ASSIGN", clientId: await myId(page), role: "bass" });
      await expect(page.getByText("bass", { exact: true })).toBeVisible({ timeout: 10_000 });
      host.close();
      expect(tooFaint(await printedText(page))).toEqual([]);
    });
  });
});


test.describe("join screen", () => {
  test.use({ mockScenario: "join.json", userAgent: IPHONE_UA });

  // iPhone UA on purpose: it adds the ringer banner, the tallest the screen can be.
  for (const viewport of [SMALLEST, { width: 375, height: 667 }, SAFARI, { width: 393, height: 852 }, { width: 852, height: 393 }]) {
    test(`${viewport.width}x${viewport.height}: "Tap to join" is on screen without scrolling`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto("/j/BZQ7");
      const button = page.getByRole("button", { name: "Tap to join" });
      await expect(button).toBeVisible();
      await expect(page.getByText("Ringer on, please")).toBeVisible();

      await expect(button).toBeInViewport({ ratio: 1 });
      await expect(page.getByPlaceholder("Your name")).toBeInViewport({ ratio: 1 });
      const fit = await page.evaluate(() => ({ page: document.documentElement.scrollHeight, sideways: document.documentElement.scrollWidth, w: innerWidth, h: innerHeight }));
      expect(fit.page, "the page scrolls").toBeLessThanOrEqual(fit.h);
      expect(fit.sideways, "the page scrolls sideways").toBeLessThanOrEqual(fit.w);
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(56);
      expect((await page.getByPlaceholder("Your name").boundingBox())!.height).toBeGreaterThanOrEqual(44);
      // The three-step explainer and the line under the button are what pushed the button off the screen.
      await expect(page.getByText("What happens next")).toHaveCount(0);
    });
  }

  test("a tap in the name box does not join; a tap anywhere else does", async ({ page }) => {
    await page.setViewportSize(SAFARI);
    await page.goto("/j/BZQ7");
    await page.getByPlaceholder("Your name").click();
    await page.getByPlaceholder("Your name").fill("Careful");
    await expect(page.getByRole("button", { name: "Tap to join" })).toBeVisible();
    await expect(page.getByText("Synced", { exact: true })).toHaveCount(0);
    // empty space between the name box and the button
    const box = (await page.getByRole("button", { name: "Tap to join" }).boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y - 40);
    await expect(page.getByText("Synced", { exact: true })).toBeVisible({ timeout: 10_000 });
  });
});

test.describe("tuning screen", () => {
  test.use({ mockScenario: "join.json" });

  /** Puts this phone last in a tuning run of `phones`, five of them already measured. */
  async function tuneWith(page: Page, phones: number) {
    let me = "";
    await page.routeWebSocket(/\/ws$/, (ws) => {
      const server = ws.connectToServer();
      server.onMessage((message) => {
        const msg = JSON.parse(String(message));
        if (msg.type === "WELCOME") me = msg.clientId;
        if (msg.type === "ROOM_STATE") {
          const order = [...Array.from({ length: phones - 1 }, (_, i) => `other-${i}`), me];
          const results = Object.fromEntries(order.slice(0, 5).map((id) => [id, { residualMs: 3, confidence: 0.9 }]));
          msg.room.calibration = { state: "running", referenceClientId: null, startServerTime: msg.room.createdAtServerTime, order, results };
        }
        ws.send(JSON.stringify(msg));
      });
    });
    await join(page, "Tuned");
    await expect(page.getByRole("progressbar")).toBeVisible({ timeout: 10_000 });
  }

  for (const viewport of [SMALLEST, SAFARI, { width: 852, height: 393 }]) {
    test(`${viewport.width}x${viewport.height}: a 64-phone tuning run fits the screen — nothing sideways, nothing below the fold`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await tuneWith(page, 64);
      const fit = await page.evaluate(() => ({ page: document.documentElement.scrollHeight, sideways: document.documentElement.scrollWidth, w: innerWidth, h: innerHeight }));
      expect(fit.sideways, "the page scrolls sideways").toBeLessThanOrEqual(fit.w);
      expect(fit.page, "the page scrolls").toBeLessThanOrEqual(fit.h);
      await expect(page.getByText(/Hold still/)).toBeInViewport({ ratio: 1 });
      await expect(page.getByText(/Phone 6 of 64/)).toBeInViewport({ ratio: 1 });
      // Progress is one bar, however many phones: its width never depends on the head-count.
      const bar = page.getByRole("progressbar");
      await expect(bar).toHaveAttribute("aria-valuenow", "5");
      await expect(bar).toHaveAttribute("aria-valuemax", "64");
      const box = (await bar.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    });
  }
});

test.describe("playing screen", () => {
  test.use({ mockScenario: "party-12.json" });

  for (const viewport of [SMALLEST, SAFARI, { width: 393, height: 852 }, { width: 430, height: 932 }, { width: 852, height: 393 }]) {
    test(`${viewport.width}x${viewport.height}: the rings are centred on the role, not on the screen`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await join(page, "Centred");
      await expect(page.getByText("YOU ARE")).toBeVisible({ timeout: 10_000 });
      const centres = await page.evaluate(() => {
        const mid = (el: Element) => {
          const r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        };
        const labels = document.querySelectorAll("main span.font-display");
        // A ring's own centre: the svg pulses (scales about its centre), which does not move it.
        return { label: mid(labels[labels.length - 1]!), rings: mid(document.querySelector("main svg circle")!) };
      });
      expect(Math.abs(centres.rings.x - centres.label.x), "rings off-centre sideways").toBeLessThanOrEqual(2);
      expect(Math.abs(centres.rings.y - centres.label.y), "rings off-centre vertically").toBeLessThanOrEqual(8);
    });
  }

  test("the mute control is a full-size labelled button, and the page never scrolls", async ({ page }) => {
    await page.setViewportSize(SMALLEST);
    await join(page, "Loud");
    await expect(page.getByText("YOU ARE")).toBeVisible({ timeout: 10_000 });
    for (const viewport of [SMALLEST, SAFARI, { width: 393, height: 852 }]) {
      await page.setViewportSize(viewport);
      const mute = page.getByRole("button", { name: "Mute my phone" });
      await expect(mute).toBeInViewport({ ratio: 1 });
      const box = (await mute.boundingBox())!;
      expect(box.height, `mute height at ${viewport.width}x${viewport.height}`).toBeGreaterThanOrEqual(56);
      expect(box.width).toBeGreaterThanOrEqual(viewport.width - 80);
      await expect(page.getByText("Sponsored")).toBeInViewport({ ratio: 1 });
      await expect(page.getByText(/Creators:/)).toBeInViewport({ ratio: 1 });
      const fit = await page.evaluate(() => ({ page: document.documentElement.scrollHeight, sideways: document.documentElement.scrollWidth, w: innerWidth, h: innerHeight }));
      expect(fit.page).toBeLessThanOrEqual(fit.h);
      expect(fit.sideways).toBeLessThanOrEqual(fit.w);
    }
  });
});

test.describe("landing page", () => {
  test.use({ mockScenario: "join.json" });

  const HEADLINE = "Party wherever. Party together. Become the speaker.";

  async function headline(page: Page) {
    const h1 = page.getByRole("heading", { level: 1 });
    await expect(h1).toHaveText(HEADLINE);
    return h1.evaluate((el) => {
      const cs = getComputedStyle(el);
      const fontSize = parseFloat(cs.fontSize);
      const sentences = [...el.querySelectorAll("span")].map((s) => ({ text: s.textContent!.trim(), lines: Math.round(s.getBoundingClientRect().height / (fontSize * 1.02)) }));
      const r = el.getBoundingClientRect();
      return { fontSize, align: cs.textAlign, left: r.left, right: r.right, sentences };
    });
  }

  async function scrolls(page: Page) {
    return page.evaluate(() => ({ down: document.documentElement.scrollHeight - innerHeight, sideways: document.documentElement.scrollWidth - innerWidth }));
  }

  for (const viewport of [SMALLEST, { width: 375, height: 667 }, SAFARI, { width: 393, height: 852 }]) {
    test(`${viewport.width}x${viewport.height}: headline, both actions, creators and GitHub fit one screen`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto("/");
      const h = await headline(page);
      expect(h.align).toBe("center");
      expect(h.left).toBeGreaterThanOrEqual(0);
      expect(h.right).toBeLessThanOrEqual(viewport.width);
      // No sentence is broken in an awkward place: the two short ones hold a line each, and the
      // third takes at most two ("Become the / speaker.").
      expect(h.sentences.map((s) => s.text)).toEqual(["Party wherever.", "Party together.", "Become the speaker."]);
      expect(h.sentences[0]!.lines).toBe(1);
      expect(h.sentences[1]!.lines).toBe(1);
      expect(h.sentences[2]!.lines).toBeLessThanOrEqual(2);
      expect(h.fontSize, "the headline is still a headline").toBeGreaterThanOrEqual(34);

      expect(await scrolls(page)).toEqual({ down: 0, sideways: 0 });
      for (const el of [
        page.getByRole("button", { name: "Host a hive" }),
        page.getByLabel("Hive code"),
        page.getByRole("button", { name: "Join" }),
        page.getByText("Creators: Frank Lucci & Jaeho Lee"),
        page.getByRole("link", { name: "HiveMusic on GitHub" }),
      ]) {
        await expect(el).toBeInViewport({ ratio: 1 });
      }
      // The byline stays prominent, and GitHub stays a bar with its mark.
      const byline = await page.getByText("Creators: Frank Lucci & Jaeho Lee").evaluate((el) => ({ size: parseFloat(getComputedStyle(el).fontSize), height: el.getBoundingClientRect().height }));
      expect(byline.size).toBeGreaterThanOrEqual(17);
      expect(byline.height, "the byline wraps").toBeLessThan(byline.size * 1.8);
      const github = (await page.getByRole("link", { name: "HiveMusic on GitHub" }).boundingBox())!;
      expect(github.height).toBeGreaterThanOrEqual(44);
      expect(github.width).toBeGreaterThanOrEqual(viewport.width - 48);
      await expect(page.getByRole("link", { name: "HiveMusic on GitHub" }).locator("svg")).toHaveCount(1);
    });
  }

  test("320x568: the too-short-code message does not push anything off the screen", async ({ page }) => {
    await page.setViewportSize(SMALLEST);
    await page.goto("/");
    await page.getByRole("button", { name: "Join" }).click();
    await expect(page.locator("main").getByRole("alert")).toBeVisible();
    expect(await scrolls(page)).toEqual({ down: 0, sideways: 0 });
    await expect(page.getByRole("link", { name: "HiveMusic on GitHub" })).toBeInViewport({ ratio: 1 });
  });

  test("852x393 sideways: both actions are on screen without scrolling", async ({ page }) => {
    await page.setViewportSize({ width: 852, height: 393 });
    await page.goto("/");
    await headline(page);
    expect(await scrolls(page)).toEqual({ down: 0, sideways: 0 });
    await expect(page.getByRole("button", { name: "Host a hive" })).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole("button", { name: "Join" })).toBeInViewport({ ratio: 1 });
  });

  for (const viewport of [{ width: 1280, height: 720 }, { width: 1920, height: 1080 }]) {
    test(`${viewport.width}x${viewport.height} desktop: one sentence a line, large, nothing to scroll`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto("/");
      const h = await headline(page);
      expect(h.sentences.map((s) => s.lines)).toEqual([1, 1, 1]);
      expect(h.fontSize).toBeGreaterThanOrEqual(64);
      expect(await scrolls(page)).toEqual({ down: 0, sideways: 0 });
      // The actions stay a hand-sized column instead of stretching across the monitor.
      expect((await page.getByRole("button", { name: "Host a hive" }).boundingBox())!.width).toBeLessThanOrEqual(480);
    });
  }
});

test.describe("one voice", () => {
  test.use({ mockScenario: "join.json", userAgent: IPHONE_UA });

  test("the guest's way in has no engineer words and no filler", async ({ page }) => {
    await page.setViewportSize({ width: 393, height: 852 });
    await page.goto("/j/BZQ7");
    await expect(page.getByText("Silent mode mutes the music. Flip the side switch.")).toBeVisible();
    const jargon = /web audio|clock|stem|latency|\bms\b|offset|socket|server|protocol/i;
    expect(await page.locator("main").innerText()).not.toMatch(jargon);

    await page.getByPlaceholder("Your name").fill("Plain");
    await page.getByRole("button", { name: "Tap to join" }).click();
    await expect(page.getByText("YOU'LL PLAY")).toBeVisible({ timeout: 10_000 });
    // The download card says when it is done instead of showing a finished "downloading" forever.
    await expect(page.getByText("Song ready")).toBeVisible();
    await expect(page.getByText("The host can change this during the show.")).toHaveCount(0);
    expect(await page.locator("main").innerText()).not.toMatch(jargon);
  });
});
