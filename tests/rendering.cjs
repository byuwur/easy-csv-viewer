/*
 * File: tests/rendering.cjs
 * Desc: CSV library contracts using local renderer assets; playground checks live in playground.cjs.
 */

// --- DEPENDENCIES ---
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { chromium, firefox, webkit } = require("playwright");
const browserEngine = process.env.BROWSER_ENGINE || "chromium";
assert.ok(["chromium", "firefox", "webkit"].includes(browserEngine), "Unsupported BROWSER_ENGINE");
const browserType = { chromium, firefox, webkit }[browserEngine];
// Browser channels and executable overrides apply only to Chromium.
const launchBrowser = () =>
  browserType.launch(
    browserEngine === "chromium"
      ? {
          channel: process.env.BROWSER_CHANNEL || undefined,
          executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined
        }
      : {}
  );

// --- THEME FIXTURES ---
// Caller-provided legacy stylesheets reuse the canonical palettes without distribution files.
const legacyThemeCSS = (theme) => {
  const css = require("node:fs").readFileSync(path.join(__dirname, "../csv.css"), "utf8");
  const section = css.split(`/* --- ${theme.toUpperCase()} --- */`)[1];
  return `.byCSVdocument {${section.match(/\{([\s\S]*?)\}/)[1]}}`;
};

// --- STANDALONE RENDERER ---
test("CSV parsing and standalone browser behavior", async (t) => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // This generated host exercises the library without reading the playground's index.html.
    await page.route("http://viewer.test/**", (route) => {
      const filename = new URL(route.request().url()).pathname.slice(1);
      if (/^csv\.(light|dark)\.css$/.test(filename)) return route.fulfill({ body: legacyThemeCSS(filename.includes(".dark.css") ? "dark" : "light"), contentType: "text/css" });
      if (!filename || filename === "fixture.html")
        return route.fulfill({
          contentType: "text/html",
          body: '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="csv.css"><script src="csv.js"></script><div id="viewer" data-theme="light"></div>'
        });
      return route.fulfill({ path: path.join(__dirname, "..", filename), contentType: filename.endsWith(".css") ? "text/css" : "text/javascript" });
    });
    await page.goto("http://viewer.test/fixture.html");
    await page.evaluate(
      async ({ source, second, options }) => {
        await byCSVviewer(document.getElementById("viewer"), source, options).ready;
      },
      {
        source: 'Name,Role,Location,Notes\nAndres,Developer,Bogota,"Build small, useful things."\nSam,Designer,London,"Quotes: ""hello"""\nLee,Engineer,Tokyo,"A note that spans\ntwo lines."\nAlex,Maintainer,Oslo,Ready',
        options: { fontSizeControls: true, delimiter: ",", headers: true, skipEmptyLines: true, pageSize: 50, search: true, columnFilters: true, copyCells: true }
      }
    );
    await page.waitForFunction(() => document.querySelector("tbody tr"));
    await page.evaluate(() => {
      window.copies = [];
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value) => copies.push(value) } });
      window.root = document.getElementById("viewer");
    });
    await t.test("quotes, escaped quotes, delimiters, BOM, and multiline values", async () => {
      const parsed = await page.evaluate(() => byCSVviewer.parse('\uFEFFname,notes\r\n"A,B","a""b\r\nc"\r\n"",x\n'));
      assert.deepEqual(parsed, {
        columns: ["name", "notes"],
        rows: [
          ["A,B", 'a"b\r\nc'],
          ["", "x"]
        ]
      });
      assert.deepEqual(await page.evaluate(() => byCSVviewer.parse("a\tb\n1\t2", { delimiter: "\t" }).rows), [["1", "2"]]);
    });
    await t.test("strict malformed input, field counts, and empty data", async () => {
      assert.deepEqual(await page.evaluate(() => [byCSVviewer.parse(""), byCSVviewer.parse("a,b\n"), byCSVviewer.parse("1,2", { headers: false })]), [
        { columns: [], rows: [] },
        { columns: ["a", "b"], rows: [] },
        { columns: ["Column 1", "Column 2"], rows: [["1", "2"]] }
      ]);
      assert.equal(
        await page.evaluate(() =>
          ['a\n"unclosed', 'a\n"x"bad', "a\nx,y", 'a\na"b'].every((source) => {
            try {
              byCSVviewer.parse(source);
              return false;
            } catch (error) {
              return error instanceof SyntaxError;
            }
          })
        ),
        true
      );
      assert.equal(await page.evaluate(async () => await byCSVviewer(root, 'a\n"bad').ready), false);
      assert.match(await page.locator('[role="alert"]').textContent(), /Unclosed/);
    });
    await t.test("objects preserve values, union keys, and special property names", async () => {
      const parsed = await page.evaluate(() => byCSVviewer.parse([JSON.parse('{"__proto__":"safe","n":0}'), { n: false, other: null }]));
      assert.deepEqual(parsed.columns, ["__proto__", "n", "other"]);
      assert.equal(parsed.rows[0][1], 0);
      assert.equal(parsed.rows[1][1], false);
    });
    await t.test("sorting, pagination, search, filters, visibility, and cell copying", async () => {
      await page.evaluate(async () => {
        await byCSVviewer(root, "name,n\nZed,10\nAmy,2\nBob,1", { search: true, columnFilters: true, copyCells: true, columnsButton: true, pageSize: 2 }).ready;
      });
      assert.equal(await page.locator("tbody tr").count(), 2);
      await page.getByRole("button", { name: "Sort by n", exact: true }).focus();
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.querySelector("tbody tr")?.textContent === "Bob1");
      assert.equal(await page.locator('th[aria-sort="ascending"]').count(), 1);
      assert.equal(await page.getByRole("button", { name: "Sort by n", exact: true }).evaluate((button) => button === document.activeElement), true);
      assert.equal(await page.locator('th[aria-sort="ascending"] button').evaluate((button) => getComputedStyle(button, "::after").content), '"\u2191"');
      await page.getByRole("button", { name: "Next page" }).click();
      assert.match(await page.locator("tbody").textContent(), /Zed/);
      await page.getByRole("searchbox", { name: "Search all columns" }).fill("amy");
      await page.waitForFunction(() => document.querySelector("tbody")?.textContent === "Amy2");
      await page.getByRole("searchbox", { name: "Search all columns" }).fill("");
      await page.getByRole("searchbox", { name: "Filter name", exact: true }).pressSequentially("bo", { delay: 30 });
      await page.waitForFunction(() => document.querySelector("tbody")?.textContent === "Bob1");
      assert.equal(await page.getByRole("searchbox", { name: "Filter name", exact: true }).inputValue(), "bo");
      assert.equal(await page.getByRole("searchbox", { name: "Filter name", exact: true }).evaluate((input) => input === document.activeElement), true);
      await page.getByRole("button", { name: "Copy name value", exact: true }).click();
      assert.equal(await page.evaluate(() => copies.at(-1)), "Bob");
      await page.locator("summary").click();
      await page.getByLabel("n", { exact: true }).uncheck();
      assert.equal(await page.locator("tbody td").count(), 1);
    });
    await t.test("column sorting cycles through ascending, descending, and filtered input order", async () => {
      const settle = () => page.waitForFunction(() => root.getAttribute("aria-busy") === "false");
      const names = () => page.locator("tbody tr td:first-child").allTextContents();
      const initialTheme = await page.locator("#viewer").getAttribute("data-theme");
      try {
        for (const theme of ["light", "dark"]) {
          await page.evaluate(async (theme) => {
            root.dataset.theme = theme;
            window.sortInput = Object.freeze(
              [
                { name: "Zed", score: 10, group: "keep" },
                { name: "Cara", score: 1, group: "keep" },
                { name: "amy", score: 2, group: "keep" },
                { name: "Bob", score: 2, group: "skip" },
                { name: "AMY", score: 2, group: "keep" }
              ].map((record) => Object.freeze(record))
            );
            window.sortSnapshot = JSON.stringify(sortInput);
            await byCSVviewer(root, sortInput, { search: true, columnFilters: true, pageSize: 2 }).ready;
          }, theme);
          await page.getByRole("searchbox", { name: "Search all columns" }).fill("keep");
          await settle();
          await page.getByRole("searchbox", { name: "Filter group", exact: true }).fill("keep");
          await settle();
          const score = page.getByRole("button", { name: "Sort by score", exact: true });
          for (const [state, key, first, second, arrow] of [
            ["ascending", "Enter", ["Cara", "amy"], ["AMY", "Zed"], "\u2191"],
            ["descending", "Space", ["Zed", "amy"], ["AMY", "Cara"], "\u2193"],
            ["none", "Enter", ["Zed", "Cara"], ["amy", "AMY"], "\u2195"]
          ]) {
            await score.press(key);
            await settle();
            assert.deepEqual(await names(), first);
            assert.equal(await score.evaluate((button) => button.closest("th").getAttribute("aria-sort")), state);
            assert.equal(await score.evaluate((button) => getComputedStyle(button, "::after").content), `"${arrow}"`);
            assert.equal(await page.getByRole("button", { name: "Previous page" }).isDisabled(), true);
            assert.equal(await score.evaluate((button) => button === document.activeElement), true);
            await page.getByRole("button", { name: "Next page" }).click();
            assert.deepEqual(await names(), second);
          }
          assert.equal(await page.getByRole("searchbox", { name: "Search all columns" }).inputValue(), "keep");
          assert.equal(await page.getByRole("searchbox", { name: "Filter group", exact: true }).inputValue(), "keep");
          assert.equal(await page.locator('th[aria-sort="none"]').count(), 3);
          await score.click();
          await settle();
          await score.click();
          await settle();
          const byName = page.getByRole("button", { name: "Sort by name", exact: true });
          await byName.click();
          await settle();
          assert.deepEqual(await names(), ["amy", "AMY"]);
          assert.equal(await byName.evaluate((button) => button.closest("th").getAttribute("aria-sort")), "ascending");
          assert.equal(await score.evaluate((button) => button.closest("th").getAttribute("aria-sort")), "none");
          assert.equal(await page.evaluate(() => JSON.stringify(sortInput) === sortSnapshot), true);
        }
      } finally {
        await page.locator("#viewer").evaluate((element, theme) => {
          if (theme === null) element.removeAttribute("data-theme");
          else element.setAttribute("data-theme", theme);
        }, initialTheme);
      }
    });

    await t.test("injection stays text; theme, font, and narrow layout work", async () => {
      await page.evaluate(async () => {
        await byCSVviewer(root, 'name\n<img src=x onerror="window.injected=1">', { fontSizeControls: true, controlsCompact: true, controlsSize: "small", controlsPosition: "bottom" }).ready;
      });
      assert.equal(await page.locator("#viewer img").count(), 0);
      assert.equal(await page.evaluate(() => window.injected), undefined);
      await page.getByRole("button", { name: "Switch to dark theme" }).click();
      await page.waitForFunction(() => getComputedStyle(root).backgroundColor === "rgb(39, 40, 34)");
      await page.waitForFunction(() => getComputedStyle(root).backgroundColor === "rgb(39, 40, 34)");
      await page.getByRole("button", { name: "Increase text size" }).click();
      assert.equal(await page.evaluate(() => root.style.fontSize), "1.125rem");
      await page.setViewportSize({ width: 320, height: 640 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    });
    await t.test("wide tables scroll and cell-copy toggles preserve layout", async () => {
      const source = [
        ["Name", "Role", "Location", "Notes"],
        ["Andres", "Developer", "Bogota", "Build small, useful things."],
        ["Alex", "Maintainer", "San Francisco", "First line\nSecond line"],
        ["", "", "", ""],
        ["Lee", "Engineer", "Tokyo", "https://example.com/" + "segment".repeat(20)]
      ];
      const measure = () =>
        page.locator(".byCSVtable").evaluate((table) =>
          [...table.querySelectorAll("th, td")].map((cell) => {
            const rect = cell.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, padding: getComputedStyle(cell).padding };
          })
        );
      try {
        for (const width of [320, 640]) {
          await page.setViewportSize({ width: width + 16, height: 800 });
          for (const theme of ["light", "dark"]) {
            for (const columnFilters of [false, true]) {
              await page.evaluate(
                async ({ width, theme, source, columnFilters }) => {
                  root.style.width = `${width}px`;
                  root.style.fontFamily = "Georgia, serif";
                  root.dataset.theme = theme;
                  await byCSVviewer(root, source, { columnFilters, copyCells: false }).ready;
                },
                { width, theme, source, columnFilters }
              );
              const plain = await measure();
              assert.equal(await page.locator(".byCSVscroll").evaluate((scroll) => scroll.scrollWidth > scroll.clientWidth), true);
              assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
              assert.equal(
                await page.getByRole("button", { name: "Sort by Location", exact: true }).evaluate((button) => {
                  const range = document.createRange();
                  range.selectNode(button.firstChild);
                  return range.getClientRects().length;
                }),
                1
              );
              if (columnFilters) assert.ok(await page.getByRole("searchbox", { name: "Filter Name", exact: true }).evaluate((input) => input.getBoundingClientRect().height < 30));
              await page.evaluate(
                async ({ source, columnFilters }) => {
                  await byCSVviewer(root, source, { columnFilters, copyCells: true }).ready;
                },
                { source, columnFilters }
              );
              assert.deepEqual(await measure(), plain, `${width}px ${theme}: copying must not resize cells`);
              assert.equal(
                await page
                  .locator("tbody td .byCSVcell")
                  .first()
                  .evaluate((button) => getComputedStyle(button).fontFamily === getComputedStyle(button.parentElement).fontFamily),
                true
              );
              const copy = page.locator("tbody td .byCSVcell").first();
              await copy.click();
              assert.equal(await page.evaluate(() => copies.at(-1)), "Andres");
              assert.equal(await copy.textContent(), "Andres");
              assert.equal(await copy.getAttribute("data-state"), "success");
              assert.deepEqual(await measure(), plain, "Copy confirmation must not move the table");
              await page.evaluate(() => {
                navigator.clipboard.writeText = async () => {
                  throw new Error("Denied");
                };
              });
              await copy.click();
              assert.equal(await copy.textContent(), "Andres");
              assert.equal(await copy.getAttribute("data-state"), "error");
              assert.deepEqual(await measure(), plain, "Copy errors must not move the table");
              await page.evaluate(() => {
                navigator.clipboard.writeText = async (value) => copies.push(value);
              });
              const blank = page.locator("tbody tr").nth(2).locator(".byCSVcell").first();
              await blank.click();
              assert.equal(await page.evaluate(() => copies.at(-1)), "");
              assert.equal(await blank.textContent(), "");
              await page.locator(".byCSVscroll").evaluate((scroll) => {
                scroll.scrollLeft = 0;
              });
              assert.deepEqual(await measure(), plain, "Empty cells keep their size after copying");
            }
          }
        }
        await page.locator(".byCSVscroll").focus();
        await page.keyboard.press("ArrowRight");
        await page.waitForFunction(() => document.querySelector(".byCSVscroll").scrollLeft > 0);
      } finally {
        await page.evaluate(() => {
          root.style.width = "";
          root.style.fontFamily = "";
          navigator.clipboard.writeText = async (value) => copies.push(value);
        });
        await page.setViewportSize({ width: 1100, height: 800 });
      }
    });

    await t.test("large inputs yield, keep DOM bounded, and replacement cancels stale work", async () => {
      const result = await page.evaluate(async () => {
        const large = `id,value\n${Array.from({ length: 20000 }, (_, i) => `${i},value ${i}`).join("\n")}`;
        let ticked = false;
        setTimeout(() => {
          ticked = true;
        }, 0);
        const job = byCSVviewer(root, large);
        const ready = await job.ready;
        const rows = root.querySelectorAll("tbody tr").length;
        const obsolete = byCSVviewer(root, large);
        const current = byCSVviewer(root, "x\nnew");
        return { ticked, ready, rows, old: await obsolete.ready, current: await current.ready, text: root.querySelector("tbody").textContent };
      });
      assert.deepEqual(result, { ticked: true, ready: true, rows: 50, old: false, current: true, text: "new" });
    });
    await t.test("duplicate loading and disposal", async () => {
      await page.evaluate(() => {
        window.original = byCSVviewer;
      });
      await page.addScriptTag({ path: path.join(__dirname, "../csv.js") });
      assert.equal(await page.evaluate(() => original === byCSVviewer), true);
      assert.equal(
        await page.evaluate(async () => {
          const view = byCSVviewer(root, "a\n1");
          await view.ready;
          view.destroy();
          return root.childNodes.length;
        }),
        0
      );
    });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

// --- CONTAINER THEMES ---
test("container themes are scoped, independent, and compatible with legacy links", async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const requests = [];
    page.on("request", (request) => requests.push(request.url()));
    await page.setContent('<div id="outside" class="dark">Host</div><div id="first" data-theme="dark"></div><div id="second" class="light"></div><div id="third"></div>');
    await page.addStyleTag({ path: path.join(__dirname, "../csv.css") });
    await page.addScriptTag({ path: path.join(__dirname, "../csv.js") });
    await page.evaluate(
      async (args) => {
        window.renderTheme = async (element) => {
          const controller = window.byCSVviewer(element, ...args.slice(0, 1), { ...args[1], animations: false });
          if (controller?.ready) await controller.ready;
        };
        for (const id of ["first", "second", "third"]) await renderTheme(document.getElementById(id));
      },
      ["name\nLocal theme"]
    );
    const color = (id) => page.locator("#" + id).evaluate((element) => getComputedStyle(element).backgroundColor);
    assert.equal(await color("first"), "rgb(39, 40, 34)");
    assert.equal(await color("second"), "rgb(250, 250, 245)");
    assert.equal(await page.locator("#outside").evaluate((element) => getComputedStyle(element).getPropertyValue("--by-view-muted")), "");
    assert.equal(await page.locator("#first .byVIEWtoolbar").evaluate((element) => getComputedStyle(element).getPropertyValue("--by-view-muted").trim()), "#75715e");
    await page.locator("#first .byVIEWthemeToggle").click();
    assert.equal(await page.locator("#first").getAttribute("data-theme"), "light");
    assert.equal(await color("second"), "rgb(250, 250, 245)");
    await page.locator("#second .byVIEWthemeToggle").click();
    assert.equal(
      await page
        .locator("#second")
        .getAttribute("class")
        .then((classes) => classes.split(/\s+/).includes("dark")),
      true
    );
    assert.equal(await page.locator("#second").getAttribute("data-theme"), null);
    assert.equal(await color("second"), "rgb(39, 40, 34)");
    await page.evaluate(async () => {
      const second = document.getElementById("second");
      second.dataset.theme = "light";
      await renderTheme(second);
    });
    assert.equal(await color("second"), "rgb(250, 250, 245)");
    await page.evaluate(() => {
      const first = document.getElementById("first");
      first.style.setProperty("--by-view-bg", "#123456");
    });
    assert.equal(await color("first"), "rgb(18, 52, 86)");
    assert.equal(await color("second"), "rgb(250, 250, 245)");
    await page.evaluate(() => document.getElementById("first").style.removeProperty("--by-view-bg"));
    assert.equal(requests.length, 0, "Container theme changes must not fetch stylesheets");

    await page.route("https://legacy.test/**", (route) => route.fulfill({ body: legacyThemeCSS(route.request().url().includes(".dark.css") ? "dark" : "light"), contentType: "text/css" }));
    await page.evaluate(async () => {
      const second = document.getElementById("second");
      second.removeAttribute("data-theme");
      second.classList.remove("light", "dark");
      await new Promise((resolve, reject) => {
        const link = document.createElement("link");
        link.id = "byVIEWtheme";
        link.rel = "stylesheet";
        link.href = "https://legacy.test/csv.light.css?cache=1#theme";
        link.onload = resolve;
        link.onerror = reject;
        document.head.appendChild(link);
      });
      await renderTheme(second);
      await renderTheme(document.getElementById("third"));
    });
    await page.locator("#second .byVIEWthemeToggle").click();
    await page.waitForFunction(() => getComputedStyle(document.getElementById("second")).backgroundColor === "rgb(39, 40, 34)");
    assert.equal(await color("third"), "rgb(39, 40, 34)");
    assert.equal(await color("first"), "rgb(250, 250, 245)");
    assert.equal(await page.locator("#first .byVIEWthemeToggle").getAttribute("aria-label"), "Switch to dark theme");
    assert.equal(await page.locator("#byVIEWtheme").getAttribute("href"), "https://legacy.test/csv.dark.css?cache=1#theme");
    await page.evaluate(async () => {
      document.getElementById("byVIEWtheme").remove();
      await renderTheme(document.getElementById("second"));
    });
    await page.locator("#second .byVIEWthemeToggle").click();
    assert.equal(await page.locator("#second").getAttribute("data-theme"), "dark");
    assert.equal(await color("third"), "rgb(250, 250, 245)");
  } finally {
    await browser.close();
  }
});

// --- PALETTES AND CONTRAST ---
test("named palettes retain mode, isolate custom CSS, and meet High Contrast targets", async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const warnings = [];
    page.on("console", (message) => {
      if (message.type() === "warning" && message.text().includes("csv.themes.css")) warnings.push(message.text());
    });
    await page.setContent('<div id="outside">Host</div><div id="viewer"></div><div id="other" data-theme="dark"></div>');
    await page.addStyleTag({ path: path.join(__dirname, "../csv.css") });
    await page.addScriptTag({ path: path.join(__dirname, "../csv.js") });
    await page.evaluate(
      async (args) => {
        window.renderPalette = async (id) => {
          const controller = window.byCSVviewer(document.getElementById(id), ...args.slice(0, 1), { ...args[1], animations: false });
          if (controller?.ready) await controller.ready;
        };
        await renderPalette("viewer");
        await renderPalette("other");
      },
      ["name,value\nTheme,1"]
    );
    const root = page.locator("#viewer");
    const background = () => root.evaluate((element) => getComputedStyle(element).backgroundColor);
    assert.equal(await background(), "rgb(250, 250, 245)", "Default remains Monokai Light");
    for (const [palette, colors] of Object.entries({
      monokai: ["rgb(250, 250, 245)", "rgb(39, 40, 34)"],
      github: ["rgb(255, 255, 255)", "rgb(13, 17, 23)"],
      solarized: ["rgb(253, 246, 227)", "rgb(0, 43, 54)"],
      "high-contrast": ["rgb(255, 255, 255)", "rgb(0, 0, 0)"]
    })) {
      await root.evaluate((element, palette) => {
        element.dataset.theme = palette;
        element.classList.remove("light", "dark");
      }, palette);
      assert.equal(await background(), colors[0], palette);
      await root.locator(".byVIEWthemeToggle").click();
      assert.equal(await root.getAttribute("data-theme"), palette);
      assert.equal(await background(), colors[1], palette);
      await page.evaluate(() => renderPalette("viewer"));
      assert.equal(await background(), colors[1], "Rendering preserves the palette and mode");
      await root.locator(".byVIEWthemeToggle").click();
      assert.equal(await background(), colors[0]);
    }
    assert.equal(warnings.length, 0, "Core palettes need no optional pack");
    await root.evaluate((element) => {
      element.dataset.theme = "dracula";
    });
    await page.evaluate(() => renderPalette("viewer"));
    assert.match(warnings[0], /csv\.themes\.css/);
    await page.evaluate(() => renderPalette("viewer"));
    assert.equal(warnings.length, 1, "Repeated renders do not repeat a missing-pack warning");
    await root.evaluate((element) => {
      element.dataset.theme = "custom-user";
    });
    await page.evaluate(() => renderPalette("viewer"));
    assert.equal(warnings.length, 1, "Custom CSS names are supported without a pack");
    await page.addStyleTag({ path: path.join(__dirname, "../csv.themes.css") });
    await root.evaluate((element) => {
      element.dataset.theme = "bubblegum";
    });
    await page.evaluate(() => renderPalette("viewer"));
    assert.equal(warnings.length, 1, "Loaded packs do not warn for other presets");
    const paletteSelect = require("node:fs")
      .readFileSync(path.join(__dirname, "../index.html"), "utf8")
      .match(/<select id="preview-palette"[\s\S]*?<\/select>/)[0];
    const paletteNames = [...paletteSelect.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]).filter((name) => name !== "custom");
    assert.equal(paletteNames.length, 48);
    assert.equal(new Set(paletteNames).size, 48);
    const readme = require("node:fs").readFileSync(path.join(__dirname, "../README.md"), "utf8");
    for (const name of paletteNames) assert.match(readme, new RegExp("\\|\\s*`" + name + "`\\s*\\|"), `${name} must be documented`);
    const failures = await root.evaluate((element, names) => {
      const luminance = (value) => {
        const channels = value.startsWith("#")
          ? value
              .slice(1)
              .match(/../g)
              .map((part) => parseInt(part, 16))
          : value
              .match(/[\d.]+/g)
              .slice(0, 3)
              .map(Number);
        const linear = channels.map((channel) => channel / 255).map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
        return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
      };
      const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
      const failures = [];
      for (const name of names.filter((name) => !["monokai", "github", "solarized", "high-contrast"].includes(name))) {
        element.dataset.theme = name;
        for (const mode of ["light", "dark"]) {
          element.classList.toggle("dark", mode === "dark");
          element.classList.toggle("light", mode === "light");
          const style = getComputedStyle(element);
          const variables = [...style].map((name) => [name, style.getPropertyValue(name).trim()]).filter(([, value]) => /^#[\da-f]{6}$/i.test(value));
          const backgrounds = [style.backgroundColor, ...variables.filter(([name]) => /-(?:alt|code-bg|add|remove)$/.test(name)).map(([, value]) => value)];
          const textColors = [["text", style.color], ...variables.filter(([name]) => /-(?:text|secondary|accent|string|literal|error|warn|info|debug|comment|keyword|number|property|tag|link|quote|toggle|placeholder|muted)$/.test(name))];
          for (const [property, value] of textColors) {
            if (backgrounds.some((background) => contrast(value, background) < 4.5)) failures.push(`${name} ${mode} ${property}`);
          }
          const border = variables.find(([name]) => /^--by-(?:view|json|md)-border$/.test(name))?.[1];
          if (border && contrast(border, style.backgroundColor) < 3) failures.push(`${name} ${mode} border`);
        }
      }
      element.dataset.theme = "high-contrast";
      return failures;
    }, paletteNames);
    assert.deepEqual(failures, [], "New palettes must keep text and control boundaries readable in both modes");
    for (const mode of ["light", "dark"]) {
      await root.evaluate((element, mode) => {
        element.classList.toggle("dark", mode === "dark");
        element.classList.toggle("light", mode === "light");
      }, mode);
      await root.locator(".byVIEWcopy").focus();
      const measurements = await root.evaluate((element) => {
        const style = getComputedStyle(element);
        const luminance = (color) => {
          const channels = color.startsWith("#")
            ? color
                .slice(1)
                .match(/../g)
                .map((part) => parseInt(part, 16))
            : color
                .match(/[\d.]+/g)
                .slice(0, 3)
                .map(Number);
          const values = channels.map((channel) => channel / 255).map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
          return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
        };
        const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
        const variables = [...style].filter((property) => property.startsWith("--by-")).map((property) => [property, style.getPropertyValue(property).trim()]);
        const backgrounds = [style.backgroundColor, ...variables.filter(([property]) => /-(?:alt|code-bg|add|remove)$/.test(property)).map(([, value]) => value)];
        const text = variables.filter(([property, value]) => /^#[0-9a-f]{6}$/i.test(value) && !/-(?:bg|border|alt|add|remove)$/.test(property));
        const button = getComputedStyle(element.querySelector(".byVIEWcopy"));
        return {
          text: text.flatMap(([property, value]) => backgrounds.map((bg) => ({ property, ratio: contrast(value, bg) }))),
          border: contrast(button.borderTopColor, style.backgroundColor),
          focus: contrast(button.outlineColor, style.backgroundColor),
          outline: parseFloat(button.outlineWidth)
        };
      });
      assert.ok(measurements.text.length >= 5);
      for (const { property, ratio } of measurements.text) assert.ok(ratio >= 7, mode + " " + property + ": " + ratio.toFixed(2));
      assert.ok(measurements.border >= 3);
      assert.ok(measurements.focus >= 3 && measurements.outline >= 2);
    }
    await root.evaluate((element) => {
      element.classList.add("light", "dark");
      element.dataset.theme = "github";
    });
    assert.equal(await background(), "rgb(13, 17, 23)", "Dark wins when both classes exist");
    await root.evaluate((element) => {
      element.dataset.theme = "light";
    });
    assert.equal(await background(), "rgb(250, 250, 245)", "Legacy mode aliases override classes");
    await page.addStyleTag({ content: '.byCSVdocument.light[data-theme="custom-ocean"] { --by-view-bg: #f3f8fc; } .byCSVdocument.dark[data-theme="custom-ocean"] { --by-view-bg: #102a43; }' });
    await root.evaluate((element) => {
      element.dataset.theme = "custom-ocean";
      element.classList.remove("light", "dark");
    });
    await page.route("https://legacy.test/**", (route) => route.fulfill({ body: "", contentType: "text/css" }));
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          const link = document.createElement("link");
          link.id = "byVIEWtheme";
          link.rel = "stylesheet";
          link.href = "https://legacy.test/csv.dark.css?cache=1#theme";
          link.onload = resolve;
          document.head.appendChild(link);
        })
    );
    await page.evaluate(() => renderPalette("viewer"));
    assert.equal(await background(), "rgb(250, 250, 245)", "An unclassified custom palette starts in Light");
    await root.locator(".byVIEWthemeToggle").click();
    assert.equal(await background(), "rgb(16, 42, 67)");
    assert.equal(await root.getAttribute("data-theme"), "custom-ocean");
    assert.equal(await page.locator("#byVIEWtheme").getAttribute("href"), "https://legacy.test/csv.dark.css?cache=1#theme");
    assert.equal(await page.locator("#other").evaluate((element) => getComputedStyle(element).backgroundColor), "rgb(39, 40, 34)");
    assert.equal(await page.locator("#outside").evaluate((element) => getComputedStyle(element).getPropertyValue("--by-view-muted")), "");
  } finally {
    await browser.close();
  }
});

// --- CONTROLS AND CLIPBOARD FEEDBACK ---
test("viewer defaults, optional tools, and copy feedback", async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 320, height: 720 }, reducedMotion: "reduce" });
    await page.setContent('<div id="viewer"></div>');
    await page.addStyleTag({ path: path.join(__dirname, "../csv.css") });
    await page.addScriptTag({ path: path.join(__dirname, "../csv.js") });
    await page.evaluate(
      (args) => {
        window.renderUI = async (options = {}) => {
          const result = byCSVviewer(document.getElementById("viewer"), ...args, options);
          await result?.ready;
        };
      },
      ["name,value\nneedle,2\nother,1"]
    );
    await page.evaluate(() => renderUI());
    assert.equal(await page.locator(".byVIEWcontrols button").count(), 5);
    assert.equal(await page.locator(".byVIEWfontSizes").count(), 1);
    assert.equal(await page.locator(".byVIEWactions :is(input, select, button):visible").count(), 0);
    assert.equal(await page.locator(".byVIEWstatus:visible").count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    for (const controlsPosition of ["top", "bottom"]) {
      for (const toolbar of [true, false]) {
        const edges = await page.evaluate(
          async (options) => {
            await renderUI(options);
            const host = document.getElementById("viewer");
            const bounds = host.getBoundingClientRect();
            const style = getComputedStyle(host);
            const panel = host.querySelector(".byVIEWpanel").getBoundingClientRect();
            const first = host.firstElementChild,
              last = host.lastElementChild;
            const topToolbar = first.classList.contains("byVIEWtoolbar");
            const bottomToolbar = last.classList.contains("byVIEWtoolbar");
            const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
            return [
              ((topToolbar ? first.getBoundingClientRect().top : panel.top) - bounds.top - parseFloat(style.borderTopWidth)) / rem,
              (bounds.bottom - parseFloat(style.borderBottomWidth) - (bottomToolbar ? last.getBoundingClientRect().bottom : panel.bottom)) / rem
            ];
          },
          { controlsPosition, toolbar }
        );
        const expected = [toolbar && controlsPosition === "top" ? 0 : 0.75, toolbar && controlsPosition === "bottom" ? 0 : 0.75];
        assert.ok(
          edges.every((edge, index) => Math.abs(edge - expected[index]) < 0.01),
          `${controlsPosition}, toolbar=${toolbar}: ${edges}`
        );
      }
    }
    await page.evaluate(() => renderUI({ displayContainer: false, statusBar: true }));
    assert.equal(await page.locator(".byVIEWstatus:visible").count(), 0);
    assert.equal(await page.locator(".byVIEWpanel").evaluate((panel) => parseFloat(getComputedStyle(panel).borderTopWidth)), 0);
    assert.match(await page.locator(".byVIEWcontent").textContent(), /needle/);
    await page.evaluate(() => renderUI({ displayContainer: true, statusBar: false }));
    assert.equal(await page.locator(".byVIEWstatus:visible").count(), 0);
    assert.ok(await page.locator(".byVIEWpanel").evaluate((panel) => parseFloat(getComputedStyle(panel).borderTopWidth) > 0));
    await page.evaluate(() => renderUI());
    await page.evaluate(() => renderUI({ fontSizeControls: false, statusBar: false }));
    assert.equal(await page.locator(".byVIEWfontSizes").count(), 0);
    assert.equal(await page.locator(".byVIEWstatus:visible").count(), 0);
    await page.evaluate(() => renderUI());
    await page.evaluate(() => renderUI({ controlsSize: "invalid" }));
    assert.equal(await page.locator(".byVIEWtoolbar").getAttribute("data-size"), "regular");
    for (const scale of [1, 1.5]) {
      for (const controlsSize of ["xs", "small", "regular", "large", "xl"]) {
        for (const font of ["ui-monospace, monospace", "Georgia, serif"]) {
          for (const mode of ["light", "dark"]) {
            const errors = await page.evaluate(
              async ({ scale, controlsSize, font, mode }) => {
                document.documentElement.style.fontSize = `${scale}rem`;
                const host = document.getElementById("viewer");
                host.dataset.theme = mode;
                host.style.setProperty("--by-view-controls-font", font);
                await renderUI({ controlsSize });
                const button = host.querySelector(".byVIEWthemeToggle");
                const rect = button.getBoundingClientRect();
                const style = getComputedStyle(button),
                  thumb = getComputedStyle(button, "::after");
                const innerWidth = rect.width - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth);
                const innerHeight = rect.height - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth);
                const position = (value, extent) => (value.endsWith("%") ? (parseFloat(value) * extent) / 100 : parseFloat(value));
                const transform = new DOMMatrixReadOnly(thumb.transform);
                const centerX = rect.left + parseFloat(style.borderLeftWidth) + position(thumb.left, innerWidth) + transform.m41 + parseFloat(thumb.width) / 2;
                const centerY = rect.top + parseFloat(style.borderTopWidth) + position(thumb.top, innerHeight) + transform.m42 + parseFloat(thumb.height) / 2;
                const icons = [...button.querySelectorAll("svg")];
                const icon = icons[mode === "dark" ? 1 : 0].getBoundingClientRect();
                const toolbarSize = parseFloat(getComputedStyle(host.querySelector(".byVIEWtoolbar")).fontSize);
                const expectedSize = { xs: 0.5, small: 0.7, regular: 0.875, large: 1, xl: 1.25 }[controlsSize] * parseFloat(getComputedStyle(document.documentElement).fontSize);
                return [Math.abs(centerX - icon.x - icon.width / 2), Math.abs(centerY - icon.y - icon.height / 2), Math.abs(centerY - rect.y - rect.height / 2), Math.abs(toolbarSize - expectedSize)];
              },
              { scale, controlsSize, font, mode }
            );
            assert.ok(
              errors.every((error) => error < 0.06),
              `${scale} ${controlsSize} ${font} ${mode}: ${errors}`
            );
          }
        }
      }
    }
    await page.evaluate(async () => {
      document.documentElement.style.fontSize = "";
      document.getElementById("viewer").style.removeProperty("--by-view-controls-font");
      await renderUI();
    });
    for (const mode of ["light", "dark"]) {
      await page.locator("#viewer").evaluate((element, mode) => {
        element.dataset.theme = mode;
      }, mode);
      await page.evaluate(() => renderUI({ toolbar: false, controlsPosition: "bottom", sorting: false, pagination: false, collapsible: false, details: false, lineNumbers: false, loadMore: false }));
      assert.equal(await page.locator("#viewer :is(button, input, select, summary):visible").count(), 0);
      assert.equal(await page.locator(".byVIEWtoolbar").count(), 0);
      assert.equal(await page.locator("#viewer").evaluate((element) => element.classList.contains("byVIEWbottom")), false);
      assert.match(await page.locator("#viewer").textContent(), /needle/);
    }
    await page.evaluate(() => renderUI({ pageSize: 1 }));
    assert.equal(await page.locator("tbody tr").count(), 1);
    assert.equal(await page.getByRole("button", { name: "Next page", exact: true }).isVisible(), true);
    await page.evaluate(() => renderUI({ pageSize: 1, pagination: false }));
    assert.equal(await page.locator("tbody tr").count(), 2);
    assert.equal(await page.getByRole("button", { name: "Next page", exact: true }).isVisible(), false);
    await page.evaluate(() => renderUI({ credits: false }));
    assert.equal(await page.locator(".byVIEWinfo").count(), 0);
    assert.equal(await page.locator(".byVIEWcontrols button").count(), 5);
    await page.evaluate(() => renderUI({ credits: false, themeToggle: false, fontSizeControls: false, copyButton: false }));
    assert.equal(await page.locator(".byVIEWtoolbar").count(), 0);
    await page.evaluate((options) => renderUI({ fontSizeControls: true, ...options }), { search: true, columnFilters: true, copyCells: true, columnsButton: true, statusBar: true });
    assert.equal(await page.locator(".byVIEWfontSize").count(), 3);
    assert.equal(await page.locator(".byVIEWpanel > .byVIEWstatus:visible").count(), 1);
    assert.ok(await page.locator(".byVIEWpanel > .byVIEWstatus").evaluate((status) => parseFloat(getComputedStyle(status).borderBottomWidth) > 0));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async () => {
            throw new Error("Denied");
          }
        }
      });
    });
    await page.locator(".byVIEWcopy").click();
    await page.mouse.move(0, 0);
    await page.locator(".byVIEWcopy").evaluate((element) => element.blur());
    assert.equal(await page.locator(".byVIEWcopy").getAttribute("data-state"), "error");
    assert.equal(await page.locator(".byVIEWcopy").textContent(), "Failed");
    await page.evaluate(() => {
      navigator.clipboard.writeText = async (value) => {
        window.copiedSource = value;
      };
    });
    await page.locator(".byVIEWcopy").click();
    assert.equal(await page.locator(".byVIEWcopy").getAttribute("data-state"), "success");
    assert.match(await page.evaluate(() => copiedSource), /needle/);
  } finally {
    await browser.close();
  }
});

// --- DOCUMENT AND CONTENT SURFACES ---
test("document and content backgrounds stay independent through theme and toolbar changes", async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.route("https://cdn.jsdelivr.net/**", (route) => route.abort());
    await page.setContent('<div id="viewer" data-theme="light"></div><div id="neighbor" data-theme="light"></div>');
    await page.addStyleTag({ path: path.join(__dirname, "../csv.css") });
    await page.addScriptTag({ path: path.join(__dirname, "../csv.js") });
    await page.evaluate(async () => {
      for (const id of ["viewer", "neighbor"]) {
        const result = byCSVviewer(document.getElementById(id), "Name,Role\nAndres,Developer");
        await result?.ready;
      }
    });
    const root = page.locator("#viewer");
    const neighbor = await page.locator("#neighbor").evaluate((element) => getComputedStyle(element).backgroundColor);
    await root.evaluate((element) => {
      element.style.setProperty("--by-view-document-bg", "transparent");
      element.style.setProperty("--by-view-container-bg", "#123456");
    });
    await page.waitForFunction(() => getComputedStyle(document.querySelector("#viewer .byVIEWcopy")).backgroundColor === "rgb(18, 52, 86)");
    for (const changeMode of [false, true]) {
      if (changeMode) await root.locator(".byVIEWthemeToggle").click();
      assert.match(await root.evaluate((element) => getComputedStyle(element).backgroundColor), /^rgba\([^)]*, 0\)$/);
      assert.equal(await root.locator(".byVIEWpanel").evaluate((element) => getComputedStyle(element).backgroundColor), "rgb(18, 52, 86)");
      assert.equal(
        await root
          .locator(".byVIEWcopy")
          .first()
          .evaluate((element) => getComputedStyle(element).backgroundColor),
        "rgb(18, 52, 86)"
      );
      assert.equal(await root.locator(".byVIEWtoolbar").evaluate((element) => getComputedStyle(element).backgroundColor), "rgba(0, 0, 0, 0)");
    }
    assert.equal(await page.locator("#neighbor").evaluate((element) => getComputedStyle(element).backgroundColor), neighbor);
    await root.evaluate((element) => element.style.removeProperty("--by-view-container-bg"));
    await page.waitForFunction(() => getComputedStyle(document.querySelector("#viewer .byVIEWcopy")).backgroundColor === "rgb(39, 40, 34)");
    assert.notEqual(
      await root
        .locator(".byVIEWcopy")
        .first()
        .evaluate((element) => getComputedStyle(element).backgroundColor),
      "rgba(0, 0, 0, 0)"
    );
  } finally {
    await browser.close();
  }
});

// --- INTERACTION MOTION ---
test("animation options preserve initial visibility and override system motion preferences", async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ reducedMotion: "reduce" });
    await page.route("https://cdn.jsdelivr.net/**", (route) => (route.request().url().endsWith("fontawesome.min.css") ? route.fulfill({ body: "", contentType: "text/css" }) : route.abort()));
    await page.setContent('<div id="motion-viewer" data-theme="light"></div>');
    await page.addStyleTag({ path: path.join(__dirname, "../csv.css") });
    await page.addScriptTag({ path: path.join(__dirname, "../csv.js") });
    await page.evaluate(() => {
      window.renderMotion = async (animations, appearAnimation = false) => {
        window.motionController = byCSVviewer(document.getElementById("motion-viewer"), "Name,Role\nAndres,Developer", { animations, appearAnimation });
        await motionController?.ready;
      };
    });
    await page.evaluate(() => renderMotion());
    const root = page.locator("#motion-viewer");
    assert.equal(await root.evaluate((element) => element.classList.contains("byVIEWmotion")), true);
    assert.equal(await root.evaluate((element) => getComputedStyle(element).opacity), "1");
    assert.equal(await root.evaluate((element) => element.getAnimations({ subtree: true }).length), 0, "Initial content does not animate");
    assert.equal(
      await root
        .locator("button")
        .first()
        .evaluate((element) => getComputedStyle(element).transitionDuration.split(",")[0]),
      "0.18s"
    );
    // Disclosure size/exit motion progressively enhances engines supporting intrinsic-size transitions.
    if (await page.evaluate(() => CSS.supports("interpolate-size", "allow-keywords"))) {
      const disclosure = await root.evaluateHandle((element) => {
        const details = document.createElement("details");
        details.id = "motion-disclosure";
        details.innerHTML = "<summary>Details</summary><p>Already available content</p>";
        element.append(details);
        getComputedStyle(details, "::details-content").blockSize;
        return details;
      });
      await disclosure.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.waitForFunction(() => getComputedStyle(document.getElementById("motion-disclosure"), "::details-content").opacity === "0");
      const opening = await disclosure.evaluate(async (details) => {
        details.open = true;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return Number(getComputedStyle(details, "::details-content").opacity);
      });
      assert.ok(opening > 0 && opening < 1, "A deliberate disclosure eases in even with reduced motion requested");
      await page.waitForFunction(() => getComputedStyle(document.getElementById("motion-disclosure"), "::details-content").opacity === "1");
      await disclosure.evaluate((details) => {
        details.open = false;
      });
      await page.waitForFunction(() => getComputedStyle(document.getElementById("motion-disclosure"), "::details-content").opacity === "0");
      assert.equal(await disclosure.evaluate((details) => details.open), false);
    } else {
      await root.evaluate((element) => {
        const details = document.createElement("details");
        details.id = "fallback-disclosure";
        details.innerHTML = "<summary>Details</summary><p>Available content</p>";
        element.append(details);
      });
      await page.locator("#fallback-disclosure summary").click();
      await page.locator("#fallback-disclosure p").waitFor({ state: "visible" });
      await page.locator("#fallback-disclosure summary").click();
      await page.locator("#fallback-disclosure p").waitFor({ state: "hidden" });
    }
    await page.evaluate(() => renderMotion(false));
    await page.emulateMedia({ reducedMotion: "no-preference" });
    assert.equal(await root.evaluate((element) => element.classList.contains("byVIEWmotion")), false);
    assert.equal(
      await root
        .locator("button")
        .first()
        .evaluate((element) => getComputedStyle(element).transitionDuration),
      "0s"
    );
    assert.equal(await root.evaluate((element) => element.getAnimations({ subtree: true }).length), 0);
    await page.emulateMedia({ media: "screen", reducedMotion: "reduce" });
    await page.evaluate(() => renderMotion(true));
    await page.waitForFunction(() => document.getElementById("motion-viewer").classList.contains("byVIEWready"));
    const fade = await root.evaluate((element) => {
      const before = getComputedStyle(element).backgroundColor;
      element.querySelector('[aria-label^="Switch to"]').click();
      const transition = element.getAnimations().find((animation) => animation.transitionProperty === "background-color");
      if (!transition) return { active: false };
      transition.pause();
      transition.currentTime = 90;
      const middle = getComputedStyle(element).backgroundColor;
      transition.finish();
      return { active: true, before, middle, after: getComputedStyle(element).backgroundColor, fontTransition: getComputedStyle(element).transitionProperty.includes("font-size") };
    });
    assert.equal(fade.active, true, "Theme backgrounds fade after the first paint");
    assert.notEqual(fade.middle, fade.before);
    assert.notEqual(fade.middle, fade.after);
    assert.equal(fade.fontTransition, false);
    await root.evaluate((element) => {
      element.dataset.theme = "high-contrast";
    });
    assert.equal(await root.evaluate((element) => element.getAnimations().filter((animation) => animation.transitionProperty === "background-color").length), 0);
    const entrance = await page.evaluate(async () => {
      await renderMotion(true, true);
      const element = document.getElementById("motion-viewer");
      const animation = element.getAnimations().find((animation) => animation.animationName === "byVIEWappear");
      if (!animation) return { active: false };
      animation.pause();
      animation.currentTime = 90;
      return { active: true, opacity: Number(getComputedStyle(element).opacity), content: element.textContent.length };
    });
    assert.equal(entrance.active, true, "Entrance motion is explicit even when the system requests reduced motion");
    assert.ok(entrance.opacity > 0 && entrance.opacity < 1);
    assert.ok(entrance.content > 0, "Rendering completes without waiting for the animation");
    await page.evaluate(() => renderMotion(false, true));
    assert.equal(await root.evaluate((element) => element.getAnimations({ subtree: true }).length), 0, "Animations off overrides the requested entrance");
  } finally {
    await browser.close();
  }
});

// --- INITIAL APPEARANCE ---
test("appearance options override markup and preserve independent viewer state", async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.route("https://cdn.jsdelivr.net/**", (route) => route.fulfill({ body: "", contentType: "text/css" }));
    await page.setContent('<style>html{font-size:20px}</style><div id="appearance" class="host light" data-theme="light"></div><div id="neighbor" class="dark" data-theme="monokai" style="font-size:2rem">Neighbor</div>');

    await page.addStyleTag({ path: path.join(__dirname, "../csv.css") });
    await page.addScriptTag({ path: path.join(__dirname, "../csv.js") });
    await page.evaluate(() => {
      window.appearanceTarget = document.getElementById("appearance");
      window.renderAppearance = async (options = {}) => {
        window.appearanceInstance = byCSVviewer(appearanceTarget, "Name,Value\nItem,42", options);
        await appearanceInstance?.ready;
      };
    });
    const neighbor = await page.locator("#neighbor").evaluate((element) => element.outerHTML);
    await page.evaluate(() => renderAppearance({ theme: "dark", palette: "github", fontSize: 1.5, animations: false }));
    assert.deepEqual(
      await page
        .locator("#appearance")
        .evaluate((element) => [element.classList.contains("host"), element.classList.contains("dark"), element.classList.contains("light"), element.dataset.theme, element.style.fontSize, getComputedStyle(element).fontSize]),
      [true, true, false, "github", "1.5rem", "30px"]
    );
    const controls = page.locator("#appearance .byVIEWthemeToggle");
    assert.equal(await controls.getAttribute("aria-label"), "Switch to light theme");
    await controls.click();
    assert.deepEqual(await page.locator("#appearance").evaluate((element) => [element.classList.contains("light"), element.dataset.theme, element.style.fontSize]), [true, "github", "1.5rem"]);
    const buttonSize = await controls.evaluate((element) => getComputedStyle(element).fontSize);
    await page.getByRole("button", { name: "Increase text size", exact: true }).click();
    await page.evaluate(() => renderAppearance());
    assert.equal(await page.locator("#appearance").evaluate((element) => element.style.fontSize), "1.625rem");
    await page.getByRole("button", { name: "Reset text size", exact: true }).click();
    assert.equal(await page.locator("#appearance").evaluate((element) => element.style.fontSize), "1.5rem");
    assert.equal(await controls.evaluate((element) => getComputedStyle(element).fontSize), buttonSize);
    await page.evaluate(() => renderAppearance({ fontSize: 1.25 }));
    assert.equal(await page.locator("#appearance").evaluate((element) => getComputedStyle(element).fontSize), "25px");
    await page.getByRole("button", { name: "Increase text size", exact: true }).click();
    await page.getByRole("button", { name: "Reset text size", exact: true }).click();
    assert.equal(await page.locator("#appearance").evaluate((element) => element.style.fontSize), "1.25rem");
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "24px";
    });
    assert.equal(await page.locator("#appearance").evaluate((element) => getComputedStyle(element).fontSize), "30px", "The multiplier follows root text-size changes");
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "20px";
    });
    for (const [fontSize, expected] of [
      ["1.25rem", 25],
      ["1.25em", 25],
      ["20px", 20],
      ["125%", 25],
      ["1px", 10],
      ["100px", 60],
      ["4em", 60]
    ]) {
      await page.evaluate((fontSize) => renderAppearance({ fontSize }), fontSize);
      assert.equal(await page.locator("#appearance").evaluate((element) => parseFloat(getComputedStyle(element).fontSize)), expected, fontSize);
      const preset = await page.locator("#appearance").evaluate((element) => [element.style.fontSize, element.dataset.byViewDefaultFontSize]);
      assert.equal(preset[0], preset[1]);
      await page.getByRole("button", { name: expected === 60 ? "Decrease text size" : "Increase text size", exact: true }).click();
      await page.getByRole("button", { name: "Reset text size", exact: true }).click();
      assert.equal(await page.locator("#appearance").evaluate((element) => element.style.fontSize), preset[0]);
    }
    await page.evaluate(() => {
      document.body.style.fontSize = "1.5rem";
      return renderAppearance({ fontSize: "1em" });
    });
    assert.equal(await page.locator("#appearance").evaluate((element) => getComputedStyle(element).fontSize), "30px", "em remains relative to the parent");
    await page.evaluate(() => {
      document.body.style.fontSize = "";
      document.documentElement.style.fontSize = "24px";
      return renderAppearance({ fontSize: "100px" });
    });
    assert.equal(await page.locator("#appearance").evaluate((element) => getComputedStyle(element).fontSize), "72px", "CSS values retain the rem limit when the root size changes");
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "20px";
    });
    for (const [requested, expected] of [
      [-1, 0.5],
      [0, 0.5],
      [0.25, 0.5],
      [0.5, 0.5],
      [3, 3],
      [4, 3]
    ]) {
      await page.evaluate((fontSize) => renderAppearance({ fontSize }), requested);
      assert.equal(await page.locator("#appearance").evaluate((element) => element.style.fontSize), `${expected}rem`);
      assert.equal(await page.locator("#appearance").evaluate((element) => element.dataset.byViewDefaultFontSize), `${expected}rem`);
      assert.equal(await page.getByRole("button", { name: "Decrease text size", exact: true }).isDisabled(), expected === 0.5);
      assert.equal(await page.getByRole("button", { name: "Increase text size", exact: true }).isDisabled(), expected === 3);
      await page.getByRole("button", { name: expected === 3 ? "Decrease text size" : "Increase text size", exact: true }).click();
      await page.getByRole("button", { name: "Reset text size", exact: true }).click();
      assert.equal(await page.locator("#appearance").evaluate((element) => element.style.fontSize), `${expected}rem`);
    }
    await page.evaluate(() => {
      appearanceTarget.dataset.theme = "dark";
      appearanceTarget.classList.remove("dark");
      appearanceTarget.classList.add("light");
      return renderAppearance({ palette: "high-contrast", toolbar: false });
    });
    assert.deepEqual(await page.locator("#appearance").evaluate((element) => [element.dataset.theme, element.classList.contains("dark"), getComputedStyle(element).colorScheme]), ["high-contrast", true, "dark"]);
    await page.evaluate(() => {
      appearanceTarget.dataset.theme = "dark";
      return renderAppearance({ theme: "light", toolbar: false });
    });
    assert.deepEqual(await page.locator("#appearance").evaluate((element) => [element.dataset.theme, element.classList.contains("dark"), element.classList.contains("light")]), ["light", false, true]);
    await page.evaluate(() => renderAppearance({ theme: "dark", palette: "custom-ocean", fontSize: 1.125, toolbar: false }));
    assert.deepEqual(await page.locator("#appearance").evaluate((element) => [element.dataset.theme, element.classList.contains("dark"), element.style.fontSize]), ["custom-ocean", true, "1.125rem"]);
    const preserved = await page.locator("#appearance").evaluate((element) => [element.className, element.dataset.theme, element.style.fontSize]);
    await page.evaluate(() => renderAppearance());
    assert.deepEqual(await page.locator("#appearance").evaluate((element) => [element.className, element.dataset.theme, element.style.fontSize]), preserved);
    await page.evaluate(() => renderAppearance({ theme: null, palette: null, fontSize: null }));
    assert.deepEqual(await page.locator("#appearance").evaluate((element) => [element.className, element.dataset.theme, element.style.fontSize]), preserved, "Blank exported appearance fields retain the container settings");
    // Invalid options must leave the current document intact rather than partially reinitializing it.
    for (const options of [
      { theme: "sepia" },
      { palette: "dark" },
      { palette: "bad name" },
      { fontSize: NaN },
      { fontSize: Infinity },
      { fontSize: "wrong" },
      { fontSize: "inherit" },
      { fontSize: true },
      { theme: "light", palette: "github", fontSize: "1.25" }
    ]) {
      const before = await page.locator("#appearance").evaluate((element) => element.outerHTML);
      const name = await page.evaluate(async (options) => {
        try {
          await renderAppearance(options);
        } catch (error) {
          return error.name;
        }
      }, options);
      assert.equal(name, "RangeError");
      assert.equal(await page.locator("#appearance").evaluate((element) => element.outerHTML), before, "Invalid appearance must not replace the current document");
    }

    assert.equal(await page.locator("#neighbor").evaluate((element) => element.outerHTML), neighbor);
  } finally {
    await browser.close();
  }
});
