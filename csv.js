"use strict";
/*
 * File: csv.js
 * Desc: Standalone CSV viewer. No runtime dependencies.
 * Copyright (c) 2026 Andres Trujillo [Mateus] byUwUr
 * https://github.com/byuwur/easy-csv-viewer
 * MIT License (see LICENSE).
 */
(function (global) {
  /* --- INITIALIZATION --- */
  if (global.byCSVviewer?.initialized) return;

  /* --- METADATA --- */
  byCSVviewer.VERSION = "1.2"; // 2026-11-04

  /* --- STATE --- */
  const instances = new WeakMap();
  /* --- HELPERS --- */
  const node = (tag, className = "", text) => {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  };
  const button = (parent, text, label, action) => {
    const control = node("button", "", text);
    control.type = "button";
    control.title = label;
    control.setAttribute("aria-label", label);
    control.addEventListener("click", action);
    parent.appendChild(control);
    return control;
  };
  // Keep cell values in place so clipboard feedback cannot resize the table.
  const copyCell = (parent, getText, label, text) => {
    const control = button(parent, text, label, async () => {
      control.disabled = true;
      try {
        await navigator.clipboard.writeText(getText());
        control.title = `Copied! ${label}`;
        control.setAttribute("aria-label", control.title);
        control.dataset.state = "success";
      } catch {
        control.dataset.state = "error";
        control.title = "Copy failed. Check clipboard access.";
        control.setAttribute("aria-label", `${control.title} ${label}`);
      } finally {
        control.disabled = false;
      }
    });
    control.className = "byCSVcell";
    const reset = () => {
      if (control.dataset.state === "error") return;
      delete control.dataset.state;
      control.title = label;
      control.setAttribute("aria-label", label);
    };
    control.addEventListener("mouseleave", reset);
    control.addEventListener("focusout", reset);
    return control;
  };
  /** Yield at a chunk boundary so input events and replacement renders can run. */
  const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
  const positive = (value, fallback, maximum) => (Number.isInteger(value) && value > 0 ? Math.min(value, maximum) : fallback);
  /* --- CONTROLS --- */
  // Mirrored across the family so each viewer can run without a shared runtime.
  /**
   * Adds container light/dark controls, retaining legacy stylesheet links as a fallback.
   * @param {HTMLElement} element Viewer container and theme owner.
   * @param {HTMLElement} controls Toolbar control group.
   * @param {string} filename Legacy theme stylesheet basename.
   * @returns {HTMLButtonElement} Theme toggle button.
   */
  const appendThemeToggle = (element, controls, filename) => {
    const escapedFilename = filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const themePattern = new RegExp(`^([^?#]*/)?${escapedFilename}\\.(light|dark)\\.css([?#].*)?$`, "i");
    const stylesheet = [document.getElementById("byVIEWtheme"), ...document.querySelectorAll('link[rel~="stylesheet"]')].find((link) => link && themePattern.test(link.getAttribute("href") || ""));
    // Explicit container state takes precedence over a shared legacy stylesheet.
    const localTheme = (target) => {
      if (["light", "dark"].includes(target.dataset.theme)) return target.dataset.theme;
      if (target.classList.contains("dark")) return "dark";
      if (target.classList.contains("light")) return "light";
      return target.dataset.theme ? "light" : null;
    };
    const legacyTheme = () => (stylesheet?.isConnected ? (stylesheet.getAttribute("href") || "").match(themePattern) : null);
    const getTheme = () => localTheme(element) || legacyTheme()?.[2].toLowerCase() || "light";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "byVIEWthemeToggle";
    button.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M21 12.8A9 9 0 0 1 11.2 3 9 9 0 1 0 21 12.8Z"/></svg><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4m0-14.2-1.4 1.4M6.3 17.7l-1.4 1.4"/></svg>';
    const sync = () => {
      const next = getTheme() === "dark" ? "light" : "dark";
      const toggles = !localTheme(element) && legacyTheme() ? [button, ...document.querySelectorAll(".byCSVdocument > .byVIEWtoolbar > .byVIEWcontrols > .byVIEWthemeToggle")] : [button];
      for (const toggle of toggles) {
        // A legacy link must not change the controls of independently themed viewers.
        if (toggle !== button && localTheme(toggle.closest(".byCSVdocument"))) continue;
        toggle.title = `Switch to ${next} theme`;
        toggle.setAttribute("aria-label", toggle.title);
      }
    };
    button.addEventListener("click", () => {
      const next = getTheme() === "dark" ? "light" : "dark";
      if (!localTheme(element) && legacyTheme()) {
        const href = stylesheet.getAttribute("href");
        stylesheet.setAttribute(
          "href",
          href.replace(themePattern, (_, path = "", theme, suffix = "") => `${path}${filename}.${next}.css${suffix}`)
        );
      } else if (element.dataset.theme && !["light", "dark"].includes(element.dataset.theme)) {
        // Named palettes stay selected while only the mode changes.
        element.classList.toggle("light", next === "light");
        element.classList.toggle("dark", next === "dark");
      } else if (element.hasAttribute("data-theme") || (!element.classList.contains("light") && !element.classList.contains("dark"))) {
        element.dataset.theme = next;
      } else {
        element.classList.toggle("light", next === "light");
        element.classList.toggle("dark", next === "dark");
      }
      sync();
    });
    button.addEventListener("focus", sync);
    button.addEventListener("pointerenter", sync);
    sync();
    return controls.appendChild(button);
  };

  /**
   * Adds text size controls for a renderer.
   * @param {HTMLElement} element - Renderer whose font size is changed.
   * @param {HTMLElement} controls - Toolbar that receives the controls.
   * @return {HTMLElement} The text size button group.
   */
  const appendFontSizeControls = (element, controls) => {
    element.dataset.byViewDefaultFontSize ??= element.style.fontSize;
    const sizes = document.createElement("div");
    sizes.className = "byVIEWfontSizes";
    controls.appendChild(sizes);
    const getSize = () => (parseFloat(getComputedStyle(element).fontSize) || 16) / (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
    const decrease = document.createElement("button");
    const increase = document.createElement("button");
    const reset = document.createElement("button");
    reset.textContent = "A";
    decrease.textContent = "A-";
    increase.textContent = "A+";
    for (const [button, title] of [
      [decrease, "Decrease text size"],
      [reset, "Reset text size"],
      [increase, "Increase text size"]
    ]) {
      button.type = "button";
      button.className = "byVIEWfontSize";
      button.title = title;
      button.setAttribute("aria-label", title);
      sizes.appendChild(button);
    }
    const sync = () => {
      const size = getSize();
      decrease.disabled = size <= 0.5;
      increase.disabled = size >= 3;
    };
    for (const [button, step] of [
      [decrease, -0.125],
      [increase, 0.125]
    ]) {
      button.addEventListener("click", () => {
        const size = Math.max(0.5, Math.min(3, getSize() + step));
        element.style.fontSize = `${size}rem`;
        sync();
      });
    }
    reset.addEventListener("click", () => {
      element.style.fontSize = element.dataset.byViewDefaultFontSize;
      sync();
    });
    sync();
    return sizes;
  };

  /**
   * Add a copy action for the complete source, including content outside the visible rendered chunk.
   * @param {HTMLElement} controls Toolbar control group.
   * @param {Function} getText Callback that returns the text to copy.
   * @param {string} label Human-readable label.
   * @returns {void}
   */
  const appendCopyButton = (controls, getText, label) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "byVIEWcopy";
    button.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640" aria-hidden="true" focusable="false"><!--!Font Awesome Free 7.3.1 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2026 Fonticons, Inc.--><path d="M288 64C252.7 64 224 92.7 224 128L224 384C224 419.3 252.7 448 288 448L480 448C515.3 448 544 419.3 544 384L544 183.4C544 166 536.9 149.3 524.3 137.2L466.6 81.8C454.7 70.4 438.8 64 422.3 64L288 64zM160 192C124.7 192 96 220.7 96 256L96 512C96 547.3 124.7 576 160 576L352 576C387.3 576 416 547.3 416 512L416 496L352 496L352 512L160 512L160 256L176 256L176 192L160 192z"/></svg>`;
    const caption = document.createElement("span");
    caption.setAttribute("aria-live", "polite");
    button.appendChild(caption);
    const reset = () => {
      if (button.dataset.state === "error") return;
      delete button.dataset.state;
      caption.textContent = "Copy";
      button.title = label;
      button.setAttribute("aria-label", label);
    };
    reset();
    button.addEventListener("mouseleave", reset);
    button.addEventListener("focusout", reset);
    controls.appendChild(button);
    button.addEventListener("click", async (event) => {
      button.disabled = true;
      let message = "Copied!";
      try {
        await navigator.clipboard.writeText(getText(event));
        caption.textContent = message;
        button.dataset.state = "success";
      } catch {
        caption.textContent = "Failed";
        button.dataset.state = "error";
        message = "Copy failed. Check clipboard access.";
      } finally {
        button.disabled = false;
        button.title = `${message} ${label}`;
        button.setAttribute("aria-label", button.title);
      }
    });
  };

  /* --- PARSING --- */
  const csvOptions = (options) => {
    const result = { delimiter: ",", headers: true, skipEmptyLines: true, pageSize: 50, search: false, columnFilters: false, copyCells: false, ...options };
    if (typeof result.delimiter !== "string" || result.delimiter.length !== 1 || /["\r\n\uFEFF]/.test(result.delimiter)) throw new TypeError("delimiter must be one character other than a quote or line break.");
    result.pageSize = positive(result.pageSize, 50, 1000);
    return result;
  };
  const cellText = (value) => (value === null || value === undefined ? "" : String(value));
  const scalar = (value) => value === null || value === undefined || ["string", "number", "boolean", "bigint"].includes(typeof value);

  // One parser serves synchronous parsing and cooperative browser rendering.
  /** Yield cooperative parsing checkpoints and return columns/rows when done; quoted fields may span lines. */
  function* readCSV(input, options) {
    let columns = [],
      rows = [];
    const pushRow = (row) => {
      if (!columns.length) {
        columns = options.headers ? row.map(cellText) : row.map((_, index) => `Column ${index + 1}`);
        if (columns.length > 500) throw new RangeError("CSV exceeds 500 columns.");
        if (options.headers) return;
      }
      if (row.length !== columns.length) throw new SyntaxError(`Row ${rows.length + (options.headers ? 2 : 1)} has ${row.length} fields; expected ${columns.length}.`);
      if (rows.length >= 100000) throw new RangeError("CSV exceeds 100,000 rows.");
      rows.push(row);
    };
    if (Array.isArray(input)) {
      if (input.length > 100000) throw new RangeError("CSV exceeds 100,000 rows.");
      if (!input.length) return { columns, rows };
      if (Array.isArray(input[0])) {
        for (let i = 0; i < input.length; i++) {
          if (!Array.isArray(input[i]) || !input[i].every(scalar)) throw new TypeError("Expected arrays of scalar values.");
          pushRow(Array.from(input[i]));
          if (i % 1000 === 0) yield;
        }
      } else {
        const keys = new Set();
        for (let i = 0; i < input.length; i++) {
          const record = input[i];
          if (!record || typeof record !== "object" || Array.isArray(record)) throw new TypeError("Expected an array of records.");
          Object.keys(record).forEach((key) => keys.add(key));
          if (keys.size > 500) throw new RangeError("CSV exceeds 500 columns.");
          if (i % 1000 === 0) yield;
        }
        columns = [...keys];
        for (let i = 0; i < input.length; i++) {
          const row = columns.map((key) => (Object.hasOwn(input[i], key) ? input[i][key] : undefined));
          if (!row.every(scalar)) throw new TypeError("Record values must be scalar (string, number, boolean, bigint, null, or undefined).");
          rows.push(row);
          if (i % 1000 === 0) yield;
        }
      }
      return { columns, rows };
    }
    if (typeof input !== "string") throw new TypeError("CSV input must be text or an array.");
    if (input.length > 10000000) throw new RangeError("CSV exceeds 10 million characters.");
    const text = input.replace(/^\uFEFF/, "");
    let row = [],
      field = "",
      quoted = false,
      closed = false,
      touched = false,
      nextYield = 0;
    const finishRow = () => {
      row.push(field);
      if (!options.skipEmptyLines || touched || row.length > 1 || field !== "") pushRow(row);
      row = [];
      field = "";
      closed = false;
      touched = false;
    };
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (quoted) {
        if (char === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            quoted = false;
            closed = true;
          }
        } else field += char;
      } else if (char === options.delimiter) {
        row.push(field);
        field = "";
        closed = false;
        touched = true;
        if (row.length >= 500) throw new RangeError("CSV exceeds 500 columns.");
      } else if (char === "\n" || char === "\r") {
        finishRow();
        if (char === "\r" && text[i + 1] === "\n") i++;
      } else if (char === '"' && !field && !closed) {
        quoted = true;
        touched = true;
      } else {
        // A closed quoted field accepts only separators; trailing whitespace is still invalid CSV.
        if (closed || char === '"') throw new SyntaxError(`Unexpected character after field at offset ${i}.`);
        field += char;
        touched = true;
      }
      if (i >= nextYield) {
        nextYield = i + 32768;
        yield;
      }
    }
    if (quoted) throw new SyntaxError("Unclosed quoted field.");
    if (touched || row.length || field || closed) finishRow();
    return { columns, rows };
  }

  /* --- LIFECYCLE --- */
  // One instance owns the container; replacement disposes its pending work first.
  /** Replace the previous owner and return its cancellable state. Only the current owner may clear the host. */
  const mount = (element, options, getText) => {
    if (!(element instanceof HTMLElement)) throw new TypeError("byCSVviewer: element must be an HTMLElement.");
    instances.get(element)?.destroy();
    const state = { active: true };
    state.destroy = () => {
      if (!state.active) return;
      state.active = false;
      if (instances.get(element) === state) {
        instances.delete(element);
        element.replaceChildren();
        element.classList.remove("byCSVdocument", "byVIEWcompact", "byVIEWbottom", "byVIEWmotion");
        element.removeAttribute("aria-busy");
      }
    };
    instances.set(element, state);
    element.replaceChildren();
    element.classList.add("byCSVdocument");
    element.classList.toggle("byVIEWmotion", options.animations !== false);
    element.classList.toggle("byVIEWcompact", options.controlsCompact !== false);
    element.classList.toggle("byVIEWbottom", options.controlsPosition === "bottom");
    const content = node("div", "byVIEWcontent");
    const toolbar = node("div", "byVIEWtoolbar");
    toolbar.dataset.size = ["small", "regular", "large"].includes(options.controlsSize) ? options.controlsSize : "regular";
    const info = node("small", "byVIEWinfo");
    for (const [text, href] of [
      ["easy-csv-viewer", "https://github.com/byuwur/easy-csv-viewer"],
      ["@byUwUr", "https://byuwur.co"]
    ]) {
      const link = node("a", "", text);
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      if (info.childNodes.length) info.append(` · v${byCSVviewer.VERSION} · `);
      info.appendChild(link);
    }
    if (options.credits !== false) toolbar.appendChild(info);
    const controls = node("div", "byVIEWcontrols");
    controls.setAttribute("role", "group");
    controls.setAttribute("aria-label", "Viewer controls");
    if (options.themeToggle !== false) appendThemeToggle(element, controls, "csv");
    if (options.fontSizeControls !== false) appendFontSizeControls(element, controls);
    if (options.copyButton !== false) appendCopyButton(controls, getText, "Copy source");
    if (controls.childNodes.length) toolbar.appendChild(controls);
    if (options.toolbar === false || !toolbar.childNodes.length) {
      element.classList.remove("byVIEWbottom");
      element.appendChild(content);
    } else element.append(...(options.controlsPosition === "bottom" ? [content, toolbar] : [toolbar, content]));
    state.content = content;
    state.error = (error) => {
      if (!state.active) return;
      element.setAttribute("aria-busy", "false");
      const message = node("p", "byVIEWerror", error.message);
      message.setAttribute("role", "alert");
      content.replaceChildren(message);
    };
    return state;
  };

  /* --- PUBLIC API --- */
  /** Render CSV/TSV text or scalar records. ready resolves false on a displayed data error or cancellation. */
  function byCSVviewer(element, input, options = {}) {
    options = csvOptions(options);
    if (input === undefined) input = element?.textContent ?? "";
    let data = { columns: [], rows: [] };
    const serialize = () => {
      const escape = (value) => {
        const text = cellText(value);
        return text.includes(options.delimiter) || /["\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
      };
      return [data.columns, ...data.rows].map((row) => row.map(escape).join(options.delimiter)).join("\r\n");
    };
    const state = mount(element, options, () => (typeof input === "string" ? input : serialize()));
    element.setAttribute("aria-busy", "true");
    const status = node("p", "byVIEWstatus", "Loading…");
    status.setAttribute("role", "status");
    state.content.appendChild(status);
    state.ready = (async () => {
      try {
        const parser = readCSV(input, options);
        let step;
        do {
          if (!state.active) return false;
          step = parser.next();
          if (!step.done) await pause();
        } while (!step.done);
        data = step.value;
        if (!state.active) return false;
        const actions = node("div", "byVIEWactions");
        const search = node("input");
        search.type = "search";
        search.placeholder = "Search all columns";
        search.setAttribute("aria-label", "Search all columns");
        if (options.search !== false) actions.appendChild(search);
        const chooser = node("details", "byCSVcolumns");
        chooser.appendChild(node("summary", "", "Columns"));
        const visible = data.columns.map((name, index) => !Array.isArray(options.visibleColumns) || options.visibleColumns.includes(index) || options.visibleColumns.includes(name));
        const filters = data.columns.map(() => "");
        data.columns.forEach((name, index) => {
          const label = node("label");
          const checkbox = node("input");
          checkbox.type = "checkbox";
          checkbox.checked = visible[index];
          checkbox.addEventListener("change", () => {
            visible[index] = checkbox.checked;
            renderPage();
          });
          label.append(checkbox, ` ${name || `Column ${index + 1}`}`);
          chooser.appendChild(label);
        });
        if (options.columnsButton === true) actions.appendChild(chooser);
        const scroll = node("div", "byCSVscroll");
        scroll.tabIndex = 0;
        scroll.setAttribute("role", "region");
        scroll.setAttribute("aria-label", "CSV data table");
        const table = node("table", "byCSVtable");
        scroll.appendChild(table);
        const pager = node("div", "byVIEWactions");
        let page = 0,
          sortColumn = -1,
          direction = 1,
          indices = data.rows.map((_, i) => i),
          generation = 0;
        const previous = button(pager, "Previous", "Previous page", () => {
          page--;
          renderPage();
        });
        const pageLabel = node("span", "byVIEWstatus");
        pageLabel.setAttribute("role", "status");
        pager.appendChild(pageLabel);
        const next = button(pager, "Next", "Next page", () => {
          page++;
          renderPage();
        });
        const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
        /* --- RENDERING --- */
        /** Replace the visible page; retaining the header preserves native column-filter focus while typing. */
        const renderPage = (rebuildHeader = true) => {
          if (!state.active) return;
          const count = options.pagination === false ? 1 : Math.max(1, Math.ceil(indices.length / options.pageSize));
          const focusedColumn = table.contains(document.activeElement) ? (document.activeElement.dataset.column ?? null) : null;
          page = Math.max(0, Math.min(page, count - 1));
          const head = node("thead"),
            header = node("tr");
          head.appendChild(header);
          const filterRow = node("tr");
          data.columns.forEach((name, index) => {
            if (!visible[index]) return;
            const th = node("th");
            th.scope = "col";
            if (options.sorting !== false) th.setAttribute("aria-sort", sortColumn === index ? (direction === 1 ? "ascending" : "descending") : "none");
            if (options.sorting !== false)
              button(th, name || `Column ${index + 1}`, `Sort by ${name || `column ${index + 1}`}`, () => {
                if (sortColumn !== index) {
                  sortColumn = index;
                  direction = 1;
                } else if (direction === 1) {
                  direction = -1;
                } else {
                  sortColumn = -1;
                  direction = 1;
                }
                update();
              }).dataset.column = String(index);
            else th.textContent = name || `Column ${index + 1}`;
            header.appendChild(th);
            if (options.columnFilters !== false) {
              const cell = node("th");
              const filter = node("input");
              filter.type = "search";
              filter.size = 1;
              filter.value = filters[index];
              filter.setAttribute("aria-label", `Filter ${name || `column ${index + 1}`}`);
              filter.addEventListener("input", () => {
                filters[index] = filter.value.toLowerCase();
                update(false);
              });
              cell.appendChild(filter);
              filterRow.appendChild(cell);
            }
          });
          if (options.columnFilters !== false) head.appendChild(filterRow);
          const body = node("tbody");
          for (const index of options.pagination === false ? indices : indices.slice(page * options.pageSize, (page + 1) * options.pageSize)) {
            const row = node("tr");
            data.rows[index].forEach((value, column) => {
              if (!visible[column]) return;
              const cell = node("td");
              if (options.copyCells !== false) copyCell(cell, () => cellText(value), `Copy ${data.columns[column]} value`, cellText(value));
              else cell.textContent = cellText(value);
              row.appendChild(cell);
            });
            body.appendChild(row);
          }
          if (!rebuildHeader && table.tHead) table.tBodies[0].replaceWith(body);
          else table.replaceChildren(head, body);
          if (focusedColumn !== null && rebuildHeader) table.querySelector(`button[data-column="${focusedColumn}"]`)?.focus({ preventScroll: true });
          pager.hidden = options.pagination === false || count <= 1;
          status.hidden = options.statusBar === false && indices.length > 0 && visible.some(Boolean);
          status.textContent = !visible.some(Boolean) ? "All columns are hidden." : indices.length ? `${indices.length.toLocaleString()} of ${data.rows.length.toLocaleString()} rows` : "No matching rows.";
          pageLabel.textContent = `Page ${page + 1} of ${count}`;
          previous.disabled = page === 0;
          next.disabled = page + 1 >= count;
          element.setAttribute("aria-busy", "false");
        };
        /** Build a filtered/sorted index without changing source rows; superseded passes cannot publish results. */
        const update = async (rebuildHeader = true) => {
          // Filter/sort row indices instead of mutating the parsed data or its input order.
          // A newer query must supersede this pass before it publishes its results.
          const version = ++generation;
          element.setAttribute("aria-busy", "true");
          const query = search.value.toLowerCase();
          const found = [];
          for (let i = 0; i < data.rows.length; i++) {
            const row = data.rows[i];
            if ((!query || row.some((value) => cellText(value).toLowerCase().includes(query))) && filters.every((filter, col) => !filter || cellText(row[col]).toLowerCase().includes(filter))) found.push(i);
            if (i % 2000 === 0) {
              await pause();
              if (!state.active || version !== generation) return;
            }
          }
          if (sortColumn >= 0) found.sort((a, b) => direction * collator.compare(cellText(data.rows[a][sortColumn]), cellText(data.rows[b][sortColumn])) || a - b);
          if (!state.active || version !== generation) return;
          indices = found;
          page = 0;
          renderPage(rebuildHeader);
        };
        search.addEventListener("input", () => update());
        const panel = node("div", "byVIEWpanel");
        panel.append(status, scroll);
        state.content.replaceChildren(actions, panel, pager);
        renderPage();
        return true;
      } catch (error) {
        state.error(error);
        return false;
      }
    })();
    return { ready: state.ready, destroy: state.destroy };
  }

  byCSVviewer.parse = (input, options = {}) => {
    const parser = readCSV(input, csvOptions(options));
    let step;
    do {
      step = parser.next();
    } while (!step.done);
    return step.value;
  };
  /* --- EXPORT --- */
  global.byCSVviewer = byCSVviewer;
  byCSVviewer.initialized = true;
})(typeof window !== "undefined" ? window : this);
