// Chrome Speed Doctor — Watchdog (v1.11.0 "Watchdog")
// Runs passively while you work. On every tab open / close / navigation it measures how long
// Chrome takes to answer an API call (a proxy for a busy/hung browser process) plus system CPU
// and free RAM right after. Hang-like events are attributed to the extensions that were active
// on that tab (host-permission match) and combined with a static risk score from permissions.

const WD = { running: false, pending: 0, tabUrls: {} };
const WD_LAG_MS = 300;     // API round-trip above this = browser was busy
const WD_CPU_PCT = 75;     // system CPU above this right after the event = spike
const WD_MAX_EVENTS = 150;

function wdEnabled() {
  return chrome.storage.local.get('wd_enabled').then(r => !!r.wd_enabled).catch(() => false);
}

async function wdEnsureTabUrls() {
  if (Object.keys(WD.tabUrls).length) return;
  try { (await getTabs()).forEach(t => { WD.tabUrls[t.id] = t.url || ''; }); } catch (e) {}
}

function wdMatchPattern(pattern, url) {
  if (!url) return false;
  if (pattern === '<all_urls>') return /^(https?|file|ftp):/.test(url);
  const m = pattern.match(/^(\*|https?|file|ftp):\/\/([^/]*)(\/.*)$/);
  if (!m) return false;
  let u; try { u = new URL(url); } catch (e) { return false; }
  const scheme = u.protocol.slice(0, -1);
  if (m[1] === '*' ? !/^https?$/.test(scheme) : m[1] !== scheme) return false;
  let host = m[2];
  if (host !== '*') {
    if (host.startsWith('*.')) { const base = host.slice(2); if (u.hostname !== base && !u.hostname.endsWith('.' + base)) return false; }
    else if (u.hostname !== host) return false;
  }
  const esc = m[3].replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + esc + '$').test(u.pathname + u.search);
}

function wdStaticRisk(item) {
  const p = new Set(item.permissions || []);
  const hosts = item.hostPermissions || [];
  let s = 0; const why = [];
  const add = (n, w) => { s += n; why.push(w); };
  if (p.has('webRequest') || p.has('webRequestBlocking')) add(4, 'webRequest');
  if (p.has('webNavigation')) add(3, 'webNavigation');
  if (p.has('tabs')) add(2, 'tabs');
  if (p.has('declarativeNetRequest') || p.has('declarativeNetRequestWithHostAccess')) add(1, 'DNR');
  if (p.has('history') || p.has('sessions') || p.has('tabGroups')) add(1, 'history/sessions');
  if (p.has('scripting') || p.has('activeTab')) add(1, 'scripting');
  if (hosts.some(h => h === '<all_urls>' || /^\*:\/\/\*\/\*$/.test(h) || /^https?:\/\/\*\/\*$/.test(h))) add(3, 'all sites');
  if (item.type === 'extension' && item.installType === 'development') add(0, 'dev');
  return { score: s, why };
}

async function wdRecord(kind, tabId, url) {
  if (!(await wdEnabled())) return;
  if (WD.running) { WD.pending++; return; }
  WD.running = true;
  try {
    const t0 = performance.now();
    await withTimeout(getTabs(), 5000, 'tabs.query').catch(() => null);
    const lagMs = Math.round(performance.now() - t0);
    const mem0 = await getMemory();
    const c1 = await getCPUSample();
    await sleep(1200);
    const c2 = await getCPUSample();
    const mem1 = await getMemory();
    const cpu = computeCPUUsage(c1, c2)?.usagePercent ?? null;
    const items = await getAllItems();
    const active = items.filter(i => i.enabled && i.type !== 'theme' &&
      (i.hostPermissions || []).some(h => wdMatchPattern(h, url))).map(i => i.id);
    const hang = lagMs > WD_LAG_MS || (cpu != null && cpu > WD_CPU_PCT);
    let host = ''; try { host = new URL(url).hostname; } catch (e) { host = (url || '').slice(0, 30); }
    const ev = {
      t: Date.now(), kind, host, lagMs, cpu, hang,
      freeMB: mem1 ? Math.round(mem1.availableCapacity / 1048576) : null,
      freeDeltaMB: (mem0 && mem1) ? Math.round((mem1.availableCapacity - mem0.availableCapacity) / 1048576) : null,
      coalesced: WD.pending, active,
    };
    WD.pending = 0;
    const { wd_events = [] } = await chrome.storage.local.get('wd_events');
    wd_events.push(ev);
    await chrome.storage.local.set({ wd_events: wd_events.slice(-WD_MAX_EVENTS) });
  } catch (e) {
    console.log('[Watchdog]', e && e.message);
  } finally { WD.running = false; }
}

// Tab events — must be registered at top level so the worker wakes for them
chrome.tabs.onCreated.addListener(tab => { WD.tabUrls[tab.id] = tab.url || tab.pendingUrl || ''; wdRecord('open', tab.id, WD.tabUrls[tab.id]); });
chrome.tabs.onUpdated.addListener((id, info, tab) => {
  if (info.url) WD.tabUrls[id] = info.url;
  if (info.status === 'loading' && info.url) wdRecord('navigate', id, info.url);
});
chrome.tabs.onRemoved.addListener(async id => {
  await wdEnsureTabUrls();
  const url = WD.tabUrls[id] || '';
  delete WD.tabUrls[id];
  wdRecord('close', id, url);
});

async function wdGetReport() {
  const { wd_enabled = false, wd_events = [] } = await chrome.storage.local.get(['wd_enabled', 'wd_events']);
  const items = await getAllItems();
  const hangs = wd_events.filter(e => e.hang);
  const suspects = items.filter(i => i.enabled && i.type !== 'theme').map(i => {
    const risk = wdStaticRisk(i);
    const involved = wd_events.filter(e => e.active.includes(i.id));
    const involvedHangs = involved.filter(e => e.hang);
    const rate = involved.length ? involvedHangs.length / involved.length : 0;
    // Evidence beats static risk: hang share on tabs this extension touches, weighted by sample size
    const evidence = Math.round(rate * Math.min(involved.length, 10) * 3 * 10) / 10;
    return {
      id: i.id, name: i.name, icons: i.icons, type: i.type,
      riskScore: risk.score, riskWhy: risk.why,
      eventsSeen: involved.length, hangsSeen: involvedHangs.length,
      evidence, score: Math.round((risk.score + evidence) * 10) / 10,
    };
  }).sort((a, b) => b.score - a.score);
  return { enabled: wd_enabled, events: wd_events.slice(-60).reverse(), total: wd_events.length, hangs: hangs.length, suspects };
}
