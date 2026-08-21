function text(value) {
  return String(value ?? "").trim();
}

function pageTargets(targets = []) {
  return targets.filter(target => target?.type === "page");
}

export function browserInstanceFromEndpoint({ port, version = {}, targets = [], windowByTarget = {}, index = 1 } = {}) {
  const pages = pageTargets(targets);
  const browserName = /edg(e)?/i.test(text(version.Browser)) ? "Edge" : "浏览器";
  const browserLabel = `${browserName} 浏览器 ${index}`;
  const orderedPages = [...pages].sort((left, right) => {
    const leftIndex = Number.isInteger(left.tabStripIndex) ? left.tabStripIndex : pages.indexOf(left);
    const rightIndex = Number.isInteger(right.tabStripIndex) ? right.tabStripIndex : pages.indexOf(right);
    return leftIndex - rightIndex;
  });
  const tabsByWindow = new Map();
  orderedPages.forEach((page, position) => {
    const rawWindowId = windowByTarget[page.id] ?? page.windowId ?? "window-1";
    const windowId = text(rawWindowId) || "window-1";
    if (!tabsByWindow.has(windowId)) tabsByWindow.set(windowId, []);
    tabsByWindow.get(windowId).push({
      tab_strip_index: Number.isInteger(page.tabStripIndex) ? page.tabStripIndex : position,
      active: Boolean(page.tabActive || page.active),
      pinned: Boolean(page.tabPinned || page.pinned),
      title: text(page.title) || "未命名标签页",
      url: text(page.url),
      target_id: text(page.id),
      type: page.type,
    });
  });
  const windows = [...tabsByWindow.entries()].map(([windowId, tabs], windowIndex) => ({
    window_id: windowId,
    window: `窗口 ${windowIndex + 1}`,
    tab_count: tabs.length,
    tabs: sortTabs(tabs).map((tab, tabIndex) => ({ ...tab, tab_index: tabIndex + 1 })),
  }));
  return {
    browser_instance: browserLabel,
    browser_name: browserName,
    port,
    debugging: true,
    window_count: windows.length || 1,
    tab_count: pages.length,
    windows: windows.length ? windows : [{ window_id: "window-1", window: "窗口 1", tab_count: 0, tabs: [] }],
  };
}

export function undebuggableBrowserInstance({ index = 1, userDataDir = "", processId = "" } = {}) {
  return {
    browser_instance: `Edge 浏览器 ${index}`,
    browser_name: "Edge",
    port: null,
    debugging: false,
    user_data_dir: text(userDataDir),
    process_id: text(processId),
    window_count: null,
    tab_count: null,
    windows: [],
    unavailable_reason: "Edge 已打开，但尚未允许网页调试连接",
  };
}

export function sortTabs(tabs = []) {
  return [...tabs].sort((left, right) => {
    const leftIndex = Number.isInteger(left.tab_strip_index) ? left.tab_strip_index : left.tab_index;
    const rightIndex = Number.isInteger(right.tab_strip_index) ? right.tab_strip_index : right.tab_index;
    return leftIndex - rightIndex;
  });
}

export function publicBrowserChoices(instances = []) {
  return instances.map(instance => ({
    browser_instance: instance.browser_instance,
    browser_name: instance.browser_name,
    debugging: Boolean(instance.debugging),
    unavailable_reason: instance.unavailable_reason || null,
    window_count: instance.window_count,
    tab_count: instance.tab_count,
    windows: instance.windows.map(window => ({
      window: window.window,
      tab_count: window.tab_count,
      tabs: sortTabs(window.tabs).map(tab => ({
        tab_index: tab.tab_index,
        active: tab.active,
        pinned: tab.pinned,
        title: tab.title,
        url: tab.url,
      })),
    })),
  }));
}

export function discoveryText(instances = []) {
  if (!instances.length) {
    return "没有发现可连接的 Edge 浏览器。请在 Edge 中允许网页调试连接，或启动一个专用浏览器后重新扫描。";
  }
  const lines = [`发现 ${instances.length} 个可连接的浏览器：`];
  for (const instance of instances) {
    if (!instance.debugging) {
      lines.push(`${instance.browser_instance} · 已打开，但尚未允许网页连接`);
      continue;
    }
    lines.push(`${instance.browser_instance} · ${instance.window_count} 个窗口 · ${instance.tab_count} 个标签页`);
    for (const window of instance.windows) {
      lines.push(`  ${window.window}`);
      for (const tab of sortTabs(window.tabs)) {
        const active = tab.active ? " · 当前" : "";
        lines.push(`    ${tab.tab_index} · ${tab.title}${active}`);
      }
    }
  }
  return lines.join("\n");
}

export function selectTab(instance, selector = "") {
  const tabs = sortTabs(instance?.windows?.flatMap(window => window.tabs) || []);
  return selectTabFromTabs(tabs, selector);
}

export function selectWindow(instance, selector = "") {
  const windows = [...(instance?.windows || [])];
  const wanted = text(selector);
  if (!wanted) {
    if (windows.length === 1) return windows[0];
    const error = new Error("more than one browser window is available; choose a window by number or name");
    error.code = "BROWSER_WINDOW_SELECTION_REQUIRED";
    error.windows = windows.map(window => ({ window: window.window, tab_count: window.tab_count }));
    throw error;
  }
  const numeric = /^\d+$/.test(wanted) ? Number(wanted) : null;
  const matches = numeric
    ? windows.filter((_, index) => index + 1 === numeric || windows[index].window === `窗口 ${numeric}`)
    : windows.filter(window => window.window === wanted || window.window.toLowerCase() === wanted.toLowerCase());
  if (matches.length > 1) {
    const error = new Error(`browser window selector is ambiguous: ${wanted}`);
    error.code = "BROWSER_WINDOW_AMBIGUOUS";
    throw error;
  }
  if (!matches[0]) {
    const error = new Error(`browser window was not found: ${wanted}`);
    error.code = "BROWSER_WINDOW_NOT_FOUND";
    error.windows = windows.map(window => ({ window: window.window, tab_count: window.tab_count }));
    throw error;
  }
  return matches[0];
}

export function selectTabInWindow(instance, windowSelector = "", tabSelector = "") {
  const window = selectWindow(instance, windowSelector);
  return selectTabFromTabs(sortTabs(window.tabs || []), tabSelector);
}

function selectTabFromTabs(tabs, selector = "") {
  const wanted = text(selector);
  if (!wanted) {
    if (tabs.length === 1) return tabs[0];
    const error = new Error("more than one tab is available; choose a tab by number or title");
    error.code = "BROWSER_TAB_SELECTION_REQUIRED";
    error.tabs = tabs.map(tab => ({ tab_index: tab.tab_index, title: tab.title, url: tab.url }));
    throw error;
  }
  const numeric = /^\d+$/.test(wanted) ? Number(wanted) : null;
  const matches = numeric
    ? tabs.filter(tab => tab.tab_index === numeric)
    : tabs.filter(tab => tab.title === wanted || tab.url === wanted);
  if (matches.length > 1) {
    const error = new Error(`browser tab selector is ambiguous: ${wanted}`);
    error.code = "BROWSER_TAB_AMBIGUOUS";
    throw error;
  }
  if (!matches[0]) {
    const error = new Error(`browser tab was not found: ${wanted}`);
    error.code = "BROWSER_TAB_NOT_FOUND";
    throw error;
  }
  return matches[0];
}
