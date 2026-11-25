// Chrome Speed Doctor — background service worker
importScripts('watchdog.js');

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_DATA') {
    gatherData().then(sendResponse).catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (msg.type === 'TOGGLE_ITEM') {
    toggleItem(msg.id, msg.enable).then(sendResponse).catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (msg.type === 'WD_GET') { wdGetReport().then(sendResponse).catch(err => sendResponse({ error: err.message })); return true; }
  if (msg.type === 'WD_SET') { chrome.storage.local.set({ wd_enabled: !!msg.enabled }).then(() => sendResponse({ ok: true })); return true; }
  if (msg.type === 'WD_CLEAR') { chrome.storage.local.remove('wd_events').then(() => sendResponse({ ok: true })); return true; }
  if (msg.type === 'GET_TARGETS_DEBUG') {
    // Returns raw target list for diagnosing live monitor issues
    const self = chrome.runtime.id;
    getDebugTargets().then(targets => {
      const extTargets = targets.filter(t => getTargetExtId(t) && getTargetExtId(t) !== self);
      sendResponse({
        total: targets.length,
        extTargets: extTargets.map(t => ({
          id: t.id, type: t.type, attached: t.attached,
          url: (t.url || '').slice(0, 100), extId: getTargetExtId(t)
        })),
        filtered: Object.keys(buildExtTargetMap(targets, self)).length,
      });
    });
    return true;
  }
});

chrome.runtime.onConnect.addListener(port => {
  if (port.name === 'stress-test') {
    runStressTest(port).catch(err => {
      try { port.postMessage({ type: 'error', error: err.message }); } catch(e) {}
    });
  } else if (port.name === 'deep-scan') {
    runDeepScan(port).catch(err => {
      try { port.postMessage({ type: 'error', error: err.message }); } catch(e) {}
    });
  } else if (port.name === 'live-monitor') {
    runLiveMonitor(port).catch(err => {
      try { port.postMessage({ type: 'error', error: err.message }); } catch(e) {}
    });
  }
});

// ─── Toggle ───────────────────────────────────────────────────────────────────
async function toggleItem(id, enable) {
  return new Promise((resolve, reject) => {
    chrome.management.setEnabled(id, enable, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve({ ok: true });
    });
  });
}

// ─── Main scan ────────────────────────────────────────────────────────────────
async function gatherData() {
  const [allItems, tabs, memory, cpu1] = await Promise.all([getAllItems(), getTabs(), getMemory(), getCPUSample()]);
  await sleep(800);
  const cpu2 = await getCPUSample();
  const cpuUsage = computeCPUUsage(cpu1, cpu2);
  const tabMemory = await measureTabMemory(tabs);
  return { allItems, tabs, memory, cpuUsage, tabMemory };
}

function getAllItems() {
  return new Promise(resolve => {
    const self = chrome.runtime.id;
    chrome.management.getAll(items => resolve((items||[]).filter(i => i.id !== self && i.type !== 'theme')));
  });
}
function getTabs()      { return new Promise(r => chrome.tabs.query({}, t => r(t||[]))); }
function getMemory()    { return new Promise(r => chrome.system?.memory ? chrome.system.memory.getInfo(r) : r(null)); }
function getCPUSample() { return new Promise(r => chrome.system?.cpu    ? chrome.system.cpu.getInfo(r)    : r(null)); }
function sleep(ms)      { return new Promise(r => setTimeout(r, ms)); }

function computeCPUUsage(s1, s2) {
  if (!s1 || !s2) return null;
  let idle = 0, busy = 0;
  for (let i = 0; i < s1.processors.length; i++) {
    const p1 = s1.processors[i].usage, p2 = s2.processors[i].usage;
    idle += p2.idle - p1.idle;
    busy += (p2.total - p1.total) - (p2.idle - p1.idle);
  }
  const total = idle + busy;
  return { usagePercent: total > 0 ? Math.round((busy/total)*100) : 0,
    numProcessors: s1.processors.length, archName: s1.archName, modelName: s1.modelName };
}

async function measureTabMemory(tabs) {
  const results = {};
  const ok = tabs.filter(t => t.url && !t.url.startsWith('chrome://') &&
    !t.url.startsWith('chrome-extension://') && !t.url.startsWith('about:') && !t.discarded);
  for (let i = 0; i < ok.length; i += 10) {
    await Promise.all(ok.slice(i, i+10).map(async tab => {
      try {
        const res = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => performance.memory ? {
            usedJSHeapSize: performance.memory.usedJSHeapSize,
            totalJSHeapSize: performance.memory.totalJSHeapSize,
            jsHeapSizeLimit: performance.memory.jsHeapSizeLimit
          } : null
        });
        if (res?.[0]?.result) results[tab.id] = res[0].result;
      } catch(e) {}
    }));
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CDP HELPERS — real CPU time per process via Performance.getMetrics
// ═══════════════════════════════════════════════════════════════════════════════

function withTimeout(p, ms, label = 'op') {
  let t;
  return Promise.race([
    p,
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(label + ' timed out')), ms); })
  ]).finally(() => clearTimeout(t));
}

function cdpSend(target, method, params = {}, timeoutMs = 3000) {
  return withTimeout(new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params, result => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(result);
    });
  }), timeoutMs, method);
}

function cdpAttach(target) {
  return withTimeout(new Promise((resolve, reject) => {
    chrome.debugger.attach(target, '1.3', () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  }), 3000, 'attach');
}

// Safe detach — never throws, silently ignores "not attached" errors
function cdpDetach(target) {
  return new Promise(resolve => {
    chrome.debugger.detach(target, () => {
      void chrome.runtime.lastError; // consume to prevent unchecked error log
      resolve();
    });
  });
}

function getDebugTargets() {
  return withTimeout(new Promise(resolve => chrome.debugger.getTargets(t => resolve(t || []))), 3000, 'getTargets').catch(() => []);
}

// Check if a target belongs to a specific extension ID
// Handles: background pages, popups, options pages, service workers
function getTargetExtId(t) {
  // Service workers: type='service_worker', url is the SW script
  if (t.url && t.url.startsWith('chrome-extension://')) {
    const m = t.url.match(/^chrome-extension:\/\/([a-z]{32})\//);
    if (m) return m[1];
  }
  return null;
}

// Returns true if target is safe for us to attach to
function isAttachable(t) {
  if (!t.url) return false;
  if (t.url.startsWith('chrome://')) return false;
  if (t.url.startsWith('about:')) return false;
  if (t.url.startsWith('devtools://')) return false;
  // NOTE: do NOT check t.attached — Chrome marks SW targets as attached internally,
  // but extensions can still attach their own debugger session simultaneously
  return true;
}

// Build extId -> best target map (prefer service_worker, then background_page, then any)
function buildExtTargetMap(allTargets, selfId) {
  const map = {}; // extId -> [targets]
  for (const t of allTargets) {
    if (!isAttachable(t)) continue;
    const extId = getTargetExtId(t);
    if (!extId || extId === selfId) continue;
    if (!map[extId]) map[extId] = [];
    map[extId].push(t);
  }
  // Sort each extension's targets: service_worker first, then background_page, then others
  for (const extId of Object.keys(map)) {
    map[extId].sort((a, b) => {
      const rank = t => t.type === 'service_worker' ? 0 : t.type === 'background_page' ? 1 : 2;
      return rank(a) - rank(b);
    });
  }
  return map;
}

// isAttachableExtTarget kept for stress test compatibility
function isAttachableExtTarget(t, extId) {
  if (!t.url) return false;
  const m = t.url.match(/^chrome-extension:\/\/([a-z]{32})\//);
  return m && m[1] === extId && !t.attached;
}

// Snapshot ProcessCPUTime + TaskDuration + ScriptDuration for a tab target
async function snapshotCPU(tabId) {
  const target = { tabId };
  let attached = false;
  try {
    await cdpAttach(target);
    attached = true;
    await cdpSend(target, 'Performance.enable', { timeDomain: 'threadTicks' });
    const { metrics } = await cdpSend(target, 'Performance.getMetrics');
    await cdpDetach(target);
    const map = {};
    metrics.forEach(m => { map[m.name] = m.value; });
    return map;
  } catch(e) {
    if (attached) await cdpDetach(target);
    return null;
  }
}

// Snapshot an extension background page by targetId
async function snapshotExtCPU(targetId) {
  const target = { targetId };
  let attached = false;
  try {
    await cdpAttach(target);
    attached = true;
    await cdpSend(target, 'Performance.enable', { timeDomain: 'threadTicks' });
    const { metrics } = await cdpSend(target, 'Performance.getMetrics');
    await cdpDetach(target);
    const map = {};
    metrics.forEach(m => { map[m.name] = m.value; });
    return map;
  } catch(e) {
    if (attached) await cdpDetach(target);
    return null;
  }
}

// Try snapshotting the first valid target for an extension
async function snapshotExtById(extId, selfId) {
  const allTargets = await getDebugTargets();
  const targets = allTargets.filter(t => isAttachableExtTarget(t, extId));
  for (const t of targets) {
    const snap = await snapshotExtCPU(t.id);
    if (snap) return snap;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STRESS TEST
// ═══════════════════════════════════════════════════════════════════════════════
async function runStressTest(port) {
  const TOTAL = 20;
  const samples = [];
  let testTab = null;
  const send = m => { try { port.postMessage(m); } catch(e) {} };

  const allItems   = await getAllItems();
  const enabledItems = allItems.filter(i => i.enabled);
  const self = chrome.runtime.id;

  send({ type: 'start', total: TOTAL });
  send({ type: 'phase', phase: 'baseline', label: '⏱ Baseline — sampling extension CPU…' });

  // ── Discover extension targets, filtering to only safe ones ──────────────
  const allTargets = await getDebugTargets();
  const extTargetMap = buildExtTargetMap(allTargets, self);

  const extCPUData = {};

  // ── Baseline CPU snapshot for all extension processes ────────────────────
  await Promise.all(enabledItems.map(async item => {
    extCPUData[item.id] = {
      name: item.name, icons: item.icons, type: item.type, id: item.id,
      permissions: item.permissions||[], hostPermissions: item.hostPermissions||[],
      snap1: null, snap2: null
    };
    // Only try targets that genuinely belong to this extension
    const targets = (extTargetMap[item.id] || []).filter(t => isAttachableExtTarget(t, item.id));
    for (const t of targets) {
      const snap = await snapshotExtCPU(t.id);
      if (snap) { extCPUData[item.id].snap1 = snap; break; }
    }
  }));

  // ── Also snapshot test tab targets (we'll create it at t=5) ──────────────
  let tabCPUSnap1 = null;
  let tabCPUSnap2 = null;
  let prevSysCpu  = await getCPUSample();

  const extContentScripts = {}; // extId -> { ms, count, bytes }

  for (let t = 0; t <= TOTAL; t++) {

    // ── Phase: open tab ──
    if (t === 5) {
      send({ type: 'phase', phase: 'tab_open', label: '📂 Opening new tab…' });
      testTab = await new Promise(r => chrome.tabs.create({ url: 'chrome://newtab', active: false }, r));
      await sleep(500);
    }

    // ── Phase: navigate ──
    if (t === 10) {
      send({ type: 'phase', phase: 'navigating', label: '🌐 Loading google.com — measuring per-process CPU…' });
      if (testTab) {
        // Snapshot tab CPU BEFORE navigation
        tabCPUSnap1 = await snapshotCPU(testTab.id);

        await new Promise(r => chrome.tabs.update(testTab.id, { url: 'https://www.google.com' }, r));
        await waitForTabLoad(testTab.id, 5000);
        await sleep(800);

        // Snapshot tab CPU AFTER navigation
        tabCPUSnap2 = await snapshotCPU(testTab.id);

        // Collect content script injection data from page
        const pageMetrics = await measurePageMetrics(testTab.id);
        if (pageMetrics) {
          for (const script of (pageMetrics.injectedScripts||[])) {
            const extId = extractExtensionId(script.name);
            if (extId) {
              if (!extContentScripts[extId]) extContentScripts[extId] = { ms: 0, count: 0, bytes: 0 };
              extContentScripts[extId].ms    += script.duration;
              extContentScripts[extId].count += 1;
              extContentScripts[extId].bytes += script.transferSize || 0;
            }
          }
          // store page-level metrics
          extCPUData['__page__'] = pageMetrics;
        }
      }
    }

    // ── Phase: close tab + final extension snapshots ──
    if (t === 15) {
      send({ type: 'phase', phase: 'cooling', label: '🔍 Final extension CPU snapshots…' });

      // Re-discover targets fresh — the ones from t=0 may be stale/gone
      const freshTargets = await getDebugTargets();
      const freshExtTargetMap = buildExtTargetMap(freshTargets, self);

      await Promise.all(enabledItems.map(async item => {
        const targets = (freshExtTargetMap[item.id] || []).filter(t => isAttachableExtTarget(t, item.id));
        for (const tgt of targets) {
          const snap = await snapshotExtCPU(tgt.id);
          if (snap) { extCPUData[item.id].snap2 = snap; break; }
        }
      }));

      send({ type: 'phase', phase: 'cooling', label: '❌ Closing tab — cooling down…' });
      if (testTab) {
        await new Promise(r => chrome.tabs.remove(testTab.id, r));
        testTab = null;
      }
    }

    // ── Sample system metrics each second ──
    const [currSysCpu, memory] = await Promise.all([getCPUSample(), getMemory()]);
    const cpuDelta = computeCPUUsage(prevSysCpu, currSysCpu);
    prevSysCpu = currSysCpu;

    let testTabHeap = null;
    if (testTab) {
      try {
        const res = await chrome.scripting.executeScript({
          target: { tabId: testTab.id },
          func: () => performance.memory ? { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize } : null
        });
        testTabHeap = res?.[0]?.result || null;
      } catch(e) {}
    }

    const sample = {
      t,
      cpu: cpuDelta?.usagePercent ?? null,
      memUsedPct: memory ? Math.round((1 - memory.availableCapacity/memory.capacity)*100) : null,
      testTabHeap,
      phase: t < 5 ? 'baseline' : t < 10 ? 'tab_open' : t < 15 ? 'navigating' : 'cooling'
    };
    samples.push(sample);
    send({ type: 'sample', sample, progress: Math.round((t/TOTAL)*100) });
    if (t < TOTAL) await sleep(1000);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Build per-extension results with REAL CPU data
  // ═════════════════════════════════════════════════════════════════════════
  const avg = arr => arr.length ? Math.round(arr.reduce((a,b)=>a+b,0)/arr.length) : null;
  const max = arr => arr.length ? Math.round(Math.max(...arr)) : null;

  const bsl  = samples.filter(s=>s.phase==='baseline'  && s.cpu!==null).map(s=>s.cpu);
  const nav  = samples.filter(s=>s.phase==='navigating'&& s.cpu!==null).map(s=>s.cpu);
  const cld  = samples.filter(s=>s.phase==='cooling'   && s.cpu!==null).map(s=>s.cpu);
  const all  = samples.filter(s=>s.cpu!==null).map(s=>s.cpu);
  const memS = samples.filter(s=>s.memUsedPct!==null);

  // Tab-level CDP: compute ScriptDuration delta (ms of JS execution in test tab)
  let tabScriptMs   = null;
  let tabTaskMs     = null;
  let tabCPUTimeMs  = null;
  if (tabCPUSnap1 && tabCPUSnap2) {
    // CDP timeDomain=threadTicks gives values in ms
    tabScriptMs  = Math.round(((tabCPUSnap2.ScriptDuration  || 0) - (tabCPUSnap1.ScriptDuration  || 0)) * 1000);
    tabTaskMs    = Math.round(((tabCPUSnap2.TaskDuration    || 0) - (tabCPUSnap1.TaskDuration    || 0)) * 1000);
    tabCPUTimeMs = Math.round(((tabCPUSnap2.ProcessCPUTime  || 0) - (tabCPUSnap1.ProcessCPUTime  || 0)) * 1000);
  }

  const itemResults = enabledItems.map(item => {
    const d = extCPUData[item.id] || {};
    const cs = extContentScripts[item.id] || { ms: 0, count: 0, bytes: 0 };
    const perms = [...(item.permissions||[]), ...(item.hostPermissions||[])];

    // ── Real CPU delta from CDP Performance metrics ──
    let bgTaskMs     = null; // ms of task execution in background process
    let bgScriptMs   = null; // ms of JS execution in background process
    let bgCPUTimeMs  = null; // total process CPU time
    let hasCDPData   = false;

    if (d.snap1 && d.snap2) {
      hasCDPData  = true;
      bgTaskMs    = Math.round(((d.snap2.TaskDuration   ||0) - (d.snap1.TaskDuration   ||0)) * 1000);
      bgScriptMs  = Math.round(((d.snap2.ScriptDuration ||0) - (d.snap1.ScriptDuration ||0)) * 1000);
      bgCPUTimeMs = Math.round(((d.snap2.ProcessCPUTime ||0) - (d.snap1.ProcessCPUTime ||0)) * 1000);
    }

    // ── Permission baseline score ──
    let permScore = perms.length * 2;
    if (perms.includes('webRequest')||perms.includes('webRequestBlocking')) permScore += 30;
    if (perms.includes('<all_urls>')) permScore += 25;
    if (perms.includes('background'))  permScore += 15;
    if (perms.includes('tabs'))        permScore += 8;
    if (perms.includes('nativeMessaging')) permScore += 12;
    if (perms.includes('history'))     permScore += 6;
    if (perms.includes('cookies'))     permScore += 6;
    if (item.type !== 'extension')     permScore += 10;

    // ── Measured impact score from real data ──
    let measuredScore = 0;
    if (hasCDPData) {
      measuredScore += Math.min((bgCPUTimeMs||0) / 10, 50);  // CPU time: 10ms = 1pt, up to 50
      measuredScore += Math.min((bgTaskMs||0)    / 5,  30);  // task time: 5ms = 1pt, up to 30
      measuredScore += Math.min((bgScriptMs||0)  / 5,  20);  // script time: 5ms = 1pt, up to 20
    }
    measuredScore += Math.min(cs.ms * 0.5, 30);       // content script exec
    measuredScore += cs.count * 8;                     // injected script count

    const totalScore = Math.round(permScore + measuredScore);

    return {
      id: item.id, name: item.name, icons: item.icons, type: item.type,
      perms, permScore, measuredScore: Math.round(measuredScore), totalScore,
      // CDP real data
      hasCDPData,
      bgCPUTimeMs, bgTaskMs, bgScriptMs,
      // Content script data
      contentScriptMs:    cs.ms,
      contentScriptCount: cs.count,
      contentScriptBytes: cs.bytes,
      hasMeasuredData: hasCDPData || cs.count > 0,
    };
  }).sort((a, b) => b.totalScore - a.totalScore);

  send({ type: 'done', result: {
    samples, itemResults,
    pageMetrics:   extCPUData['__page__'] || null,
    tabScriptMs, tabTaskMs, tabCPUTimeMs,
    cpuBaseline:  avg(bsl), cpuPeak: max(all),
    cpuNavigate:  avg(nav), cpuCooldown: avg(cld),
    memStart:  memS[0]?.memUsedPct,
    memPeak:   memS.reduce((b,s)=>s.memUsedPct>(b?.memUsedPct||0)?s:b, null)?.memUsedPct,
  }});
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
async function getTabHeap(tabId) {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => performance.memory ? { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize } : null
    });
    return res?.[0]?.result || null;
  } catch(e) { return null; }
}

async function measurePageMetrics(tabId) {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const nav = performance.getEntriesByType('navigation')[0];
        const loadTime = nav ? Math.round(nav.loadEventEnd - nav.startTime) : null;
        const resources = performance.getEntriesByType('resource');
        const injectedScripts = resources
          .filter(r => r.name.startsWith('chrome-extension://'))
          .map(r => ({ name: r.name, duration: Math.round(r.duration), transferSize: r.transferSize||0, initiatorType: r.initiatorType }));
        return { loadTime, injectedScripts, resourceCount: resources.length };
      }
    });
    const m = res?.[0]?.result;
    if (!m) return null;
    // Measure fetch RTT separately
    const fr = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const t0 = performance.now();
        return fetch('https://www.gstatic.com/generate_204', { cache:'no-store', mode:'no-cors' })
          .then(() => Math.round(performance.now()-t0)).catch(() => null);
      }
    });
    return { ...m, fetchMs: fr?.[0]?.result || null };
  } catch(e) { return null; }
}

function extractExtensionId(url) {
  const m = url.match(/^chrome-extension:\/\/([a-z]{32})\//);
  return m ? m[1] : null;
}

async function waitForTabLoad(tabId, timeoutMs) {
  const start = Date.now();
  return new Promise(resolve => {
    const check = () => {
      if (Date.now()-start > timeoutMs) { resolve(); return; }
      chrome.tabs.get(tabId, tab => {
        if (chrome.runtime.lastError || !tab) { resolve(); return; }
        if (tab.status === 'complete') { resolve(); return; }
        setTimeout(check, 300);
      });
    };
    setTimeout(check, 500);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEEP SCAN — 4-phase differential measurement per extension
//
// For each extension:
//   Phase A (Idle)    — system RAM with extension on, no test tab
//   Phase B (Loading) — CDP CPU% during page load + heap at load end + load time
//   Phase C (Active)  — heap after settle (RAM during active use)
//   Phase D (Closed)  — system RAM 2s after tab close (memory retained/leaked)
//
// Each phase run TWICE: once with extension ON, once with it OFF.
// Delta = ON minus OFF = true cost of that extension for that phase.
// ═══════════════════════════════════════════════════════════════════════════════
async function runDeepScan(port) {
  const send = m => { try { port.postMessage(m); } catch(e) {} };

  // Receive config from popup (testUrl sent with 'start_scan' message)
  // We wait for it via port first message
  let testUrl = 'https://tvnet.lv';
  let cancelled = false;
  port.onDisconnect.addListener(() => { cancelled = true; });
  port.onMessage.addListener(m => { if (m && m.type === 'cancel') cancelled = true; });
  const msgPromise = new Promise(resolve => {
    const handler = msg => { if (msg.type === 'config') { testUrl = msg.testUrl || testUrl; resolve(); } };
    port.onMessage.addListener(handler);
    // Timeout fallback — start anyway after 2s if no config received
    setTimeout(resolve, 2000);
  });
  await msgPromise;

  const LOAD_WAIT   = 8000; // max wait for page load
  const SETTLE_MS   = 1500; // wait after load for scripts to settle
  const CPU_SAMPLE  = 2500; // ms to hold CDP open and sample CPU during load
  const POST_CLOSE  = 2000; // ms to wait after tab close before measuring retained RAM

  const allItems = await getAllItems();
  const targets  = allItems.filter(i => i.enabled && i.type !== 'theme');

  if (!targets.length) {
    send({ type: 'done', result: { items: [], testUrl, error: 'No enabled extensions found.' } });
    return;
  }

  send({ type: 'start', total: targets.length, testUrl });

  // ── Helpers ──────────────────────────────────────────────────────────────

  async function getSystemRAMFree() {
    return new Promise(r => chrome.system?.memory
      ? chrome.system.memory.getInfo(info => r(info ? info.availableCapacity : null))
      : r(null));
  }

  async function measurePhases(withLabel) {
    // Phase A: idle RAM (no test tab)
    const ramBefore = await getSystemRAMFree();

    // Phase B+C: open tab, load URL, measure during load and after settle
    const tab = await new Promise(r => chrome.tabs.create({ url: testUrl, active: false }, r));

    // Start CDP snapshot for CPU during load
    let cpuDuringLoad = null;
    const cdpTarget = { tabId: tab.id };
    let cdpAttached = false;
    try {
      await cdpAttach(cdpTarget);
      cdpAttached = true;
      await cdpSend(cdpTarget, 'Performance.enable', { timeDomain: 'threadTicks' });
    } catch(e) { cdpAttached = false; }

    const cpuSnap1 = cdpAttached ? await (async () => {
      try {
        const { metrics } = await cdpSend(cdpTarget, 'Performance.getMetrics');
        const m = {}; metrics.forEach(x => m[x.name] = x.value); return m;
      } catch(e) { return null; }
    })() : null;

    const loadStart = Date.now();
    await waitForTabLoad(tab.id, LOAD_WAIT);
    const loadTimeMs = Date.now() - loadStart;
    await sleep(SETTLE_MS);

    // Phase B: CPU during load (CDP delta)
    const cpuSnap2 = cdpAttached ? await (async () => {
      try {
        const { metrics } = await cdpSend(cdpTarget, 'Performance.getMetrics');
        const m = {}; metrics.forEach(x => m[x.name] = x.value); return m;
      } catch(e) { return null; }
    })() : null;
    if (cdpAttached) await cdpDetach(cdpTarget);

    let cpuPct = null;
    if (cpuSnap1 && cpuSnap2) {
      const elapsed = Math.max(loadTimeMs + SETTLE_MS, 1000);
      const cpuMs = ((cpuSnap2.ProcessCPUTime || 0) - (cpuSnap1.ProcessCPUTime || 0)) * 1000;
      cpuPct = Math.min(100, Math.max(0, Math.round((cpuMs / elapsed) * 100)));
    }

    // Phase B: heap at end of load + injected scripts
    const loadSnap = await (async () => {
      try {
        const res = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const nav = performance.getEntriesByType('navigation')[0];
            const resources = performance.getEntriesByType('resource');
            return {
              heap: performance.memory ? performance.memory.usedJSHeapSize : null,
              loadTime: nav ? Math.round(nav.loadEventEnd - nav.startTime) : null,
              scriptCount: resources.filter(r => r.name.startsWith('chrome-extension://')).length,
              scriptMs: Math.round(resources.filter(r => r.name.startsWith('chrome-extension://')).reduce((s,r) => s + r.duration, 0)),
            };
          }
        });
        return res?.[0]?.result || {};
      } catch(e) { return {}; }
    })();

    // Phase C: heap after settle (active use RAM)
    await sleep(SETTLE_MS);
    const activeHeap = await (async () => {
      try {
        const res = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => performance.memory ? performance.memory.usedJSHeapSize : null
        });
        return res?.[0]?.result ?? null;
      } catch(e) { return null; }
    })();

    // Phase D: close tab and measure retained RAM
    await new Promise(r => chrome.tabs.remove(tab.id, r));
    await sleep(POST_CLOSE);
    const ramAfter = await getSystemRAMFree();

    return {
      label:        withLabel,
      // Phase A
      ramIdleBytes: ramBefore,
      // Phase B
      loadTimeMs:   loadSnap.loadTime || loadTimeMs,
      heapAtLoadBytes: loadSnap.heap ?? null,
      cpuDuringLoadPct: cpuPct,
      scriptCount:  loadSnap.scriptCount ?? 0,
      scriptMs:     loadSnap.scriptMs ?? 0,
      // Phase C
      heapActiveBytes: activeHeap,
      // Phase D
      ramAfterBytes: ramAfter,
      ramRetainedBytes: (ramBefore != null && ramAfter != null) ? ramBefore - ramAfter : null,
    };
  }

  // ── Run per-extension ─────────────────────────────────────────────────────
  const results = [];

  try {
  for (let i = 0; i < targets.length; i++) {
    if (cancelled) break;
    const item = targets[i];
    const pct  = Math.round(((i + 1) / targets.length) * 100);

    // Phase: measure WITH extension enabled
    send({ type: 'status', progress: pct,
      text: `🟢 "${item.name}" (${i+1}/${targets.length}) — measuring WITH extension…` });
    const withExt = await measurePhases('with');

    if (cancelled) break;
    // Disable extension (recorded so it is restored even if the worker dies)
    await chrome.storage.local.set({ ds_disabled_id: item.id });
    await new Promise(r => chrome.management.setEnabled(item.id, false, () => { void chrome.runtime.lastError; r(); }));
    await sleep(400);

    // Phase: measure WITHOUT extension
    send({ type: 'status', progress: pct,
      text: `⭕ "${item.name}" (${i+1}/${targets.length}) — measuring WITHOUT extension…` });
    const withoutExt = await measurePhases('without');

    // Re-enable
    await new Promise(r => chrome.management.setEnabled(item.id, true, () => { void chrome.runtime.lastError; r(); }));
    await chrome.storage.local.remove('ds_disabled_id');
    await sleep(300);

    // ── Compute deltas per phase category ──────────────────────────────────
    const d = (a, b) => (a != null && b != null) ? a - b : null;
    const dMB = (a, b) => { const v = d(a, b); return v != null ? Math.round(v / 1024 / 1024 * 10) / 10 : null; };

    const result = {
      id: item.id, name: item.name, icons: item.icons, type: item.type,
      permissions: item.permissions||[], hostPermissions: item.hostPermissions||[],

      // ── Raw with/without ──
      with: withExt,
      without: withoutExt,

      // ── Phase A: Idle impact ──
      // How much system RAM is used just by having the extension enabled (no tab open)
      idleRamDeltaMB: dMB(withoutExt.ramIdleBytes, withExt.ramIdleBytes), // positive = ext uses RAM at idle

      // ── Phase B: Load impact ──
      // Cost DURING page loading
      loadTimeDeltaMs:   d(withExt.loadTimeMs, withoutExt.loadTimeMs),       // +ms = ext slows load
      loadHeapDeltaMB:   dMB(withExt.heapAtLoadBytes, withoutExt.heapAtLoadBytes), // +MB = ext adds heap at load
      loadCpuDeltaPct:   d(withExt.cpuDuringLoadPct, withoutExt.cpuDuringLoadPct), // +% = ext uses more CPU loading
      scriptCountDelta:  d(withExt.scriptCount, withoutExt.scriptCount),     // how many scripts ext injected
      scriptMsDelta:     d(withExt.scriptMs, withoutExt.scriptMs),           // ms of script execution added

      // ── Phase C: Active impact ──
      // RAM cost while page is open and in use
      activeHeapDeltaMB: dMB(withExt.heapActiveBytes, withoutExt.heapActiveBytes), // +MB = ext uses more RAM actively

      // ── Phase D: Close impact (memory leak indicator) ──
      // How much RAM the system did NOT recover after tab closed
      retainedRamDeltaMB: dMB(withoutExt.ramRetainedBytes, withExt.ramRetainedBytes), // +MB = ext leaks RAM after close
    };

    results.push(result);
    send({ type: 'item_done', item: result, progress: pct });
  }
  } finally {
    // Safety net: never leave an extension disabled
    const { ds_disabled_id } = await chrome.storage.local.get('ds_disabled_id');
    if (ds_disabled_id) {
      await new Promise(r => chrome.management.setEnabled(ds_disabled_id, true, () => { void chrome.runtime.lastError; r(); }));
      await chrome.storage.local.remove('ds_disabled_id');
    }
  }

  // Sort by total impact score
  results.sort((a, b) => {
    const score = r => Math.abs(r.loadTimeDeltaMs||0)/100 + Math.abs(r.activeHeapDeltaMB||0)*2 + Math.abs(r.loadCpuDeltaPct||0);
    return score(b) - score(a);
  });

  send({ type: 'done', result: { items: results, testUrl, cancelled } });
}

// ═══════════════════════════════════════════════════════════════════════════════
// LIVE MONITOR — attaches CDP to all processes, polls every 2s, pushes updates
// Stays alive as long as the popup port is open. Detaches everything on close.
// ═══════════════════════════════════════════════════════════════════════════════
async function runLiveMonitor(port) {
  const POLL_MS = 2000;
  const ATTACH_TIMEOUT_MS = 3000; // give up on any single target after 3s
  const self = chrome.runtime.id;
  const send = m => { try { port.postMessage(m); } catch(e) {} };

  const sessions = new Map(); // key -> { target, prevSnap, label, kind, meta }
  let alive = true;
  let pollTimer = null;
  let tickCount = 0;
  let prevSysCpu = null;

  port.onDisconnect.addListener(() => {
    alive = false;
    if (pollTimer) clearTimeout(pollTimer);
    for (const [, s] of sessions) cdpDetach(s.target);
    sessions.clear();
  });

  // ── Attach one target ─────────────────────────────────────────────────────
  async function attachOne(key, target, label, kind, meta = {}) {
    if (sessions.has(key) || !alive) return;
    let attached = false;
    try {
      await cdpAttach(target);
      attached = true;
      let snap = null, useRuntime = false;
      try {
        await cdpSend(target, 'Performance.enable', { timeDomain: 'threadTicks' });
        const { metrics } = await cdpSend(target, 'Performance.getMetrics');
        snap = {};
        metrics.forEach(m => { snap[m.name] = m.value; });
        console.log(`[Live] ✓ "${label}" — Performance domain OK`);
      } catch(e) {
        useRuntime = true;
        snap = { _t: Date.now() };
        try { await cdpSend(target, 'Runtime.enable'); } catch(e2) {}
        console.log(`[Live] ~ "${label}" — Runtime fallback (${e.message})`);
      }
      sessions.set(key, { target, prevSnap: snap, label, kind, useRuntime, ...meta });
    } catch(e) {
      console.log(`[Live] ✗ "${label}" — attach failed: ${e.message}`);
      if (attached) await cdpDetach(target);
    }
  }

  // ── Discover and attach ───────────────────────────────────────────────────
  async function discoverAndAttach() {
    if (!alive) return;
    const [allTargets, allItems, tabs] = await Promise.all([
      getDebugTargets(), getAllItems(), getTabs()
    ]);
    const self2 = chrome.runtime.id;
    const itemMap = Object.fromEntries(allItems.map(i => [i.id, i]));

    // Map ext targets — only background_page types work; SW types are blocked by Chrome
    const extTargets = {};
    for (const t of allTargets) {
      if (!t.url?.startsWith('chrome-extension://')) continue;
      const m = t.url.match(/^chrome-extension:\/\/([a-z]{32})\//);
      if (!m || m[1] === self2) continue;
      if (!extTargets[m[1]]) extTargets[m[1]] = [];
      extTargets[m[1]].push(t);
    }

    // Count target types for logging
    const allExtT = Object.values(extTargets).flat();
    console.log(`[Live] ${allTargets.length} targets, ${allExtT.length} from extensions`);
    allExtT.forEach(t => console.log(`  ${t.type} attached=${t.attached} url=${(t.url||'').slice(0,70)}`));

    const work = [];

    // Only try HTML background pages (type !== service_worker) — SW attach is blocked by Chrome
    for (const [extId, targets] of Object.entries(extTargets)) {
      const item = itemMap[extId];
      if (!item?.enabled) continue;
      const key = 'ext:' + extId;
      if (sessions.has(key)) continue;
      const bgPage = targets.find(t => t.type === 'background_page' || t.type === 'page');
      if (bgPage) {
        work.push(attachOne(key, { targetId: bgPage.id }, item.name, 'ext',
          { extId, icons: item.icons, type: item.type, targetType: bgPage.type, isMV2: true }));
      }
      // service_worker targets: skip — Chrome blocks external attach
    }

    // Tabs — always works
    for (const tab of tabs) {
      if (!tab.url || tab.url.startsWith('chrome://') ||
          tab.url.startsWith('chrome-extension://') ||
          tab.url.startsWith('about:') || tab.discarded) continue;
      const key = 'tab:' + tab.id;
      if (sessions.has(key)) continue;
      let label = tab.title || tab.url;
      try { label = new URL(tab.url).hostname.replace('www.', '') || label; } catch(e) {}
      work.push(attachOne(key, { tabId: tab.id }, label, 'tab',
        { tabId: tab.id, favIcon: tab.favIconUrl }));
    }

    await Promise.allSettled(work);
    console.log(`[Live] ${sessions.size} sessions active`);
  }

  // ── Poll one session ──────────────────────────────────────────────────────
  async function pollSession(key, s) {
    try {
      let cpuPct = null;
      let heapMB = null;

      if (s.useRuntime) {
        // Service worker fallback: use Runtime.evaluate to get heap
        // CPU isn't measurable this way — show null
        try {
          const result = await cdpSend(s.target, 'Runtime.evaluate', {
            expression: `(function(){ try { return performance.memory ? performance.memory.usedJSHeapSize : -1; } catch(e){ return -1; } })()`,
            returnByValue: true,
          });
          const val = result?.result?.value;
          if (val != null && val >= 0) heapMB = Math.round(val / 1024 / 1024 * 10) / 10;
        } catch(e) {}
        cpuPct = null; // can't measure CPU without Performance domain on SW
      } else {
        // Full Performance.getMetrics path
        const { metrics } = await cdpSend(s.target, 'Performance.getMetrics');
        const snap = {};
        metrics.forEach(m => { snap[m.name] = m.value; });
        const cpuDeltaMs = ((snap.ProcessCPUTime || 0) - (s.prevSnap.ProcessCPUTime || 0)) * 1000;
        cpuPct = Math.min(100, Math.max(0, Math.round((cpuDeltaMs / POLL_MS) * 100)));
        heapMB = snap.JSHeapUsedSize != null ? Math.round(snap.JSHeapUsedSize / 1024 / 1024 * 10) / 10 : null;
        s.prevSnap = snap;
      }

      return {
        key, label: s.label, kind: s.kind, extId: s.extId, tabId: s.tabId,
        icons: s.icons, type: s.type, favIcon: s.favIcon,
        targetType: s.targetType, cpuPct, heapMB,
        swFallback: s.useRuntime,
      };
    } catch(e) {
      await cdpDetach(s.target);
      sessions.delete(key);
      return null;
    }
  }

  // ── Main poll loop ────────────────────────────────────────────────────────
  async function poll() {
    if (!alive) return;
    tickCount++;
    try {

    // Re-discover new tabs/extensions every 5 ticks (10s), non-blocking
    if (tickCount % 5 === 0) discoverAndAttach().catch(() => {});

    // Poll all sessions in parallel
    const results = (await Promise.allSettled(
      [...sessions.entries()].map(([key, s]) => pollSession(key, s))
    )).map(r => r.status === 'fulfilled' ? r.value : null).filter(Boolean);

    // For extensions with NO CDP session (no bg page / service worker idle),
    // still include them in the list so user sees they exist — just no live data
    const allItems = await getAllItems();
    const sessionExtIds = new Set(
      [...sessions.keys()].filter(k => k.startsWith('ext:')).map(k => k.slice(4))
    );
    // Extensions with no active session — split into MV2 (failed attach) vs MV3 SW (blocked by Chrome)
    const allExtTargets = await getDebugTargets().then(ts => {
      const self2 = chrome.runtime.id;
      const map = {};
      for (const t of ts) {
        if (!t.url?.startsWith('chrome-extension://')) continue;
        const m = t.url.match(/^chrome-extension:\/\/([a-z]{32})\//);
        if (!m || m[1] === self2) continue;
        map[m[1]] = map[m[1]] || [];
        map[m[1]].push(t.type);
      }
      return map;
    });

    const noSessionExts = allItems
      .filter(i => i.enabled && i.type !== 'theme' && !sessionExtIds.has(i.id))
      .map(i => {
        const targetTypes = allExtTargets[i.id] || [];
        const isMV3SW = targetTypes.includes('service_worker') && !targetTypes.includes('background_page');
        const hasNoTarget = targetTypes.length === 0;
        return {
          key: 'ext:' + i.id, label: i.name, kind: 'ext',
          extId: i.id, icons: i.icons, type: i.type,
          cpuPct: null, heapMB: null,
          noTarget: true,
          isMV3SW,  // Chrome blocks attach to these
          hasNoTarget, // SW is sleeping — no target visible at all
        };
      });

    const allResults = [...results, ...noSessionExts];

    const cpu1 = await getCPUSample();
    await sleep(100);
    const cpu2 = await getCPUSample();
    const sysCpu = computeCPUUsage(cpu1, cpu2);
    const mem = await getMemory();

    send({
      type: 'tick',
      processes: allResults,
      sysCpu:       sysCpu?.usagePercent ?? null,
      sysMemPct:    mem ? Math.round((1 - mem.availableCapacity / mem.capacity) * 100) : null,
      sysMemFreeMB: mem ? Math.round(mem.availableCapacity / 1024 / 1024) : null,
      sessionCount: sessions.size,
    });

    } catch (err) {
      console.log('[Live] poll error:', err && err.message);
      send({ type: 'tick', processes: [], sysCpu: null, sysMemPct: null, sysMemFreeMB: null, sessionCount: sessions.size, error: String(err && err.message) });
    } finally {
      if (alive) pollTimer = setTimeout(poll, POLL_MS);
    }
  }

  // ── Start: send ready immediately, attach in background, start polling ────
  send({ type: 'ready', count: 0 });

  // Fire off discovery without awaiting — first tick will have whatever attached fast
  discoverAndAttach().catch(e => console.log('[Live] discover error:', e && e.message)).then(() => {
    if (alive) send({ type: 'attached', count: sessions.size });
  });

  // Start polling immediately after a short head start (500ms)
  pollTimer = setTimeout(poll, 500);
}


// Recovery: if the worker died mid Deep Scan, re-enable the extension it had disabled.
(async () => {
  try {
    const { ds_disabled_id } = await chrome.storage.local.get('ds_disabled_id');
    if (ds_disabled_id) {
      chrome.management.setEnabled(ds_disabled_id, true, () => { void chrome.runtime.lastError; });
      await chrome.storage.local.remove('ds_disabled_id');
    }
  } catch (e) {}
})();
