const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const { chromium } = require("playwright");

// Caller-provided legacy stylesheets reuse the canonical palettes without distribution files.
const legacyThemeCSS = (theme) => {
  const css = require("node:fs").readFileSync(path.join(__dirname, "../csv.css"), "utf8");
  const section = css.split(`/* --- ${theme.toUpperCase()} --- */`)[1];
  return `.byCSVdocument {${section.match(/\{([\s\S]*?)\}/)[1]}}`;
};

let bootstrapCSS;
const getBootstrapCSS = () =>
  (bootstrapCSS ??= (async () => {
    if (process.env.BOOTSTRAP_CSS_PATH) return require("node:fs/promises").readFile(process.env.BOOTSTRAP_CSS_PATH, "utf8");
    const response = await fetch("https://cdn.jsdelivr.net/gh/byuwur/spa.js@v20.6/css/bootstrap.min.css");
    assert.ok(response.ok, "Unable to load pinned Bootstrap CSS");
    return response.text();
  })());

test("CSV parsing and standalone browser behavior", async (t) => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("http://viewer.test/**", (route) => {
      const filename = new URL(route.request().url()).pathname.slice(1);
      if (/^csv\.(light|dark)\.css$/.test(filename)) return route.fulfill({ body: legacyThemeCSS(filename.includes(".dark.css") ? "dark" : "light"), contentType: "text/css" });
      if (!filename || filename === "index.html")
        return route.fulfill({
          contentType: "text/html",
          body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="csv.css"><script src="csv.js"></script><div id="viewer" data-theme="light"></div>'
        });
      return route.fulfill({ path: path.join(__dirname, "..", filename), contentType: filename.endsWith(".css") ? "text/css" : "text/javascript" });
    });
    await page.goto("http://viewer.test/index.html");
    await page.evaluate(
      async ({ source, second, options }) => {
        await byCSVviewer(document.getElementById("viewer"), source, options).ready;
      },
      {
        source:
          'Name,Role,Location,Notes\nAndres,Developer,Bogota,"Build small, useful things."\nSam,Designer,London,"Quotes: ""hello"""\nLee,Engineer,Tokyo,"A note that spans\ntwo lines."\nAlex,Maintainer,Oslo,Ready',
        options: { fontSizeControls: true,  delimiter: ",", headers: true, skipEmptyLines: true, pageSize: 50, search: true, columnFilters: true, copyCells: true }
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
      await page.getByRole("button", { name: "Sort by n", exact: true }).click();
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
            window.sortInput = Object.freeze([
              { name: "Zed", score: 10, group: "keep" },
              { name: "Cara", score: 1, group: "keep" },
              { name: "amy", score: 2, group: "keep" },
              { name: "Bob", score: 2, group: "skip" },
              { name: "AMY", score: 2, group: "keep" }
            ].map((record) => Object.freeze(record)));
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
      const measure = () => page.locator(".byCSVtable").evaluate((table) => [...table.querySelectorAll("th, td")].map((cell) => {
        const rect = cell.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, padding: getComputedStyle(cell).padding };
      }));
      try {
        for (const width of [320, 640]) {
          await page.setViewportSize({ width: width + 16, height: 800 });
          for (const theme of ["light", "dark"]) {
            for (const columnFilters of [false, true]) {
              await page.evaluate(async ({ width, theme, source, columnFilters }) => {
                root.style.width = `${width}px`;
                root.style.fontFamily = "Georgia, serif";
                root.dataset.theme = theme;
                await byCSVviewer(root, source, { columnFilters, copyCells: false }).ready;
              }, { width, theme, source, columnFilters });
              const plain = await measure();
              assert.equal(await page.locator(".byCSVscroll").evaluate((scroll) => scroll.scrollWidth > scroll.clientWidth), true);
              assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
              assert.equal(await page.getByRole("button", { name: "Sort by Location", exact: true }).evaluate((button) => {
                const range = document.createRange();
                range.selectNode(button.firstChild);
                return range.getClientRects().length;
              }), 1);
              if (columnFilters) assert.ok(await page.getByRole("searchbox", { name: "Filter Name", exact: true }).evaluate((input) => input.getBoundingClientRect().height < 30));
              await page.evaluate(async ({ source, columnFilters }) => {
                await byCSVviewer(root, source, { columnFilters, copyCells: true }).ready;
              }, { source, columnFilters });
              assert.deepEqual(await measure(), plain, `${width}px ${theme}: copying must not resize cells`);
              assert.equal(await page.locator("tbody td .byCSVcell").first().evaluate((button) => getComputedStyle(button).fontFamily === getComputedStyle(button.parentElement).fontFamily), true);
              const copy = page.locator("tbody td .byCSVcell").first();
              await copy.click();
              assert.equal(await page.evaluate(() => copies.at(-1)), "Andres");
              assert.equal(await copy.textContent(), "Andres");
              assert.equal(await copy.getAttribute("data-state"), "success");
              assert.deepEqual(await measure(), plain, "Copy confirmation must not move the table");
              await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error("Denied"); }; });
              await copy.click();
              assert.equal(await copy.textContent(), "Andres");
              assert.equal(await copy.getAttribute("data-state"), "error");
              assert.deepEqual(await measure(), plain, "Copy errors must not move the table");
              await page.evaluate(() => { navigator.clipboard.writeText = async (value) => copies.push(value); });
              const blank = page.locator("tbody tr").nth(2).locator(".byCSVcell").first();
              await blank.click();
              assert.equal(await page.evaluate(() => copies.at(-1)), "");
              assert.equal(await blank.textContent(), "");
              await page.locator(".byCSVscroll").evaluate((scroll) => { scroll.scrollLeft = 0; });
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

test("suite playground, exports, and stylesheet controls", async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text) => {
            window.copiedHTML = text;
          }
        }
      });
    });
    await page.route("**/*", async (route) => {
      if (route.request().url() === "https://cdn.jsdelivr.net/gh/byuwur/spa.js@v20.6/css/bootstrap.min.css") return route.fulfill({ body: await getBootstrapCSS(), contentType: "text/css" });
      const url = new URL(route.request().url());
      if (url.origin !== "https://viewer.test") return route.abort();
      const file = path.basename(url.pathname);
      if (/^csv\.(light|dark)\.css$/.test(file)) return route.fulfill({ body: legacyThemeCSS(file.includes(".dark.css") ? "dark" : "light"), contentType: "text/css" });
      return route.fulfill({ path: path.join(__dirname, "..", file), contentType: file.endsWith(".html") ? "text/html" : file.endsWith(".js") ? "text/javascript" : "text/css" });
    });
    await page.goto("https://viewer.test/index.html");
    await page.waitForFunction(() => document.getElementById("render-status").textContent.startsWith("Rendered"));
    const preview = page.frames().find((frame) => frame.parentFrame());
    const source = await page.locator("#source").inputValue();
    const expectedCopy = source;
    const release = await page.frameLocator("#preview-frame").locator(".byVIEWtoolbar").evaluate(() => byCSVviewer.VERSION);
    assert.ok((await page.frameLocator("#preview-frame").locator(".byVIEWinfo").textContent()).includes(` v${release} `), "Credits must match the runtime release");
    const cdnBase = "https://cdn.jsdelivr.net/gh/byuwur/easy-csv-viewer@latest/";
    const readme = require("node:fs").readFileSync(path.join(__dirname, "../README.md"), "utf8");
    for (const extension of ["css", "js"]) assert.ok(readme.includes(`${cdnBase}csv.${extension}`), "README assets must match the CDN starter");
    assert.equal(await page.locator("#install-note").textContent(), "CDN follows the latest release; updates may take time to reach caches.");
    assert.ok((await page.locator("#integration-code").inputValue()).includes(`href="${cdnBase}csv.css"`));
    assert.equal(await page.locator('[data-install="cdn"]').getAttribute("aria-pressed"), "true");
    await page.locator('[data-install="local"]').click();
    const starter = await page.locator("#integration-code").inputValue();
    await page.evaluate(() => {
      window.successfulClipboardWrite = navigator.clipboard.writeText;
      navigator.clipboard.writeText = async () => { throw new Error("Denied"); };
    });
    await page.locator("#copy-html").click();
    await page.waitForFunction(() => document.querySelector("#copy-html span").textContent === "Failed");
    assert.equal(await page.locator("#integration-code").evaluate((element) => document.activeElement === element && element.selectionEnd === element.value.length), true);
    assert.match(await page.locator("#copy-html").getAttribute("title"), /Ctrl\+C/);
    await page.evaluate(() => { navigator.clipboard.writeText = window.successfulClipboardWrite; });

    assert.ok(starter.includes('href="csv.css"'));
    assert.ok(starter.includes('data-theme="light"'));
    assert.ok(!starter.includes("byVIEWtheme"));
    assert.doesNotMatch(starter, /\.(light|dark)\.css/);
    assert.ok(starter.includes('src="csv.js"'));
    await page.locator('[name="controlsCompact"]').check();
    await page.locator('label[for="controlsPosition-bottom"]').click();
    await page.locator('label[for="controlsSize-small"]').click();
    await preview.waitForFunction(() => document.getElementById("viewer").classList.contains("byVIEWbottom") && document.querySelector(".byVIEWtoolbar").dataset.size === "small");
    assert.equal(await preview.locator("#viewer").evaluate((element) => element.lastElementChild.classList.contains("byVIEWtoolbar")), true);
    await page.locator('label[for="preview-dark"]').click();
    await preview.waitForFunction(() => getComputedStyle(document.getElementById("viewer")).backgroundColor === "rgb(39, 40, 34)");
    await preview.locator(".byVIEWthemeToggle").click();
    await page.waitForFunction(() => document.getElementById("preview-light").checked);
    await page.locator("#source").fill("");
    await page.locator("#render").click();
    await page.waitForFunction(() => !document.getElementById("render-status").textContent.includes("Rendering"));
    assert.equal(await page.locator("#integration-code").inputValue(), starter);
    await page.locator("#copy-html").click();
    assert.equal(await page.evaluate(() => copiedHTML), starter);
    const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#download-html").click()]);
    assert.equal(await require("node:fs/promises").readFile(await download.path(), "utf8"), starter);
    const exported = await browser.newPage();
    await exported.route("https://viewer.test/**", (route) => {
      const file = path.basename(new URL(route.request().url()).pathname);
      if (/^csv\.(light|dark)\.css$/.test(file)) return route.fulfill({ body: legacyThemeCSS(file.includes(".dark.css") ? "dark" : "light"), contentType: "text/css" });
      if (file === "starter.html") return route.fulfill({ body: starter, contentType: "text/html" });
      return route.fulfill({ path: path.join(__dirname, "..", file), contentType: file.endsWith(".js") ? "text/javascript" : "text/css" });
    });
    await exported.goto("https://viewer.test/starter.html");
    await exported.waitForFunction(() => document.querySelector(".byVIEWtoolbar") && document.getElementById("viewer").getAttribute("aria-busy") !== "true");
    assert.equal(await exported.locator("[role=alert]:visible").count(), 0);
    await exported.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text) => {
            window.copiedSource = text;
          }
        }
      });
    });
    await exported.locator(".byVIEWcopy").click();
    assert.equal(await exported.evaluate(() => copiedSource), expectedCopy);
    await page.locator('[data-install="cdn"]').click();
    const cdnStarter = await page.locator("#integration-code").inputValue();
    assert.equal(cdnStarter.replaceAll(cdnBase, ""), starter, "Only asset paths change between modes");
    assert.ok(cdnStarter.includes('href="' + cdnBase + 'csv.css"'));
    assert.ok(cdnStarter.includes('src="' + cdnBase + 'csv.js"'));
    assert.equal(await page.locator('[data-install="cdn"]').getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator('[data-install="local"]').getAttribute("aria-pressed"), "false");
    await page.locator("#copy-html").click();
    assert.equal(await page.evaluate(() => copiedHTML), cdnStarter);
    const [cdnDownload] = await Promise.all([page.waitForEvent("download"), page.locator("#download-html").click()]);
    assert.equal(await require("node:fs/promises").readFile(await cdnDownload.path(), "utf8"), cdnStarter);
    const cdnPage = await browser.newPage();
    const cdnRequests = [];
    cdnPage.on("pageerror", (error) => errors.push(error.message));
    // Serve future CDN URLs from the maintained files without depending on publication.
    await cdnPage.route("**/*", (route) => {
      const url = route.request().url();
      if (url === "https://viewer.test/cdn-starter.html") return route.fulfill({ body: cdnStarter, contentType: "text/html" });
      if ([cdnBase + "csv.css", cdnBase + "csv.js"].includes(url)) {
        cdnRequests.push(url);
        return route.fulfill({ path: path.join(__dirname, "..", path.basename(new URL(url).pathname)), contentType: url.endsWith(".js") ? "text/javascript" : "text/css" });
      }
      return route.abort();
    });
    await cdnPage.goto("https://viewer.test/cdn-starter.html");
    await cdnPage.waitForFunction(() => document.querySelector(".byVIEWtoolbar") && document.getElementById("viewer").getAttribute("aria-busy") !== "true");
    assert.equal(await cdnPage.locator("[role=alert]:visible").count(), 0);
    assert.deepEqual(cdnRequests.sort(), [cdnBase + "csv.css", cdnBase + "csv.js"]);
    await cdnPage.close();
    await page.locator('[data-install="local"]').click();
    assert.equal(await page.locator("#integration-code").inputValue(), starter);
    assert.equal(await page.locator('[data-install="local"]').getAttribute("aria-pressed"), "true");
    // Caller-provided legacy stylesheets still synchronize unassigned viewers.
    await exported.evaluate(async () => {
      document.getElementById("viewer").removeAttribute("data-theme");
      const link = document.createElement("link");
      link.rel = "stylesheet";
      document.head.appendChild(link);
      link.setAttribute("href", "csv.light.css?cache=1#theme");
      const other = document.createElement("div");
      other.id = "other";
      document.body.appendChild(other);
      await byCSVviewer(other, "", { fontSizeControls: true }).ready;
    });
    await exported.locator("#other .byVIEWthemeToggle").click();
    assert.equal(await exported.locator('link[href*="dark.css"]').getAttribute("href"), "csv.dark.css?cache=1#theme");
    assert.equal(await exported.locator('[aria-label="Switch to light theme"]').count(), 2);
    await exported.evaluate(async () => {
      document.querySelector('link[href*=".dark.css"]').remove();
      await byCSVviewer(document.getElementById("other"), "", { fontSizeControls: true }).ready;
    });
    assert.equal(await exported.locator("#other .byVIEWthemeToggle").count(), 1);
    await exported.locator('#other [aria-label="Increase text size"]').evaluate((button) => {
      for (let i = 0; i < 30; i++) button.click();
    });
    assert.equal(await exported.locator('#other [aria-label="Increase text size"]').isDisabled(), true);
    assert.equal(await exported.locator("#other").evaluate((element) => element.style.fontSize), "3rem");
    await exported.close();
    await page.locator("#local-file").setInputFiles({ name: "sample.txt", mimeType: "text/plain", buffer: Buffer.from(source) });
    await page.waitForFunction((expected) => document.getElementById("source").value === expected, source);
    await page.locator("#reset").click();
    assert.equal(await page.locator('[name="controlsCompact"]').isChecked(), true);
    assert.equal(await page.locator('[name="controlsPosition"]:checked').inputValue(), "top");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test("family customization, navigation and monospace controls", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined, channel: process.env.BROWSER_CHANNEL || undefined });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() =>
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text) => {
            window.lastCopy = text;
          }
        }
      })
    );
    await page.route("**/*", async (route) => {
      if (route.request().url() === "https://cdn.jsdelivr.net/gh/byuwur/spa.js@v20.6/css/bootstrap.min.css") return route.fulfill({ body: await getBootstrapCSS(), contentType: "text/css" });
      const url = new URL(route.request().url());
      if (url.origin !== "https://viewer.test") return route.abort();
      const file = path.basename(url.pathname);
      if (/^csv\.(light|dark)\.css$/.test(file)) return route.fulfill({ body: legacyThemeCSS(file.includes(".dark.css") ? "dark" : "light"), contentType: "text/css" });
      return route.fulfill({ path: path.join(__dirname, "..", file), contentType: file.endsWith(".html") ? "text/html" : file.endsWith(".js") ? "text/javascript" : "text/css" });
    });
    await page.goto("https://viewer.test/index.html");
    const frame = page.frames().find((candidate) => candidate.parentFrame());
    await frame.waitForSelector(".byVIEWtoolbar");
    assert.equal(await page.locator("#controlsCompact").isChecked(), true);
    assert.equal(JSON.parse(await page.locator("#options-json").inputValue()).controlsCompact, true);
    assert.equal(await frame.locator(".byCSVdocument").evaluate((root) => root.classList.contains("byVIEWcompact")), true);
    assert.deepEqual(await frame.evaluate(async (source) => {
      const host = document.createElement("div");
      document.body.append(host);
      const states = [];
      let controller;
      try {
        for (const options of [undefined, { controlsCompact: false }, { controlsCompact: true }, undefined]) {
          controller = byCSVviewer(host, source, options);
          await controller?.ready;
          states.push(host.classList.contains("byVIEWcompact"));
        }
        controller = byCSVviewer(host, source, { themeToggle: false, fontSizeControls: false, copyButton: false });
        await controller?.ready;
        states.push(host.querySelectorAll(".byVIEWinfo").length === 1 && !host.querySelector(".byVIEWcontrols"));
        return states;
      } finally {
        controller?.destroy?.();
        host.remove();
      }
    }, "name\nSample"), [true, false, true, true, true], "Compact defaults, opt-out, rerenders, and disabled controls agree");
    assert.deepEqual(await page.locator(".form-switch .form-check-input").first().evaluate((element) => {
      const style = getComputedStyle(element);
      return { width: style.width, height: style.height };
    }), { width: "44px", height: "24px" });
    assert.equal(await page.locator(".form-switch .form-check-input").evaluateAll((inputs) => inputs.every((input) => {
      const toggle = input.getBoundingClientRect();
      const row = input.closest(".form-switch").getBoundingClientRect();
      return Math.abs(toggle.right - row.right) < 1 && Math.abs(toggle.top + toggle.height / 2 - row.top - row.height / 2) < 1;
    })), true, "Every switch lines up at the right edge and center of its row");
    for (const width of [768, 1280]) {
      await page.setViewportSize({ width, height: 720 });
      assert.equal(await page.locator("#controlsSize").evaluate((size) => {
        const a = size.querySelector(".btn-group").getBoundingClientRect();
        const b = document.querySelector("#controlsPosition .btn-group").getBoundingClientRect();
        return Math.abs(a.top - b.top) < 1 && Math.abs(a.width - b.width) < 1 && a.right < b.left;
      }), true, "Size and position controls share one evenly divided row");
    }
    assert.deepEqual(await page.locator(".accordion-button").allTextContents().then((labels) => labels.map((label) => label.trim()).slice(0, 3)), ["Preview appearance", "Viewer controls", "Rendering"]);
    assert.deepEqual(await page.locator("#options-json").evaluate((editor) => Object.keys(JSON.parse(editor.value)).slice(0, 17)), [
      "theme", "palette", "fontFamily", "fontSize", "lineHeight", "controlsFont", "backgroundColor", "textColor", "customThemeCSS",
      "toolbar", "credits", "themeToggle", "fontSizeControls", "copyButton", "controlsCompact", "controlsSize", "controlsPosition"
    ]);
    assert.equal(await page.locator(".intro h1 + p").textContent(), "Plain JavaScript. No dependencies. Open source. Free. Forever.");
    assert.ok((await page.locator("header .brand-mark").textContent()).trim());

    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bs-body-bg").trim()), "#141618");
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(20, 22, 24)");
    assert.equal(await page.locator('.source-editor').first().evaluate((element) => getComputedStyle(element).backgroundColor), "rgb(20, 22, 24)");
    assert.equal(await page.locator('meta[name="theme-color"]').getAttribute("content"), "#141618");
    await page.locator("#site-theme").evaluate((button) => button.click());
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bs-body-bg").trim()), "#fff");
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(255, 255, 255)");
    assert.equal(await page.locator('meta[name="theme-color"]').getAttribute("content"), "#fff");
    const root = frame.locator(".byCSVdocument");
    const initial = await root.evaluate((element) => ({ font: element.style.fontFamily, size: element.style.fontSize, bg: element.style.getPropertyValue("--by-view-bg") }));
    assert.match(await frame.locator(".byVIEWtoolbar").evaluate((element) => getComputedStyle(element).fontFamily), /monospace/);
    assert.equal(await page.locator('[aria-label="Viewer suite"] a').count(), 9);
    assert.equal(await page.locator(".viewer-suite").getByRole("link", { name: "MD.edit", exact: true }).getAttribute("href"), "https://byuwur.github.io/easy-md-editor/");
    assert.equal(await page.locator('[aria-label="Viewer suite"]').getByRole("link", { name: "CSV", exact: true }).getAttribute("aria-current"), "page");
    assert.equal(await page.locator(".site-footer .fa-heart").count(), 1);
    assert.equal(await page.locator("header .fa-github").count(), 1);
    assert.equal(
      await page.evaluate(() => Boolean(document.querySelector('[aria-label="Viewer suite"]').compareDocumentPosition(document.querySelector("footer")) & Node.DOCUMENT_POSITION_FOLLOWING)),
      true
    );
    await page.locator(".preview-appearance").evaluate((element) => {
      element.open = true;
    });
    await page.locator("#preview-controls-font-0").focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.locator("#preview-controls-font-1").isChecked(), true);
    assert.equal(JSON.parse(await page.locator("#options-json").inputValue()).controlsFont, "system-ui, sans-serif");
    await page.keyboard.press("ArrowLeft");
    await page.evaluate(() => {
      for (const [id, value] of [
        ["preview-font", "Georgia, serif"],
        ["preview-size", "1.5"],
        ["preview-leading", "1.8"],
        ["preview-controls-font", "system-ui, sans-serif"],
        ["preview-bg", "#123456"],
        ["preview-ink", "#fedcba"]
      ]) {
        const input = id === "preview-controls-font" ? document.querySelector(`[name="preview-controls-font"][value="${value}"]`) : document.getElementById(id);
        if (input.type === "radio") input.checked = true;
        else input.value = value;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    assert.deepEqual(
      await root.evaluate((element) => {
        const style = getComputedStyle(element);
        return { font: style.fontFamily, size: style.fontSize, line: style.lineHeight, bg: style.backgroundColor, text: style.color };
      }),
      { font: "Georgia, serif", size: "24px", line: "43.2px", bg: "rgb(18, 52, 86)", text: "rgb(254, 220, 186)" }
    );
    assert.equal(
      await frame
        .locator("tbody td")
        .first()
        .evaluate((element) => getComputedStyle(element).fontFamily),
      "Georgia, serif"
    );
    assert.match(await frame.locator(".byVIEWtoolbar").evaluate((element) => getComputedStyle(element).fontFamily), /system-ui/);
    await page.locator("#copy-appearance").evaluate((button) => button.click());
    await page.waitForFunction(() => window.lastCopy?.includes("--by-view-controls-font"));
    assert.match(await page.evaluate(() => lastCopy), /\.byCSVdocument/);
    assert.ok((await page.evaluate(() => lastCopy)).includes("--by-view-bg: #123456"));
    await page.locator('[data-options-view="json"]').evaluate((button) => button.click());
    const configuration = JSON.parse(await page.locator("#options-json").inputValue());
    for (const [name, value] of Object.entries({
      theme: "light",
      fontFamily: "Georgia, serif",
      fontSize: 1.5,
      lineHeight: 1.8,
      controlsFont: "system-ui, sans-serif",
      backgroundColor: "#123456",
      textColor: "#fedcba"
    })) {
      assert.deepEqual(configuration[name], value, name);
    }
    assert.ok(!["options", "appearance", "callbacks"].some((key) => key in configuration));
    const readme = require("node:fs").readFileSync(path.join(__dirname, "../README.md"), "utf8");
    for (const match of readme.matchAll(/^\|\s*`([a-zA-Z]+)`\s*\|/gm)) {
      assert.ok(match[1] in configuration, `Missing parameter: ${match[1]}`);
    }
    await page.locator("#copy-options").evaluate((button) => button.click());
    await page.waitForFunction(() => window.lastCopy?.startsWith("{"));
    assert.deepEqual(JSON.parse(await page.evaluate(() => lastCopy)), configuration);
    assert.ok(!Object.keys(configuration).some((key) => key.startsWith("preview")));
    await page.locator('[data-options-view="form"]').evaluate((button) => button.click());
    await page.locator("#reset-settings").evaluate((button) => button.click());
    assert.deepEqual(await root.evaluate((element) => ({ font: element.style.fontFamily, size: element.style.fontSize, bg: element.style.getPropertyValue("--by-view-bg") })), initial);
    assert.match(await frame.locator(".byVIEWtoolbar").evaluate((element) => getComputedStyle(element).fontFamily), /monospace/);

    await page.locator("#visibleColumns").evaluate((input) => {
      input.value = "[0]";
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await frame.waitForFunction(() => document.querySelectorAll("thead tr:first-child th").length === 1);
    assert.deepEqual(JSON.parse(await page.locator("#options-json").inputValue()).visibleColumns, [0]);
    await page.locator("#visibleColumns").evaluate((input) => {
      input.value = "[";
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    assert.equal(await page.locator("#source-error").evaluate((element) => element.hidden), false);
    await page.locator("#reset-settings").evaluate((button) => button.click());

    for (const button of await page.locator("[data-example]").all()) {
      await button.evaluate((element) => element.click());
      await page.waitForFunction(() => document.getElementById("render-status").textContent.startsWith("Rendered"));
      assert.equal(await frame.locator("[role=alert]:visible").count(), 0);
      assert.match(await page.locator("#metric-size").textContent(), /B$/);
    }
    const sourceEditor = page.locator("#source");
    const fileSource = await sourceEditor.inputValue();
    await page.evaluate(() => {
      window.originalFileText = File.prototype.text;
      File.prototype.text = function () { return new Promise((resolve) => { window.finishFileRead = resolve; }); };
    });
    try {
      for (const action of ["edit", "restore", "sample"]) {
        await sourceEditor.fill(`${fileSource}\n`);
        await page.locator("#local-file").setInputFiles({ name: "pending.txt", mimeType: "text/plain", buffer: Buffer.from(fileSource) });
        if (action === "edit") await sourceEditor.fill(`${fileSource}\n\n`);
        else if (action === "restore") await page.locator("#restore-source").click();
        else await page.locator("#reset").click();
        const expected = await sourceEditor.inputValue();
        await page.evaluate((text) => window.finishFileRead(text), "An obsolete file read");
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        assert.equal(await sourceEditor.inputValue(), expected, "Late file reads preserve the newer source");
      }
    } finally {
      await page.evaluate(() => { File.prototype.text = window.originalFileText; delete window.finishFileRead; delete window.originalFileText; });
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});


test("container themes are scoped, independent, and compatible with legacy links", async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
  try {
    const page = await browser.newPage();
    const requests = [];
    page.on("request", (request) => requests.push(request.url()));
    await page.setContent('<div id="outside" class="dark">Host</div><div id="first" data-theme="dark"></div><div id="second" class="light"></div><div id="third"></div>');
    await page.addStyleTag({ path: path.join(__dirname, "../csv.css") });
    await page.addScriptTag({ path: path.join(__dirname, "../csv.js") });
    await page.evaluate(async (args) => {
      window.renderTheme = async (element) => {
        const controller = window.byCSVviewer(element, ...args);
        if (controller?.ready) await controller.ready;
      };
      for (const id of ["first", "second", "third"]) await renderTheme(document.getElementById(id));
    }, ["name\nLocal theme"]);
    const color = (id) => page.locator("#" + id).evaluate((element) => getComputedStyle(element).backgroundColor);
    assert.equal(await color("first"), "rgb(39, 40, 34)");
    assert.equal(await color("second"), "rgb(250, 250, 245)");
    assert.equal(await page.locator("#outside").evaluate((element) => getComputedStyle(element).getPropertyValue("--by-view-muted")), "");
    assert.equal(await page.locator("#first .byVIEWtoolbar").evaluate((element) => getComputedStyle(element).getPropertyValue("--by-view-muted").trim()), "#75715e");
    await page.locator("#first .byVIEWthemeToggle").click();
    assert.equal(await page.locator("#first").getAttribute("data-theme"), "light");
    assert.equal(await color("second"), "rgb(250, 250, 245)");
    await page.locator("#second .byVIEWthemeToggle").click();
    assert.equal(await page.locator("#second").getAttribute("class").then((classes) => classes.split(/\s+/).includes("dark")), true);
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

test("named palettes retain mode, isolate custom CSS, and meet High Contrast targets", async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="outside">Host</div><div id="viewer"></div><div id="other" data-theme="dark"></div>');
    await page.addStyleTag({ path: path.join(__dirname, "../csv.css") });
    await page.addScriptTag({ path: path.join(__dirname, "../csv.js") });
    await page.evaluate(async (args) => {
      window.renderPalette = async (id) => {
        const controller = window.byCSVviewer(document.getElementById(id), ...args);
        if (controller?.ready) await controller.ready;
      };
      await renderPalette("viewer");
      await renderPalette("other");
    }, ["name,value\nTheme,1"]);
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
            ? color.slice(1).match(/../g).map((part) => parseInt(part, 16))
            : color.match(/[\d.]+/g).slice(0, 3).map(Number);
          const values = channels.map((channel) => channel / 255).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
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
    await root.evaluate((element) => { element.dataset.theme = "light"; });
    assert.equal(await background(), "rgb(250, 250, 245)", "Legacy mode aliases override classes");
    await page.addStyleTag({ content: '.byCSVdocument.light[data-theme="ocean"] { --by-view-bg: #f3f8fc; } .byCSVdocument.dark[data-theme="ocean"] { --by-view-bg: #102a43; }' });
    await root.evaluate((element) => { element.dataset.theme = "ocean"; element.classList.remove("light", "dark"); });
    await page.route("https://legacy.test/**", (route) => route.fulfill({ body: "", contentType: "text/css" }));
    await page.evaluate(() => new Promise((resolve) => {
      const link = document.createElement("link");
      link.id = "byVIEWtheme";
      link.rel = "stylesheet";
      link.href = "https://legacy.test/csv.dark.css?cache=1#theme";
      link.onload = resolve;
      document.head.appendChild(link);
    }));
    await page.evaluate(() => renderPalette("viewer"));
    assert.equal(await background(), "rgb(250, 250, 245)", "An unclassified custom palette starts in Light");
    await root.locator(".byVIEWthemeToggle").click();
    assert.equal(await background(), "rgb(16, 42, 67)");
    assert.equal(await root.getAttribute("data-theme"), "ocean");
    assert.equal(await page.locator("#byVIEWtheme").getAttribute("href"), "https://legacy.test/csv.dark.css?cache=1#theme");
    assert.equal(await page.locator("#other").evaluate((element) => getComputedStyle(element).backgroundColor), "rgb(39, 40, 34)");
    assert.equal(await page.locator("#outside").evaluate((element) => getComputedStyle(element).getPropertyValue("--by-view-muted")), "");

  } finally {
    await browser.close();
  }
});

test("playground palettes and editable two-mode custom themes stay synchronized", async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text) => { window.lastCopy = text; } } }));
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.href === "https://cdn.jsdelivr.net/gh/byuwur/spa.js@v20.6/css/bootstrap.min.css") return route.fulfill({ body: await getBootstrapCSS(), contentType: "text/css" });
      if (url.origin !== "https://viewer.test") return route.abort();
      const file = path.basename(url.pathname);
      return route.fulfill({ path: path.join(__dirname, "..", file), contentType: file.endsWith(".html") ? "text/html" : file.endsWith(".js") ? "text/javascript" : "text/css" });
    });
    await page.goto("https://viewer.test/index.html");
    const frame = page.frames().find((candidate) => candidate.parentFrame());
    await frame.waitForSelector(".byVIEWtoolbar");
    const root = frame.locator(".byCSVdocument");
    const editor = page.locator("#custom-theme-css");
    const palette = page.locator("#preview-palette");
    const background = () => root.evaluate((element) => getComputedStyle(element).backgroundColor);
    const initialBackground = await background();
    const hostBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.equal(await palette.inputValue(), "monokai");
    await page.waitForFunction(() => document.getElementById("custom-theme-css").value.includes('.dark[data-theme="custom"]'));
    const defaults = await editor.inputValue();
    assert.ok(defaults.includes('.byCSVdocument.light[data-theme="custom"]'));
    await palette.selectOption("github");
    const setMode = (mode) => page.evaluate((mode) => {
      const input = document.querySelector('#preview-theme, input[name="viewerTheme"][value="' + mode + '"], input[name="previewTheme"][value="' + mode + '"]');
      if (input.tagName === "SELECT") input.value = mode;
      else input.checked = true;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, mode);
    await setMode("dark");
    assert.equal(await background(), "rgb(13, 17, 23)");
    await root.locator(".byVIEWthemeToggle").click();
    await page.waitForFunction(() => JSON.parse(document.getElementById("options-json").value).theme === "light");
    assert.equal(await palette.inputValue(), "github");
    assert.equal(await background(), "rgb(255, 255, 255)");
    for (const name of ["solarized", "high-contrast"]) {
      await palette.selectOption(name);
      assert.equal(await root.getAttribute("data-theme"), name);
      assert.ok((await editor.inputValue()).includes("--by-view-bg"));
      await setMode("dark");
      assert.equal(await background(), name === "solarized" ? "rgb(0, 43, 54)" : "rgb(0, 0, 0)");
    }
    await page.locator(".preview-appearance").evaluate((element) => { element.open = true; });
    const custom = '.byCSVdocument.light[data-theme="custom"] { --by-view-bg: #f3f8fc; }\n.byCSVdocument.dark[data-theme="custom"] { --by-view-bg: #102a43; }';
    await editor.fill(custom);
    await page.waitForFunction(() => document.getElementById("preview-palette").value === "custom");
    assert.equal(await background(), "rgb(16, 42, 67)");
    await setMode("light");
    assert.equal(await background(), "rgb(243, 248, 252)");
    await root.locator(".byVIEWthemeToggle").click();
    assert.equal(await root.getAttribute("data-theme"), "custom");
    assert.equal(await background(), "rgb(16, 42, 67)");
    await page.locator("#copy-theme").evaluate((button) => button.click());
    await page.waitForFunction(() => window.lastCopy?.includes('[data-theme="custom"]'));
    assert.equal(await page.evaluate(() => lastCopy), custom);
    const config = JSON.parse(await page.locator("#options-json").inputValue());
    assert.equal(config.theme, "dark");
    assert.equal(config.palette, "custom");
    assert.equal(config.customThemeCSS, custom);
    assert.ok(!("appearance" in config) && !("options" in config));
    await palette.selectOption("github");
    assert.equal(await background(), "rgb(13, 17, 23)");
    await palette.selectOption("custom");
    assert.equal(await editor.inputValue(), custom, "Preset changes retain the draft");
    assert.equal(await background(), "rgb(16, 42, 67)");
    await page.locator("#reset-settings, #reset-options").evaluate((button) => button.click());
    await page.waitForFunction(() => document.getElementById("preview-palette").value === "monokai");
    assert.equal(await editor.inputValue(), defaults);
    assert.equal(await background(), initialBackground);
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), hostBackground);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test("viewer defaults, optional tools, and copy feedback", async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
  try {
    const page = await browser.newPage({ viewport: { width: 320, height: 720 }, reducedMotion: "reduce" });
    await page.setContent('<div id="viewer"></div>');
    await page.addStyleTag({ path: path.join(__dirname, "../csv.css") });
    await page.addScriptTag({ path: path.join(__dirname, "../csv.js") });
    await page.evaluate((args) => {
      window.renderUI = async (options = {}) => {
        const result = byCSVviewer(document.getElementById("viewer"), ...args, options);
        await result?.ready;
      };
    }, ["name,value\nneedle,2\nother,1"]);
    await page.evaluate(() => renderUI());
    assert.equal(await page.locator(".byVIEWcontrols button").count(), 5);
    assert.equal(await page.locator(".byVIEWfontSizes").count(), 1);
    assert.equal(await page.locator(".byVIEWactions :is(input, select, button):visible").count(), 0);
    assert.equal(await page.locator(".byVIEWstatus:visible").count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.evaluate(() => renderUI({ fontSizeControls: false, statusBar: false }));
    assert.equal(await page.locator(".byVIEWfontSizes").count(), 0);
    assert.equal(await page.locator(".byVIEWstatus:visible").count(), 0);
    await page.evaluate(() => renderUI());
    for (const scale of [1, 1.5]) {
      for (const controlsSize of ["small", "regular", "large"]) {
        for (const font of ["ui-monospace, monospace", "Georgia, serif"]) {
          for (const mode of ["light", "dark"]) {
            const errors = await page.evaluate(async ({ scale, controlsSize, font, mode }) => {
              document.documentElement.style.fontSize = `${scale}rem`;
              const host = document.getElementById("viewer");
              host.dataset.theme = mode;
              host.style.setProperty("--by-view-controls-font", font);
              await renderUI({ controlsSize });
              const button = host.querySelector(".byVIEWthemeToggle");
              const rect = button.getBoundingClientRect();
              const style = getComputedStyle(button), thumb = getComputedStyle(button, "::after");
              const innerWidth = rect.width - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth);
              const innerHeight = rect.height - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth);
              const position = (value, extent) => value.endsWith("%") ? parseFloat(value) * extent / 100 : parseFloat(value);
              const centerX = rect.left + parseFloat(style.borderLeftWidth) + position(thumb.left, innerWidth);
              const centerY = rect.top + parseFloat(style.borderTopWidth) + position(thumb.top, innerHeight);
              const icons = [...button.querySelectorAll("svg")];
              const icon = icons[mode === "dark" ? 1 : 0].getBoundingClientRect();
              return [Math.abs(centerX - icon.x - icon.width / 2), Math.abs(centerY - icon.y - icon.height / 2), Math.abs(centerY - rect.y - rect.height / 2)];
            }, { scale, controlsSize, font, mode });
            assert.ok(errors.every((error) => error < 0.06), `${scale} ${controlsSize} ${font} ${mode}: ${errors}`);
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
      await page.locator("#viewer").evaluate((element, mode) => { element.dataset.theme = mode; }, mode);
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
    await page.evaluate((options) => renderUI({ fontSizeControls: true, ...options }), {"search":true,"columnFilters":true,"copyCells":true,"columnsButton":true,"statusBar":true});
    assert.equal(await page.locator(".byVIEWfontSize").count(), 3);
    assert.equal(await page.locator(".byVIEWpanel > .byVIEWstatus:visible").count(), 1);
    assert.ok(await page.locator(".byVIEWpanel > .byVIEWstatus").evaluate((status) => parseFloat(getComputedStyle(status).borderBottomWidth) > 0));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("Denied"); } } });
    });
    await page.locator(".byVIEWcopy").click();
    await page.mouse.move(0, 0);
    await page.locator(".byVIEWcopy").evaluate((element) => element.blur());
    assert.equal(await page.locator(".byVIEWcopy").getAttribute("data-state"), "error");
    assert.equal(await page.locator(".byVIEWcopy").textContent(), "Failed");
    await page.evaluate(() => { navigator.clipboard.writeText = async (value) => { window.copiedSource = value; }; });
    await page.locator(".byVIEWcopy").click();
    assert.equal(await page.locator(".byVIEWcopy").getAttribute("data-state"), "success");
    assert.match(await page.evaluate(() => copiedSource), /needle/);
  } finally {
    await browser.close();
  }
});
