(function () {
  "use strict";

  const QUICK_COLUMNS = [
    "INVENTORY_ITEM_ID",
    "VENDOR_ID",
    "STATUS_CODE",
    "ORGANIZATION_ID",
    "COLLAB_SOURCE_ID",
    "RELATIONSHIP_ID",
    "PLAN_ID",
    "SUPPLIER_SITE_ID",
  ];

  let schemaData = null;
  let allObjects = [];
  let columnIndex = []; // [{ name, upper, count, tableCount, viewCount }]
  let currentMatches = []; // [{ obj, matchedColumns }]
  let expandedCards = new Set();
  let currentDrawerObj = null;
  let acActiveIndex = -1;

  const state = {
    query: "",
    typeFilter: "ALL", // ALL | TABLE | VIEW
    exact: false,
    sort: "relevance",
  };

  // DOM refs
  const els = {
    searchInput: document.getElementById("search-input"),
    clearBtn: document.getElementById("clear-btn"),
    acList: document.getElementById("autocomplete-list"),
    exactToggle: document.getElementById("exact-toggle"),
    sortSelect: document.getElementById("sort-select"),
    quickChips: document.getElementById("quick-chips"),
    resultsSummary: document.getElementById("results-summary"),
    resultsList: document.getElementById("results-list"),
    toggleAllBtn: document.getElementById("toggle-all-btn"),
    copyNamesBtn: document.getElementById("copy-names-btn"),
    exportCsvBtn: document.getElementById("export-csv-btn"),
    statTables: document.getElementById("stat-tables"),
    statViews: document.getElementById("stat-views"),
    statColumns: document.getElementById("stat-columns"),
    countAll: document.getElementById("count-all"),
    countTable: document.getElementById("count-table"),
    countView: document.getElementById("count-view"),
    metaRelease: document.getElementById("meta-release"),
    metaSource: document.getElementById("meta-source"),
    segBtns: Array.from(document.querySelectorAll(".seg-btn")),
    // Drawer
    drawerBackdrop: document.getElementById("drawer-backdrop"),
    drawer: document.getElementById("drawer"),
    drawerClose: document.getElementById("drawer-close"),
    drawerBadge: document.getElementById("drawer-badge"),
    drawerTitle: document.getElementById("drawer-title"),
    drawerDesc: document.getElementById("drawer-desc"),
    drawerMeta: document.getElementById("drawer-meta"),
    drawerColCount: document.getElementById("drawer-col-count"),
    drawerQueryTab: document.getElementById("drawer-query-tab"),
    drawerTabs: Array.from(document.querySelectorAll(".drawer-tab")),
    drawerColumnsPane: document.getElementById("drawer-columns-pane"),
    drawerQueryPane: document.getElementById("drawer-query-pane"),
    drawerColFilter: document.getElementById("drawer-col-filter"),
    drawerColumnsWrap: document.getElementById("drawer-columns-table-wrap"),
    drawerQueryCode: document.getElementById("drawer-query-code"),
    copyQueryBtn: document.getElementById("copy-query-btn"),
    toast: document.getElementById("toast"),
  };

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatDatatype(col) {
    if (!col.datatype) return "—";
    if (col.length) return `${col.datatype}(${col.length})`;
    if (col.precision) return `${col.datatype}(${col.precision})`;
    return col.datatype;
  }

  function highlightTerms(text, terms) {
    const safe = escapeHtml(text);
    if (!terms.length) return safe;
    const escapedTerms = terms
      .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .sort((a, b) => b.length - a.length);
    const re = new RegExp(`(${escapedTerms.join("|")})`, "gi");
    return safe.replace(re, "<mark>$1</mark>");
  }

  let toastTimer = null;
  function showToast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.add("hidden"), 2200);
  }

  function parseQueryTerms(raw) {
    return raw
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
  }

  function buildColumnIndex(objects) {
    const map = new Map();
    for (const obj of objects) {
      const seenInObj = new Set();
      for (const col of obj.columns) {
        const key = col.name.toUpperCase();
        if (seenInObj.has(key)) continue;
        seenInObj.add(key);
        let entry = map.get(key);
        if (!entry) {
          entry = { name: col.name, upper: key, count: 0, tableCount: 0, viewCount: 0 };
          map.set(key, entry);
        }
        entry.count++;
        if (obj.type === "TABLE") entry.tableCount++;
        else entry.viewCount++;
      }
    }
    return Array.from(map.values()).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  function computeMatches(objects, terms, exact) {
    const matched = [];
    for (const obj of objects) {
      if (terms.length === 0) {
        matched.push({ obj, matchedColumns: [], score: 0 });
        continue;
      }

      // Every comma-separated term must match at least one column in the object
      const allTermMatches = [];
      let allTermsSatisfied = true;
      let score = 0;

      for (const term of terms) {
        const colsForTerm = obj.columns.filter((col) => {
          const upper = col.name.toUpperCase();
          return exact ? upper === term : upper.includes(term);
        });
        if (colsForTerm.length === 0) {
          allTermsSatisfied = false;
          break;
        }
        for (const c of colsForTerm) {
          const upper = c.name.toUpperCase();
          if (upper === term) score += 100;
          else if (upper.startsWith(term)) score += 40;
          else score += 10;
          allTermMatches.push(c);
        }
      }

      if (allTermsSatisfied) {
        // Deduplicate matched columns while preserving order
        const seen = new Set();
        const deduped = [];
        for (const c of allTermMatches) {
          if (!seen.has(c.name)) {
            seen.add(c.name);
            deduped.push(c);
          }
        }
        matched.push({ obj, matchedColumns: deduped, score });
      }
    }
    return matched;
  }

  function render() {
    const terms = parseQueryTerms(state.query);
    els.clearBtn.classList.toggle("hidden", state.query.length === 0);

    const allMatched = computeMatches(allObjects, terms, state.exact);
    const totalTables = allMatched.filter((m) => m.obj.type === "TABLE").length;
    const totalViews = allMatched.filter((m) => m.obj.type === "VIEW").length;

    els.countAll.textContent = allMatched.length;
    els.countTable.textContent = totalTables;
    els.countView.textContent = totalViews;

    let filtered = allMatched;
    if (state.typeFilter !== "ALL") {
      filtered = allMatched.filter((m) => m.obj.type === state.typeFilter);
    }

    // Sort
    filtered.sort((a, b) => {
      if (state.sort === "name") {
        return a.obj.name.localeCompare(b.obj.name);
      }
      if (state.sort === "type") {
        if (a.obj.type !== b.obj.type) return a.obj.type === "TABLE" ? -1 : 1;
        return a.obj.name.localeCompare(b.obj.name);
      }
      if (state.sort === "views-first") {
        if (a.obj.type !== b.obj.type) return a.obj.type === "VIEW" ? -1 : 1;
        return a.obj.name.localeCompare(b.obj.name);
      }
      if (state.sort === "columns") {
        return b.obj.columns.length - a.obj.columns.length || a.obj.name.localeCompare(b.obj.name);
      }
      // relevance
      if (b.score !== a.score) return b.score - a.score;
      if (b.matchedColumns.length !== a.matchedColumns.length) {
        return b.matchedColumns.length - a.matchedColumns.length;
      }
      if (a.obj.type !== b.obj.type) return a.obj.type === "TABLE" ? -1 : 1;
      return a.obj.name.localeCompare(b.obj.name);
    });

    currentMatches = filtered;

    // Show Expand/Collapse All button only when there are active search results
    const hasExpandable = terms.length > 0 && filtered.length > 0;
    els.toggleAllBtn.classList.toggle("hidden", !hasExpandable);
    if (hasExpandable) {
      const allExpanded = filtered.every((m) => expandedCards.has(m.obj.name));
      els.toggleAllBtn.textContent = allExpanded ? "Collapse All" : "Expand All";
    }

    // Summary text
    const shownTables = filtered.filter((m) => m.obj.type === "TABLE").length;
    const shownViews = filtered.filter((m) => m.obj.type === "VIEW").length;
    if (terms.length === 0) {
      els.resultsSummary.innerHTML = `Showing all <strong>${filtered.length}</strong> objects (${shownTables} tables, ${shownViews} views) — type a column name above to search`;
    } else {
      const termDisplay = terms.map((t) => `<code>${escapeHtml(t)}</code>`).join(" + ");
      els.resultsSummary.innerHTML = `Found <strong>${filtered.length}</strong> ${filtered.length === 1 ? "object" : "objects"} (${shownTables} ${shownTables === 1 ? "table" : "tables"}, ${shownViews} ${shownViews === 1 ? "view" : "views"}) containing ${termDisplay}`;
    }

    if (filtered.length === 0) {
      els.resultsList.innerHTML = `
        <div class="empty-state">
          <h3>No matching tables or views</h3>
          <p>No Supply Chain Collaboration ${state.typeFilter === "ALL" ? "tables or views" : state.typeFilter.toLowerCase() + "s"} contain ${terms.map((t) => `<code>${escapeHtml(t)}</code>`).join(" and ")}${state.exact ? " (exact match)" : ""}.</p>
        </div>
      `;
      return;
    }

    const html = filtered
      .map(({ obj, matchedColumns }) => {
        const badgeCls = obj.type === "TABLE" ? "badge-table" : "badge-view";
        const pkSet = new Set(obj.primaryKey || []);
        const pkHtml =
          obj.primaryKey && obj.primaryKey.length
            ? `<span>PK: ${obj.primaryKey.map((k) => `<code>${escapeHtml(k)}</code>`).join(", ")}</span>`
            : "";

        const hasMatches = matchedColumns.length > 0;
        const isExpanded = hasMatches && expandedCards.has(obj.name);

        let matchedTableHtml = "";
        if (hasMatches) {
          const rowsHtml = matchedColumns
            .map((col) => {
              const isPk = pkSet.has(col.name);
              return `
                <tr>
                  <td class="col-name-cell">
                    ${highlightTerms(col.name, terms)}
                    ${isPk ? '<span class="badge badge-pk">PK</span>' : ""}
                  </td>
                  <td class="col-type-cell">${escapeHtml(formatDatatype(col))}</td>
                  <td>${col.notNull ? '<span class="badge badge-nn">NOT NULL</span>' : "—"}</td>
                  <td class="col-comment-cell">${escapeHtml(col.comments || (obj.type === "VIEW" ? "View column" : "—"))}</td>
                </tr>
              `;
            })
            .join("");

          matchedTableHtml = `
            <div class="matched-cols-wrap${isExpanded ? "" : " hidden"}">
              <table class="cols-table">
                <thead>
                  <tr>
                    <th>Matched Column</th>
                    <th>Datatype</th>
                    <th>Nullable</th>
                    <th>Comments</th>
                  </tr>
                </thead>
                <tbody>${rowsHtml}</tbody>
              </table>
            </div>
          `;
        }

        const matchBadgeHtml = hasMatches
          ? `<span class="badge badge-match">${matchedColumns.length} ${matchedColumns.length === 1 ? "match" : "matches"}</span>`
          : "";

        return `
          <article class="card${isExpanded ? " expanded" : ""}" data-card-name="${escapeHtml(obj.name)}">
            <div class="card-header${hasMatches ? " expandable" : ""}" ${hasMatches ? `data-toggle-card="${escapeHtml(obj.name)}"` : ""}>
              <div class="card-title-block">
                <div class="card-title-row">
                  ${hasMatches ? '<span class="chevron" aria-hidden="true">&#9656;</span>' : ""}
                  <span class="badge ${badgeCls}">${obj.type}</span>
                  <span class="obj-name">${escapeHtml(obj.name)}</span>
                  ${matchBadgeHtml}
                </div>
                ${obj.description ? `<p class="card-desc">${escapeHtml(obj.description)}</p>` : ""}
                <div class="card-meta-row">
                  <span>${obj.columns.length} columns</span>
                  <span>Schema: <code>${escapeHtml(obj.schema)}</code></span>
                  <span>Owner: <code>${escapeHtml(obj.owner)}</code></span>
                  ${pkHtml}
                </div>
              </div>
              <div class="card-actions">
                <button class="link-btn" data-copy-name="${escapeHtml(obj.name)}" title="Copy name">Copy</button>
                <button class="link-btn" data-inspect="${escapeHtml(obj.name)}">All ${obj.columns.length} cols</button>
                <a class="link-btn" href="${escapeHtml(obj.url)}" target="_blank" rel="noopener">Oracle Docs ↗</a>
              </div>
            </div>
            ${matchedTableHtml}
          </article>
        `;
      })
      .join("");

    els.resultsList.innerHTML = html;
  }

  // Autocomplete for the last comma-separated token
  function renderAutocomplete() {
    const raw = els.searchInput.value;
    const parts = raw.split(",");
    const activeToken = parts[parts.length - 1].trim().toUpperCase();

    if (!activeToken) {
      els.acList.classList.add("hidden");
      acActiveIndex = -1;
      return;
    }

    const suggestions = columnIndex
      .filter((c) => c.upper.includes(activeToken))
      .sort((a, b) => {
        const aExact = a.upper === activeToken ? 2 : a.upper.startsWith(activeToken) ? 1 : 0;
        const bExact = b.upper === activeToken ? 2 : b.upper.startsWith(activeToken) ? 1 : 0;
        if (bExact !== aExact) return bExact - aExact;
        return b.count - a.count || a.name.localeCompare(b.name);
      })
      .slice(0, 12);

    if (suggestions.length === 0) {
      els.acList.classList.add("hidden");
      acActiveIndex = -1;
      return;
    }

    acActiveIndex = -1;
    els.acList.innerHTML = suggestions
      .map(
        (s, idx) => `
          <div class="autocomplete-item" role="option" data-col="${escapeHtml(s.name)}" data-idx="${idx}">
            <span class="ac-col-name">${highlightTerms(s.name, [activeToken])}</span>
            <span class="ac-count">${s.tableCount}T · ${s.viewCount}V (${s.count} total)</span>
          </div>
        `
      )
      .join("");
    els.acList.classList.remove("hidden");
  }

  function applyAutocomplete(colName) {
    const parts = els.searchInput.value.split(",");
    parts[parts.length - 1] = (parts.length > 1 ? " " : "") + colName;
    els.searchInput.value = parts.join(",");
    state.query = els.searchInput.value;
    expandedCards.clear();
    els.acList.classList.add("hidden");
    render();
    els.searchInput.focus();
  }

  // Drawer
  function openDrawer(objName) {
    const obj = allObjects.find((o) => o.name === objName);
    if (!obj) return;
    currentDrawerObj = obj;

    els.drawerBadge.textContent = obj.type;
    els.drawerBadge.className = `badge ${obj.type === "TABLE" ? "badge-table" : "badge-view"}`;
    els.drawerTitle.textContent = obj.name;
    els.drawerDesc.textContent = obj.description || "";
    els.drawerColCount.textContent = `(${obj.columns.length})`;

    const metaParts = [
      `<span>Schema: <strong>${escapeHtml(obj.schema)}</strong></span>`,
      `<span>Owner: <strong>${escapeHtml(obj.owner)}</strong></span>`,
    ];
    if (obj.tablespace) metaParts.push(`<span>Tablespace: <strong>${escapeHtml(obj.tablespace)}</strong></span>`);
    if (obj.primaryKey && obj.primaryKey.length) {
      metaParts.push(`<span>PK: <strong>${escapeHtml(obj.primaryKey.join(", "))}</strong></span>`);
    }
    metaParts.push(`<a href="${escapeHtml(obj.url)}" target="_blank" rel="noopener">Open in Oracle Docs ↗</a>`);
    els.drawerMeta.innerHTML = metaParts.join("");

    // Show/hide View SQL Query tab
    const hasQuery = Boolean(obj.query);
    els.drawerQueryTab.classList.toggle("hidden", !hasQuery);
    els.drawerQueryCode.textContent = obj.query || "";

    switchDrawerTab("columns");
    els.drawerColFilter.value = "";
    renderDrawerColumns("");

    els.drawerBackdrop.classList.remove("hidden");
    els.drawer.classList.remove("hidden");
    els.drawer.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
  }

  function closeDrawer() {
    els.drawerBackdrop.classList.add("hidden");
    els.drawer.classList.add("hidden");
    els.drawer.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    currentDrawerObj = null;
  }

  function switchDrawerTab(tabName) {
    els.drawerTabs.forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === tabName);
    });
    els.drawerColumnsPane.classList.toggle("hidden", tabName !== "columns");
    els.drawerQueryPane.classList.toggle("hidden", tabName !== "query");
  }

  function renderDrawerColumns(filterText) {
    if (!currentDrawerObj) return;
    const f = filterText.trim().toUpperCase();
    const searchTerms = parseQueryTerms(state.query);
    const hlTerms = f ? [f] : searchTerms;
    const pkSet = new Set(currentDrawerObj.primaryKey || []);

    const cols = f
      ? currentDrawerObj.columns.filter(
          (c) =>
            c.name.toUpperCase().includes(f) ||
            (c.comments && c.comments.toUpperCase().includes(f)) ||
            (c.datatype && c.datatype.toUpperCase().includes(f))
        )
      : currentDrawerObj.columns;

    if (cols.length === 0) {
      els.drawerColumnsWrap.innerHTML = `<p style="color:var(--text-faint);font-size:13px;">No columns match "${escapeHtml(filterText)}".</p>`;
      return;
    }

    const rows = cols
      .map((col, idx) => {
        const isPk = pkSet.has(col.name);
        return `
          <tr>
            <td style="color:var(--text-faint);font-size:12px;">${idx + 1}</td>
            <td class="col-name-cell">
              ${highlightTerms(col.name, hlTerms)}
              ${isPk ? '<span class="badge badge-pk">PK</span>' : ""}
            </td>
            <td class="col-type-cell">${escapeHtml(formatDatatype(col))}</td>
            <td>${col.notNull ? '<span class="badge badge-nn">NOT NULL</span>' : "—"}</td>
            <td class="col-comment-cell">${escapeHtml(col.comments || "—")}</td>
          </tr>
        `;
      })
      .join("");

    els.drawerColumnsWrap.innerHTML = `
      <table class="cols-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Column</th>
            <th>Datatype</th>
            <th>Nullable</th>
            <th>Comments</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  function exportCsv() {
    if (currentMatches.length === 0) {
      showToast("Nothing to export");
      return;
    }
    const csvEscape = (v) => `"${String(v || "").replace(/"/g, '""')}"`;
    const lines = [["Object Name", "Type", "Column Name", "Datatype", "Not Null", "Comments", "Oracle Docs URL"].map(csvEscape).join(",")];

    for (const { obj, matchedColumns } of currentMatches) {
      const cols = matchedColumns.length > 0 ? matchedColumns : [{ name: "", datatype: "", length: "", precision: "", notNull: false, comments: "" }];
      for (const col of cols) {
        lines.push(
          [
            obj.name,
            obj.type,
            col.name,
            formatDatatype(col),
            col.notNull ? "Yes" : "",
            col.comments,
            obj.url,
          ]
            .map(csvEscape)
            .join(",")
        );
      }
    }

    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const slug = state.query ? state.query.replace(/[^a-zA-Z0-9_-]+/g, "_").toLowerCase() : "all";
    a.download = `scc_columns_${slug}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`Exported ${lines.length - 1} rows to CSV`);
  }

  function bindEvents() {
    els.searchInput.addEventListener("input", () => {
      state.query = els.searchInput.value;
      expandedCards.clear();
      renderAutocomplete();
      render();
    });

    els.searchInput.addEventListener("keydown", (e) => {
      const items = Array.from(els.acList.querySelectorAll(".autocomplete-item"));
      const isOpen = !els.acList.classList.contains("hidden") && items.length > 0;

      if (e.key === "ArrowDown" && isOpen) {
        e.preventDefault();
        acActiveIndex = (acActiveIndex + 1) % items.length;
        items.forEach((el, i) => el.classList.toggle("active", i === acActiveIndex));
        items[acActiveIndex].scrollIntoView({ block: "nearest" });
      } else if (e.key === "ArrowUp" && isOpen) {
        e.preventDefault();
        acActiveIndex = (acActiveIndex - 1 + items.length) % items.length;
        items.forEach((el, i) => el.classList.toggle("active", i === acActiveIndex));
        items[acActiveIndex].scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter" && isOpen && acActiveIndex >= 0) {
        e.preventDefault();
        applyAutocomplete(items[acActiveIndex].dataset.col);
      } else if (e.key === "Escape") {
        if (isOpen) {
          els.acList.classList.add("hidden");
        } else if (state.query) {
          els.searchInput.value = "";
          state.query = "";
          expandedCards.clear();
          render();
        }
      }
    });

    els.acList.addEventListener("mousedown", (e) => {
      const item = e.target.closest(".autocomplete-item");
      if (item) {
        e.preventDefault();
        applyAutocomplete(item.dataset.col);
      }
    });

    document.addEventListener("click", (e) => {
      if (!e.target.closest(".search-box-wrap")) {
        els.acList.classList.add("hidden");
      }
    });

    els.clearBtn.addEventListener("click", () => {
      els.searchInput.value = "";
      state.query = "";
      expandedCards.clear();
      els.acList.classList.add("hidden");
      render();
      els.searchInput.focus();
    });

    els.segBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        state.typeFilter = btn.dataset.type;
        els.segBtns.forEach((b) => b.classList.toggle("active", b === btn));
        render();
      });
    });

    els.exactToggle.addEventListener("change", () => {
      state.exact = els.exactToggle.checked;
      render();
    });

    els.sortSelect.addEventListener("change", () => {
      state.sort = els.sortSelect.value;
      render();
    });

    els.quickChips.addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      els.searchInput.value = chip.dataset.col;
      state.query = chip.dataset.col;
      expandedCards.clear();
      els.acList.classList.add("hidden");
      render();
    });

    els.resultsList.addEventListener("click", (e) => {
      const copyBtn = e.target.closest("[data-copy-name]");
      if (copyBtn) {
        navigator.clipboard.writeText(copyBtn.dataset.copyName).then(() => {
          showToast(`Copied ${copyBtn.dataset.copyName}`);
        });
        return;
      }
      const inspectBtn = e.target.closest("[data-inspect]");
      if (inspectBtn) {
        openDrawer(inspectBtn.dataset.inspect);
        return;
      }
      if (e.target.closest(".card-actions")) return;
      const toggleHeader = e.target.closest("[data-toggle-card]");
      if (toggleHeader) {
        const name = toggleHeader.dataset.toggleCard;
        if (expandedCards.has(name)) {
          expandedCards.delete(name);
        } else {
          expandedCards.add(name);
        }
        render();
      }
    });

    els.toggleAllBtn.addEventListener("click", () => {
      if (currentMatches.length === 0) return;
      const allExpanded = currentMatches.every((m) => expandedCards.has(m.obj.name));
      if (allExpanded) {
        expandedCards.clear();
      } else {
        currentMatches.forEach((m) => expandedCards.add(m.obj.name));
      }
      render();
    });

    els.copyNamesBtn.addEventListener("click", () => {
      if (currentMatches.length === 0) {
        showToast("No names to copy");
        return;
      }
      const text = currentMatches.map((m) => m.obj.name).join("\n");
      navigator.clipboard.writeText(text).then(() => {
        showToast(`Copied ${currentMatches.length} object names`);
      });
    });

    els.exportCsvBtn.addEventListener("click", exportCsv);

    // Drawer events
    els.drawerClose.addEventListener("click", closeDrawer);
    els.drawerBackdrop.addEventListener("click", closeDrawer);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && currentDrawerObj) closeDrawer();
    });

    els.drawerTabs.forEach((btn) => {
      btn.addEventListener("click", () => switchDrawerTab(btn.dataset.tab));
    });

    els.drawerColFilter.addEventListener("input", () => {
      renderDrawerColumns(els.drawerColFilter.value);
    });

    els.copyQueryBtn.addEventListener("click", () => {
      if (!currentDrawerObj || !currentDrawerObj.query) return;
      navigator.clipboard.writeText(currentDrawerObj.query).then(() => {
        showToast("Copied SQL query");
      });
    });
  }

  function init() {
    schemaData = window.SCC_SCHEMA;
    if (!schemaData || !Array.isArray(schemaData.objects)) {
      els.resultsSummary.textContent = "Error: Could not load data/scc_schema.js. Run python3 scrape_scc.py first.";
      return;
    }

    allObjects = schemaData.objects;
    columnIndex = buildColumnIndex(allObjects);

    els.metaRelease.textContent = schemaData.meta.release || "26D";
    if (schemaData.meta.sourceUrl) els.metaSource.href = schemaData.meta.sourceUrl;
    els.statTables.textContent = schemaData.meta.tableCount;
    els.statViews.textContent = schemaData.meta.viewCount;
    els.statColumns.textContent = schemaData.meta.uniqueColumnCount;

    // Render quick chips
    const colSet = new Set(columnIndex.map((c) => c.name));
    const chips = QUICK_COLUMNS.filter((c) => colSet.has(c));
    els.quickChips.innerHTML = chips
      .map((c) => `<button class="chip" data-col="${escapeHtml(c)}">${escapeHtml(c)}</button>`)
      .join("");

    bindEvents();
    render();
    els.searchInput.focus();
  }

  init();
})();
