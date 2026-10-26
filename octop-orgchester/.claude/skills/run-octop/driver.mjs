// REPL driver for the Octop dashboard (browser-driven web app), served by
// the `octop` container at http://localhost:8088 (see ../../../docker-compose.yml).
// Headless Chromium via Playwright. Run under tmux, send-keys one command
// at a time — same session, no relaunch between commands.
import { chromium } from "playwright";
import * as readline from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";

const SHOT_DIR = process.env.SCREENSHOT_DIR || "/tmp/shots";
fs.mkdirSync(SHOT_DIR, { recursive: true });

const BASE_URL = process.env.OCTOP_URL || "http://localhost:8088";

let browser = null;
let page = null;
const consoleLog = [];

const COMMANDS = {
  async launch() {
    if (browser) return console.log("already launched");
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    page.on("console", (msg) => consoleLog.push(`[${msg.type()}] ${msg.text()}`));
    page.on("pageerror", (err) => consoleLog.push(`[pageerror] ${err.message}`));
    console.log("launched.");
  },

  async nav(url) {
    if (!page) return console.log("ERROR: launch first");
    const target = url || BASE_URL;
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30_000 });
    console.log("nav ->", page.url());
  },

  // UI login (POST /api/auth/login under the hood, via the real form) —
  // the username input has no stable attribute other than being the
  // drawer's first text box; the password one is `input[type=password]`.
  // Enter submits (the component wires onPressEnter to handleLogin).
  async login(args) {
    if (!page) return console.log("ERROR: launch first");
    const [user, pass] = args.split(/\s+/);
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
    const userInput = page.locator("input").first();
    const passInput = page.locator('input[type="password"]');
    await userInput.waitFor({ timeout: 10_000 });
    await userInput.fill(user);
    await passInput.fill(pass);
    await COMMANDS["slide-captcha"]();
    await passInput.press("Enter");
    try {
      await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 10_000 });
      console.log("login OK ->", page.url());
    } catch {
      console.log("login TIMEOUT, still at", page.url());
    }
  },

  // Login has a client-side-only drag-to-verify slider
  // (SlideCaptcha.tsx) — no server round trip, just a mousedown on the
  // thumb + mousemove to ≥92% of the track width + mouseup. Needs real
  // mouse events (not DOM .click()) since it listens on `window`.
  async "slide-captcha"() {
    if (!page) return console.log("ERROR: launch first");
    const track = page.locator('[data-testid="slide-captcha-track"]');
    const thumb = page.locator('[data-testid="slide-captcha-thumb"]');
    const trackBox = await track.boundingBox();
    const thumbBox = await thumb.boundingBox();
    if (!trackBox || !thumbBox) return console.log("ERROR: captcha not found");
    const startX = thumbBox.x + thumbBox.width / 2;
    const startY = thumbBox.y + thumbBox.height / 2;
    const endX = trackBox.x + trackBox.width - thumbBox.width / 2 - 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(startX + ((endX - startX) * i) / steps, startY, { steps: 2 });
    }
    await page.mouse.up();
    console.log("slide-captcha -> dragged to", Math.round(endX));
  },

  async click(sel) {
    if (!page) return console.log("ERROR: launch first");
    try {
      await page.locator(sel).first().click({ timeout: 10_000 });
      console.log("click", sel, "-> OK");
    } catch (e) {
      console.log("click", sel, "-> ERROR:", e.message);
    }
  },

  async "click-text"(text) {
    if (!page) return console.log("ERROR: launch first");
    try {
      await page.getByText(text, { exact: false }).first().click({ timeout: 10_000 });
      console.log("click-text", JSON.stringify(text), "-> OK");
    } catch (e) {
      console.log("click-text", JSON.stringify(text), "-> ERROR:", e.message);
    }
  },

  async fill(args) {
    if (!page) return console.log("ERROR: launch first");
    const [sel, ...rest] = args.split(/\s+/);
    const text = rest.join(" ");
    await page.locator(sel).first().fill(text);
    console.log("fill", sel, "->", JSON.stringify(text));
  },

  async type(text) {
    if (page) await page.keyboard.type(text, { delay: 20 });
  },
  async press(key) {
    if (page) await page.keyboard.press(key);
  },

  async wait(sel) {
    if (!page) return console.log("ERROR: launch first");
    try {
      await page.locator(sel).first().waitFor({ timeout: 15_000 });
      console.log("found:", sel);
    } catch {
      console.log("TIMEOUT:", sel);
    }
  },

  async "wait-text"(text) {
    if (!page) return console.log("ERROR: launch first");
    try {
      await page.getByText(text, { exact: false }).first().waitFor({ timeout: 15_000 });
      console.log("found text:", JSON.stringify(text));
    } catch {
      console.log("TIMEOUT waiting for text:", JSON.stringify(text));
    }
  },

  async "has-text"(text) {
    if (!page) return console.log("ERROR: launch first");
    const count = await page.getByText(text, { exact: false }).count();
    console.log(count > 0 ? `YES (${count})` : "NO", "-", JSON.stringify(text));
  },

  async ss(name) {
    if (!page) return console.log("ERROR: launch first");
    const f = path.join(SHOT_DIR, (name || `ss-${Date.now()}`) + ".png");
    await page.screenshot({ path: f, fullPage: true });
    console.log("screenshot:", f);
  },

  async eval(expr) {
    if (!page) return console.log("ERROR: launch first");
    try {
      console.log(JSON.stringify(await page.evaluate(expr)));
    } catch (e) {
      console.log("ERROR:", e.message);
    }
  },

  async text(sel) {
    if (!page) return console.log("ERROR: launch first");
    console.log(
      await page.evaluate(
        (s) => (s ? document.querySelector(s) : document.body)?.innerText ?? "(null)",
        sel || null,
      ),
    );
  },

  async url() {
    console.log(page ? page.url() : "(not launched)");
  },

  async console(flag) {
    const lines = flag === "--errors"
      ? consoleLog.filter((l) => l.startsWith("[error]") || l.startsWith("[pageerror]"))
      : consoleLog;
    if (lines.length === 0) console.log("(none)");
    else lines.forEach((l) => console.log(l));
  },

  async quit() {
    if (browser) await browser.close().catch(() => {});
    browser = null;
    page = null;
  },
  help() {
    console.log("commands:", Object.keys(COMMANDS).join(", "));
  },
};

const stdin = fs.createReadStream(null, { fd: fs.openSync("/dev/stdin", "r") });
const rl = readline.createInterface({ input: stdin, output: process.stdout, prompt: "driver> " });

rl.on("line", async (line) => {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  if (!cmd) return rl.prompt();
  const fn = COMMANDS[cmd];
  if (!fn) {
    console.log("unknown:", cmd, "- try: help");
    return rl.prompt();
  }
  try {
    await fn(rest.join(" "));
  } catch (e) {
    console.log("ERROR:", e.message);
  }
  if (cmd === "quit") {
    rl.close();
    process.exit(0);
  }
  rl.prompt();
});
rl.on("close", async () => {
  await COMMANDS.quit();
  process.exit(0);
});

console.log("octop driver - \"help\" for commands, \"launch\" to start");
rl.prompt();
