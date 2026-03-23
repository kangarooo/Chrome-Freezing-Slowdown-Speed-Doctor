// popup.js - Chrome Speed Doctor

// ─── State ────────────────────────────────────────────────────────────────────
let cachedData = null;
let cachedStressResult = null;
let searchQuery = '';
let profiles = {};       // { id: { name, items:[{id,name,enabled,icons,type}], savedAt } }
let activeProfileId = null;

// ─── Profile storage (chrome.storage.local — survives browser restarts) ───────
function saveProfiles() {
  try { chrome.storage.local.set({ profiles, activeProfileId }); } catch(e) {}
}
function loadProfiles(cb) {
  try { chrome.storage.local.get(['profiles','activeProfileId'], r => {
    profiles = r.profiles || {};
    activeProfileId = r.activeProfileId || null;
    cb();
  }); } catch(e) { cb(); }
}

function saveProfile(name) {
  if (!cachedData || !name.trim()) return false;
  const id = 'p_' + Date.now();
  profiles[id] = {
    name: name.trim(),
    items: cachedData.allItems.filter(i=>i.type!=='theme')
      .map(i=>({ id:i.id, name:i.name, enabled:i.enabled, icons:i.icons, type:i.type })),
    savedAt: Date.now()
  };
  activeProfileId = id;
  saveProfiles();
  renderProfiles();
  return true;
}

async function applyProfile(profileId) {
  const p = profiles[profileId];
  if (!p) return;
  const btn = document.querySelector(`.btn-apply-profile[data-pid="${profileId}"]`);
  if (btn) { btn.textContent = '⏳…'; btn.disabled = true; }
  await Promise.all(p.items.map(pi => new Promise(res =>
    chrome.management.setEnabled(pi.id, pi.enabled, res)
  )));
  if (cachedData) cachedData.allItems.forEach(item => {
    const pi = p.items.find(x => x.id === item.id);
    if (pi) item.enabled = pi.enabled;
  });
  activeProfileId = profileId;
  saveProfiles();
  if (cachedData) { renderAll(cachedData); renderProfiles(); }
}

function deleteProfile(pid) {
  delete profiles[pid];
  if (activeProfileId === pid) activeProfileId = null;
  saveProfiles();
  renderProfiles();
}

function toggleProfileItem(pid, iid) {
  const p = profiles[pid]; if (!p) return;
  const item = p.items.find(i => i.id === iid); if (!item) return;
  item.enabled = !item.enabled;
  saveProfiles();
  const tog = document.querySelector(`.profile-ext-toggle[data-pid="${pid}"][data-iid="${iid}"]`);
  if (tog) {
    tog.className = `profile-ext-toggle ${item.enabled?'on':'off'}`;
    const st = tog.previousElementSibling;
    if (st) { st.textContent = item.enabled?'ON':'OFF'; st.className=`profile-ext-status ${item.enabled?'on':'off'}`; }
  }
}

// ─── Render Profiles panel ────────────────────────────────────────────────────
function renderProfiles() {
  const panel = document.getElementById('panel-profiles');
  if (!panel) return;

  const pids = Object.keys(profiles).sort((a,b) => profiles[b].savedAt - profiles[a].savedAt);

  let html = `
  <div class="profiles-toolbar">
    <input type="text" class="profile-name-input" id="profileNameInput" placeholder="Profile name (e.g. Work, Gaming…)" maxlength="40">
    <button class="btn-save-profile" id="btnSaveProfile">💾 Save Current</button>
  </div>`;

  if (pids.length === 0) {
    html += `<div class="empty-state" style="padding:24px 0"><div class="icon">💾</div><p>No profiles yet.<br>Type a name above and click <strong>Save Current</strong><br>to snapshot which extensions are enabled.</p></div>`;
  } else {
    html += `<div class="profiles-list">`;
    pids.forEach(pid => {
      const p = profiles[pid];
      const isActive = activeProfileId === pid;
      const enabledCount = p.items.filter(i=>i.enabled).length;
      const date = new Date(p.savedAt).toLocaleDateString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});

      html += `
      <div class="profile-card ${isActive?'active-profile':''}" data-pid="${pid}">
        <div class="profile-card-header">
          <span class="profile-chevron" id="chev-${pid}">▶</span>
          <span class="profile-card-name">${escHtml(p.name)}</span>
          ${isActive ? '<span class="profile-active-badge">ACTIVE</span>' : ''}
          <span class="profile-card-meta">${enabledCount}/${p.items.length} on · ${date}</span>
          <div class="profile-card-actions" onclick="event.stopPropagation()">
            <button class="btn-apply-profile" data-pid="${pid}">▶ Apply</button>
            <button class="btn-delete-profile" data-pid="${pid}">✕</button>
          </div>
        </div>
        <div class="profile-ext-list" id="plist-${pid}" style="display:none">`;

      p.items.forEach(item => {
        const iHtml = safeIcon(item.icons, item.type, 16);
        html += `
          <div class="profile-ext-item">
            <div class="profile-ext-icon">${iHtml}</div>
            <span class="profile-ext-name">${escHtml(item.name)}</span>
            <span class="profile-ext-status ${item.enabled?'on':'off'}">${item.enabled?'ON':'OFF'}</span>
            <button class="profile-ext-toggle ${item.enabled?'on':'off'}"
              data-pid="${pid}" data-iid="${item.id}" title="Toggle in profile"></button>
          </div>`;
      });

      html += `</div></div>`;
    });
    html += `</div>`;
  }

  panel.innerHTML = html;

  // Wire save button
  panel.querySelector('#btnSaveProfile').onclick = () => {
    const inp = panel.querySelector('#profileNameInput');
    if (saveProfile(inp.value)) inp.value = '';
    else inp.focus();
  };
  panel.querySelector('#profileNameInput').onkeydown = e => {
    if (e.key === 'Enter') panel.querySelector('#btnSaveProfile').click();
  };

  // Wire expand/collapse headers
  panel.querySelectorAll('.profile-card-header').forEach(header => {
    header.onclick = () => {
      const pid = header.closest('.profile-card').dataset.pid;
      const list = document.getElementById('plist-' + pid);
      const chev = document.getElementById('chev-' + pid);
      const open = list.style.display !== 'none';
      list.style.display = open ? 'none' : 'flex';
      chev.classList.toggle('open', !open);
    };
  });

  // Wire Apply buttons
  panel.querySelectorAll('.btn-apply-profile').forEach(btn => {
    btn.onclick = e => { e.stopPropagation(); applyProfile(btn.dataset.pid); };
  });

  // Wire Delete buttons
  panel.querySelectorAll('.btn-delete-profile').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      if (confirm(`Delete profile "${profiles[btn.dataset.pid]?.name}"?`)) deleteProfile(btn.dataset.pid);
    };
  });

  // Wire per-item toggles inside profiles
  panel.querySelectorAll('.profile-ext-toggle').forEach(tog => {
    tog.onclick = e => { e.stopPropagation(); toggleProfileItem(tog.dataset.pid, tog.dataset.iid); };
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function fmtMB(bytes) { return bytes ? (bytes/1024/1024).toFixed(0)+' MB' : '—'; }
function fmtGB(bytes) { return (bytes/1024/1024/1024).toFixed(1)+' GB'; }
function sevColor(v,w,d) { return v>=d?'danger':v>=w?'warn':'ok'; }
function sevCls(v,w,d) { return v===null||v===undefined?'info':v>=d?'danger':v>=w?'warn':'ok'; }

function scoreItem(item) {
  const perms = [...(item.permissions||[]), ...(item.hostPermissions||[])];
  let s = perms.length * 3;
  if (perms.includes('webRequest')||perms.includes('webRequestBlocking')) s+=30;
  if (perms.includes('<all_urls>')) s+=25;
  if (perms.includes('background')) s+=20;
  if (perms.includes('tabs')) s+=10;
  if (perms.includes('nativeMessaging')) s+=15;
  if (perms.includes('history')) s+=8;
  if (perms.includes('cookies')) s+=8;
  if (item.type!=='extension') s+=10;
  return s;
}

function typeIcon(type) {
  const m = { extension:'🧩', hosted_app:'🌐', packaged_app:'📦', legacy_packaged_app:'📦', platform_app:'💻' };
  return m[type]||'🔧';
}

function typeLabel(type) {
  const m = { extension:'Extension', hosted_app:'Hosted App', packaged_app:'App', legacy_packaged_app:'App', platform_app:'Platform App' };
  return m[type]||type;
}

function iconHtml(item) {
  if (item.icons?.length > 0) {
    const url = item.icons[item.icons.length - 1].url;
    return `<img src="${escHtml(url)}" width="18" height="18" style="object-fit:contain">`;
  }
  return typeIcon(item.type);
}

// Render icon from icons array at given size
function safeIcon(icons, type, size = 18) {
  if (icons?.length > 0) {
    const url = icons[icons.length - 1].url;
    return `<img src="${escHtml(url)}" width="${size}" height="${size}" style="object-fit:contain">`;
  }
  return `<span style="font-size:${Math.round(size*0.8)}px;line-height:1">${typeIcon(type)}</span>`;
}

// ─── Tab switching ────────────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.nav-tab').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
  document.getElementById('tab-'+name).classList.add('active');
  document.getElementById('panel-'+name).classList.add('active');

  if (name === 'live') {
    startLiveMonitor();
  } else {
    // Stop live monitor when switching away — removes the yellow bar
    stopLiveMonitor();
  }
}

// ─── Toggle enable/disable — updates DOM in-place, never reorders ─────────────
function toggleItem(id, currentlyEnabled) {
  const enable = !currentlyEnabled;

  // Update cached data
  if (cachedData) cachedData.allItems.forEach(i => { if (i.id===id) i.enabled=enable; });

  // Update every row for this item in-place
  document.querySelectorAll(`.ext-card[data-id="${id}"]`).forEach(card => {
    card.dataset.enabled = enable ? 'true' : 'false';
    // swap color class
    const colorCls = card.dataset.color || 'ok';
    card.classList.remove('danger','warn','ok','dim');
    card.classList.add(enable ? colorCls : 'dim');
    // status pill
    const pill = card.querySelector('.status-pill');
    if (pill) {
      pill.textContent = enable ? 'ON' : 'OFF';
      pill.className = `status-pill ${enable?'pill-on':'pill-off'}`;
    }
    // hint text
    const hint = card.querySelector('.card-hint');
    if (hint) hint.textContent = enable ? 'Click to disable' : 'Click to enable';
  });

  saveToSession();

  chrome.runtime.sendMessage({ type:'TOGGLE_ITEM', id, enable }, (res) => {
    if (res?.error) {
      // revert on error
      if (cachedData) cachedData.allItems.forEach(i => { if(i.id===id) i.enabled=currentlyEnabled; });
      document.querySelectorAll(`.ext-card[data-id="${id}"]`).forEach(card => {
        card.dataset.enabled = currentlyEnabled ? 'true' : 'false';
        const colorCls = card.dataset.color || 'ok';
        card.classList.remove('danger','warn','ok','dim');
        card.classList.add(currentlyEnabled ? colorCls : 'dim');
        const pill = card.querySelector('.status-pill');
        if (pill) { pill.textContent = currentlyEnabled?'ON':'OFF'; pill.className=`status-pill ${currentlyEnabled?'pill-on':'pill-off'}`; }
        const hint = card.querySelector('.card-hint');
        if (hint) hint.textContent = currentlyEnabled ? 'Click to disable' : 'Click to enable';
      });
    }
  });
}

// ─── Scan ─────────────────────────────────────────────────────────────────────
function runScan() {
  const btn = document.getElementById('scanBtn');
  btn.textContent = '⏳ Scanning...';
  btn.classList.add('scanning');
  ['panel-diagnosis','panel-extensions','panel-tabs','panel-perms','panel-resources'].forEach(id => {
    document.getElementById(id).innerHTML = `<div class="loading"><div class="spinner"></div><p>Analyzing…</p></div>`;
  });

  chrome.runtime.sendMessage({ type:'GET_DATA' }, (data) => {
    btn.textContent = '🔄 Rescan';
    btn.classList.remove('scanning');
    if (!data||data.error) {
      document.getElementById('panel-diagnosis').innerHTML =
        `<div class="empty-state"><div class="icon">⚠️</div><p>Scan failed: ${data?.error||'unknown'}</p></div>`;
      return;
    }
    cachedData = data;
    saveToSession();
    renderAll(data);
  });
}

function saveToSession() {
  try { chrome.storage.session.set({ cachedData, cachedStressResult }); } catch(e) {}
}
function loadFromSession(cb) {
  try { chrome.storage.session.get(['cachedData','cachedStressResult'], r => cb(r.cachedData||null, r.cachedStressResult||null)); }
  catch(e) { cb(null,null); }
}

// ─── Render all ───────────────────────────────────────────────────────────────
function renderAll(data) {
  const { allItems, tabs, memory, cpuUsage, tabMemory } = data;
  const exts = allItems.filter(i=>i.type==='extension'&&i.enabled);

  document.getElementById('tabCount').textContent = tabs.length;
  document.getElementById('extCount').textContent = allItems.filter(i=>i.enabled).length;

  if (memory) {
    const freeGB = memory.availableCapacity/1024/1024/1024;
    const usedPct = Math.round((1-freeGB/(memory.capacity/1024/1024/1024))*100);
    const el = document.getElementById('memFree');
    el.style.color = usedPct>85?'var(--danger)':usedPct>70?'var(--warn)':'var(--accent3)';
    el.textContent = freeGB.toFixed(1)+'G';
  }
  if (cpuUsage) {
    const el = document.getElementById('cpuVal');
    el.style.color = cpuUsage.usagePercent>80?'var(--danger)':cpuUsage.usagePercent>50?'var(--warn)':'var(--ok)';
    el.textContent = cpuUsage.usagePercent+'%';
  }

  renderSearch(data);
  renderDiagnosis(data);
  renderResources(data);
  renderExtensionsTab(data);
  renderTabs(data);
  renderPerms(data);
  renderProfiles();
}

// ═══════════════════════════════════════════════════════════════════════════════
// PANEL: SEARCH / DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════════
function renderSearch(data) {
  const { allItems } = data;
  const scored = allItems.filter(i => i.type !== 'theme')
    .map(item => ({ ...item, score: scoreItem(item) }));
  scored.sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return b.score - a.score;
  });

  const maxScore = Math.max(...scored.map(i=>i.score), 1);
  const panel = document.getElementById('panel-search');

  function card(item) {
    const pct   = Math.round((item.score / maxScore) * 100);
    const color = pct > 70 ? 'danger' : pct > 40 ? 'warn' : 'ok';
    const perms = [...(item.permissions||[]), ...(item.hostPermissions||[])];
    const flags = [
      perms.includes('webRequest') && '<span class="tag red">net</span>',
      perms.includes('<all_urls>')  && '<span class="tag yellow">all</span>',
      perms.includes('background') && '<span class="tag blue">bg</span>',
      item.type !== 'extension'     && `<span class="tag blue">${typeLabel(item.type)}</span>`,
    ].filter(Boolean).join('');
    const hasOptions = item.optionsUrl && item.optionsUrl !== '';
    const iconImg = safeIcon(item.icons, item.type, 20);

    return `<div class="ext-card ${item.enabled ? color : 'dim'}"
        data-id="${item.id}" data-enabled="${item.enabled}" data-color="${color}">
      <div class="ext-card-row">
        <div class="ext-card-icon">${iconImg}</div>
        <div class="ext-card-mid">
          <div class="ext-card-name-row">
            <span class="ext-card-name">${escHtml(item.name)}</span>
            <span class="ext-card-flags">${flags}</span>
          </div>
          <div class="ext-card-bar-row">
            <div class="ext-score-bar-wrap">
              <div class="ext-score-bar ${item.enabled?color:'dim-bar'}" style="width:${item.enabled?pct:0}%"></div>
            </div>
            <span class="ext-score-label">
              <span class="ext-score-num ${item.enabled?color:'muted'}">${item.score}</span>
              <span class="ext-score-pts">pts</span>
            </span>
          </div>
        </div>
        <div class="ext-card-right">
          <span class="status-pill ${item.enabled?'pill-on':'pill-off'}">${item.enabled?'ON':'OFF'}</span>
        </div>
      </div>
      <div class="ext-card-actions" onclick="event.stopPropagation()">
        <button class="card-action-btn" data-action="details" data-id="${item.id}">⚙ Details</button>
        ${hasOptions ? `<button class="card-action-btn" data-action="options" data-id="${item.id}" data-options="${escHtml(item.optionsUrl)}">🔧 Options</button>` : ''}
        <span class="card-hint" style="margin-left:auto">${item.enabled?'Click card to disable':'Click card to enable'}</span>
      </div>
    </div>`;
  }

  function buildCards(items) {
    if (!items.length) return `<div class="empty-state" style="padding:16px"><div class="icon">🔍</div><p>No matches</p></div>`;
    const en = items.filter(i=>i.enabled), dis = items.filter(i=>!i.enabled);
    let h = '';
    if (en.length)  h += `<div class="list-section-label">Enabled · by impact (${en.length})</div>${en.map(card).join('')}`;
    if (dis.length) h += `<div class="list-section-label" style="margin-top:8px">Disabled (${dis.length})</div>${dis.map(card).join('')}`;
    return h;
  }

  panel.innerHTML = `
    <div class="search-top-bar">
      <div class="search-row1">
        <input type="text" id="searchInput" class="search-input" placeholder="🔍  Search extensions &amp; apps…" value="${escHtml(searchQuery)}">
      </div>
      <div class="search-row2">
        <span class="search-meta" id="searchMeta">${scored.length} items</span>
        <span class="search-hint">👆 Click card to toggle</span>
      </div>
    </div>
    <div id="searchResults">${buildCards(scored)}</div>`;

  function wireCards(root) {
    root.querySelectorAll('.ext-card').forEach(card => {
      card.onclick = () => toggleItem(card.dataset.id, card.dataset.enabled === 'true');
    });
    root.querySelectorAll('[data-action="details"]').forEach(btn => {
      btn.onclick = e => { e.stopPropagation(); chrome.tabs.create({ url: `chrome://extensions/?id=${btn.dataset.id}` }); };
    });
    root.querySelectorAll('[data-action="options"]').forEach(btn => {
      btn.onclick = e => { e.stopPropagation(); chrome.tabs.create({ url: btn.dataset.options }); };
    });
  }

  const input = panel.querySelector('#searchInput');
  input.addEventListener('input', e => {
    searchQuery = e.target.value.toLowerCase().trim();
    const filtered = scored.filter(i =>
      i.name.toLowerCase().includes(searchQuery) || typeLabel(i.type).toLowerCase().includes(searchQuery)
    );
    panel.querySelector('#searchResults').innerHTML = buildCards(filtered);
    panel.querySelector('#searchMeta').textContent = `${filtered.length} of ${scored.length}`;
    wireCards(panel);
  });

  // update in-place without rebuilding (keeps order stable on toggle)
  // toggleItem() already handles DOM updates

  setTimeout(() => input.focus(), 50);
  wireCards(panel);
}

function wireToggleBtns(root) {
  root.querySelectorAll('.toggle-btn').forEach(btn => {
    btn.onclick = () => toggleItem(btn.dataset.id, btn.dataset.enabled === 'true');
  });
}

// For panels where items aren't .ext-card (deep scan table, perms list, etc.)
// Updates the button itself after toggling since toggleItem only updates .ext-card
function wireToggleBtnsStandalone(root) {
  root.querySelectorAll('.toggle-btn').forEach(btn => {
    btn.onclick = () => {
      const id = btn.dataset.id;
      const currentlyEnabled = btn.dataset.enabled === 'true';
      const newEnabled = !currentlyEnabled;
      // Update button immediately
      btn.dataset.enabled = String(newEnabled);
      btn.textContent = newEnabled ? 'Disable' : 'Enable';
      btn.className = `toggle-btn ${newEnabled ? 'btn-disable' : 'btn-enable'}`;
      // Update any matching .ext-card in search panel too
      toggleItem(id, currentlyEnabled);
    };
  });
}

function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ═══════════════════════════════════════════════════════════════════════════════
// DIAGNOSIS
// ═══════════════════════════════════════════════════════════════════════════════
function renderDiagnosis({ allItems, tabs, memory, cpuUsage, tabMemory }) {
  const enabled = allItems.filter(i=>i.enabled);
  const exts = enabled.filter(i=>i.type==='extension');
  const apps = enabled.filter(i=>i.type!=='extension');
  const webReq = enabled.filter(i=>(i.permissions||[]).includes('webRequest'));
  const bgItems = enabled.filter(i=>{const p=i.permissions||[];return p.includes('background')||p.includes('tabs')||p.includes('webRequest');});
  const allUrls = enabled.filter(i=>(i.permissions||[]).includes('<all_urls>')||(i.hostPermissions||[]).includes('<all_urls>'));

  let memPct = 0;
  if (memory) memPct = Math.round((1-memory.availableCapacity/memory.capacity)*100);

  const heapHogs = tabs.filter(t=>tabMemory[t.id]&&tabMemory[t.id].usedJSHeapSize>200*1024*1024)
    .sort((a,b)=>tabMemory[b.id].usedJSHeapSize-tabMemory[a.id].usedJSHeapSize).slice(0,3);

  let score=100, issues=[];

  if (cpuUsage?.usagePercent>80) { score-=25; issues.push({sev:'danger',title:`CPU critical (${cpuUsage.usagePercent}%)`,desc:'System heavily loaded — Chrome and processes competing for all cores.'}); }
  else if (cpuUsage?.usagePercent>50) { score-=12; issues.push({sev:'warn',title:`CPU elevated (${cpuUsage.usagePercent}%)`,desc:'More than half your CPU in use. Heavy web apps or background tasks may be the cause.'}); }

  if (memPct>85) { score-=20; issues.push({sev:'danger',title:`RAM critical (${memPct}% used)`,desc:'Chrome will slow dramatically. Close apps, tabs, or restart.'}); }
  else if (memPct>70) { score-=10; issues.push({sev:'warn',title:`RAM high (${memPct}% used)`,desc:'Close unused tabs and apps to free memory.'}); }

  if (heapHogs.length>0) { score-=heapHogs.length*8; issues.push({sev:'warn',title:`${heapHogs.length} tab(s) with >200MB JS heap`,desc:heapHogs.map(t=>{try{return new URL(t.url||'').hostname;}catch(e){return t.title||'Tab';}}). join(', ')}); }

  if (enabled.length>15) { score-=20; issues.push({sev:'danger',title:`Too many items enabled (${enabled.length})`,desc:`${exts.length} extensions + ${apps.length} apps. Disable ones you rarely use.`}); }
  else if (enabled.length>8) { score-=10; issues.push({sev:'warn',title:`Many items enabled (${enabled.length})`,desc:'Consider disabling extensions/apps you don\'t use daily.'}); }

  if (webReq.length>0) { score-=webReq.length*8; issues.push({sev:webReq.length>2?'danger':'warn',title:`${webReq.length} item(s) intercept network requests`,desc:webReq.map(i=>i.name).join(', ')+' — adds latency to every page load.'}); }
  if (bgItems.length>5) { score-=15; issues.push({sev:'danger',title:`${bgItems.length} items run in background`,desc:'Consuming CPU/RAM even when unused.'}); }
  else if (bgItems.length>2) { score-=8; issues.push({sev:'warn',title:`${bgItems.length} items have background access`,desc:'These run silently using resources.'}); }
  if (tabs.length>40) { score-=25; issues.push({sev:'danger',title:`Too many tabs (${tabs.length})`,desc:'Each tab is a process consuming memory.'}); }
  else if (tabs.length>20) { score-=12; issues.push({sev:'warn',title:`Many tabs open (${tabs.length})`,desc:`${tabs.filter(t=>!t.active&&!t.audible&&!t.pinned).length} could be closed.`}); }
  if (allUrls.length>0) { score-=allUrls.length*5; issues.push({sev:'warn',title:`${allUrls.length} item(s) access all websites`,desc:allUrls.map(i=>i.name).join(', ')+' — inject scripts on every page.'}); }

  const adBlockers = exts.filter(e=>/adblock|ublock|adguard|ghostery|privacy badger/i.test(e.name));
  if (adBlockers.length>1) { score-=10; issues.push({sev:'warn',title:`${adBlockers.length} ad blockers running`,desc:adBlockers.map(e=>e.name).join(', ')+' — duplicates waste resources.'}); }

  score = Math.max(0,Math.min(100,score));
  const sc = score>=75?'#00cc66':score>=50?'#ffaa00':'#ff3355';
  const sl = score>=75?'Healthy':score>=50?'Sluggish':'Critical';
  const circ = 2*Math.PI*26;
  const dash = circ-(score/100)*circ;

  let html = `<div class="score-container">
    <div class="score-ring">
      <svg width="64" height="64" viewBox="0 0 64 64">
        <circle cx="32" cy="32" r="26" fill="none" stroke="var(--border)" stroke-width="5"/>
        <circle cx="32" cy="32" r="26" fill="none" stroke="${sc}" stroke-width="5"
          stroke-dasharray="${circ}" stroke-dashoffset="${dash}" stroke-linecap="round"/>
      </svg>
      <div class="score-num" style="color:${sc}">${score}</div>
    </div>
    <div class="score-details">
      <div class="score-label" style="color:${sc}">${sl}</div>
      <div class="score-desc">${issues.length===0?'Chrome looks healthy.':'Found '+issues.length+' issue'+(issues.length>1?'s':'')+' slowing Chrome down.'}</div>
    </div>
  </div>`;

  if (issues.length===0) {
    html+=`<div class="tip-box">✅ <strong>All clear!</strong> Your setup looks lean.</div>`;
  } else {
    html+=`<div class="diagnosis-card"><div class="diagnosis-title">Issues Found</div>`;
    issues.forEach(i=>{
      const dot=i.sev==='danger'?'var(--danger)':i.sev==='warn'?'var(--warn)':'var(--ok)';
      html+=`<div class="issue-item"><div class="issue-dot" style="background:${dot}"></div><div><div class="issue-text">${i.title}</div><div class="issue-sub">${i.desc}</div></div></div>`;
    });
    html+=`</div><div class="tip-box"><strong>💡</strong> Use the <strong>Search</strong> tab to find and disable high-impact extensions &amp; apps.</div>`;
  }

  document.getElementById('panel-diagnosis').innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════════════════════
// RESOURCES
// ═══════════════════════════════════════════════════════════════════════════════
function renderResources({ memory, cpuUsage, tabs, tabMemory, allItems }) {
  let html = '';

  if (cpuUsage) {
    const p = cpuUsage.usagePercent, c = sevColor(p,50,80);
    html+=`<div class="res-card">
      <div class="res-card-header"><span class="res-card-title">🖥️ System CPU</span><span class="res-val ${c}">${p}%</span></div>
      <div class="res-bar-wrap"><div class="res-bar-fill ${c}" style="width:${p}%"></div></div>
      <div class="res-card-meta">${cpuUsage.numProcessors} cores · ${cpuUsage.modelName||'Unknown CPU'}</div>
      <div class="res-note ${p>80?'danger-note':p>50?'warn-note':'ok-note'}">${p>80?'⚠ CPU critical':p>50?'CPU elevated':'✓ CPU normal'}</div>
    </div>`;
  }

  if (memory) {
    const used=memory.capacity-memory.availableCapacity, pct=Math.round(used/memory.capacity*100), c=sevColor(pct,70,85);
    html+=`<div class="res-card">
      <div class="res-card-header"><span class="res-card-title">🧠 System RAM</span><span class="res-val ${c}">${pct}% used</span></div>
      <div class="res-bar-wrap"><div class="res-bar-fill ${c}" style="width:${pct}%"></div></div>
      <div class="res-card-meta">${fmtGB(used)} used · ${fmtGB(memory.availableCapacity)} free · ${fmtGB(memory.capacity)} total</div>
      <div class="res-note ${pct>85?'danger-note':pct>70?'warn-note':'ok-note'}">${pct>85?'⚠ RAM critically low':pct>70?'RAM running high':'✓ RAM healthy'}</div>
    </div>`;
  }

  // Tab JS Heap
  const measured = tabs.filter(t=>tabMemory[t.id]).sort((a,b)=>tabMemory[b.id].usedJSHeapSize-tabMemory[a.id].usedJSHeapSize);
  if (measured.length>0) {
    const total=measured.reduce((s,t)=>s+tabMemory[t.id].usedJSHeapSize,0);
    const maxH=tabMemory[measured[0].id].usedJSHeapSize||1;
    html+=`<div class="res-card">
      <div class="res-card-header"><span class="res-card-title">📊 JS Heap by Tab</span><span class="res-val info">${fmtMB(total)}</span></div>
      <div class="res-card-meta">${measured.length} measured · ${tabs.length-measured.length} skipped</div>
      <div class="tab-heap-list">`;
    measured.slice(0,20).forEach(tab=>{
      const u=tabMemory[tab.id].usedJSHeapSize, mb=u/1024/1024, pct=Math.round(u/maxH*100), c=sevColor(mb,100,300);
      let domain=''; try{domain=new URL(tab.url||'').hostname.replace('www.','');}catch(e){}
      html+=`<div class="heap-row">
        <div class="heap-favicon">${tab.favIconUrl?`<img src="${tab.favIconUrl}" width="12" height="12" style="object-fit:contain">`:'🌐'}</div>
        <div class="heap-info">
          <div class="heap-name">${escHtml(tab.title||domain||'Tab')}</div>
          <div class="heap-bar-wrap"><div class="heap-bar-fill ${c}" style="width:${pct}%"></div></div>
        </div>
        <div class="heap-val ${c}">${fmtMB(u)}</div>
      </div>`;
    });
    html+=`</div></div>`;
  }

  // Extension + App impact
  const enabled = allItems.filter(i=>i.enabled);
  if (enabled.length>0) {
    const scored = enabled.map(i=>({...i,score:scoreItem(i)})).sort((a,b)=>b.score-a.score);
    const maxS=scored[0].score||1;
    html+=`<div class="res-card">
      <div class="res-card-header"><span class="res-card-title">🧩 Extension &amp; App Impact</span><span class="res-card-meta" style="margin:0">${enabled.length} enabled</span></div>
      <div class="res-card-meta" style="margin-bottom:8px">Resource impact score based on permissions</div>
      <div class="tab-heap-list">`;
    scored.forEach(item=>{
      const pct=Math.round((item.score/maxS)*100), c=pct>70?'danger':pct>40?'warn':'ok';
      const perms=[...(item.permissions||[]),...(item.hostPermissions||[])];
      const flags=[perms.includes('webRequest')&&'🌐',perms.includes('<all_urls>')&&'⚠',perms.includes('background')&&'⚙',item.type!=='extension'&&typeIcon(item.type)].filter(Boolean).join(' ');
      html+=`<div class="heap-row">
        <div class="heap-favicon">${iconHtml(item)}</div>
        <div class="heap-info">
          <div class="heap-name">${escHtml(item.name)} <span style="color:var(--muted);font-size:9px">${flags}</span></div>
          <div class="heap-bar-wrap"><div class="heap-bar-fill ${c}" style="width:${pct}%"></div></div>
        </div>
        <div class="heap-val ${c}">${item.score}</div>
      </div>`;
    });
    html+=`</div></div>`;
  }

  document.getElementById('panel-resources').innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXTENSIONS TAB (all items with toggle)
// ═══════════════════════════════════════════════════════════════════════════════
function renderExtensionsTab({ allItems }) {
  const scored = allItems.filter(i=>i.type!=='theme').map(i=>({...i,score:scoreItem(i)})).sort((a,b)=>b.score-a.score);
  const enabled = scored.filter(i=>i.enabled);
  const disabled = scored.filter(i=>!i.enabled);

  function row(item) {
    const pct = Math.round((item.score/(scored[0]?.score||1))*100);
    const c = item.enabled?(pct>70?'danger':pct>40?'warn':'ok'):'';
    const perms=[...(item.permissions||[]),...(item.hostPermissions||[])];
    const hasWebReq=perms.includes('webRequest')||perms.includes('webRequestBlocking');
    const hasAllUrls=perms.includes('<all_urls>');
    const hasBg=perms.includes('background');
    return `<div class="item-row ${item.enabled?c:'dim'}" data-id="${item.id}">
      <div class="item-icon">${iconHtml(item)}</div>
      <div class="item-info">
        <div class="item-name">${escHtml(item.name)}
          ${item.type!=='extension'?`<span class="tag blue">${typeLabel(item.type)}</span>`:''}
          ${hasWebReq?'<span class="tag red">🌐 net</span>':''}
          ${hasAllUrls?'<span class="tag yellow">⚠ all</span>':''}
          ${hasBg?'<span class="tag blue">⚙ bg</span>':''}
        </div>
        <div style="display:flex;align-items:center;gap:6px;margin-top:4px">
          <div class="heap-bar-wrap" style="flex:1"><div class="heap-bar-fill ${c}" style="width:${item.enabled?pct:0}%"></div></div>
          <span style="font-family:'Space Mono',monospace;font-size:10px;color:var(--muted)">${item.score}pts</span>
        </div>
      </div>
      <button class="toggle-btn ${item.enabled?'btn-disable':'btn-enable'}" data-id="${item.id}" data-enabled="${item.enabled}">
        ${item.enabled?'Disable':'Enable'}
      </button>
    </div>`;
  }

  let html = `<div class="section-header"><div class="section-title">Enabled (${enabled.length}) — by impact</div></div>`;
  html += enabled.map(row).join('');
  if (disabled.length>0) {
    html+=`<div class="section-header"><div class="section-title">Disabled (${disabled.length})</div></div>`;
    html+=disabled.map(row).join('');
  }

  const panel = document.getElementById('panel-extensions');
  panel.innerHTML = html;
  wireToggleBtnsStandalone(panel);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TABS
// ═══════════════════════════════════════════════════════════════════════════════
function renderTabs({ tabs, tabMemory }) {
  if (!tabs.length) { document.getElementById('panel-tabs').innerHTML=`<div class="empty-state"><div class="icon">🗂️</div><p>No tabs open</p></div>`; return; }
  const withMem=tabs.filter(t=>tabMemory[t.id]).sort((a,b)=>tabMemory[b.id].usedJSHeapSize-tabMemory[a.id].usedJSHeapSize);
  const noMem=tabs.filter(t=>!tabMemory[t.id]);
  const all=[...withMem,...noMem];
  const maxH=withMem.length>0?(tabMemory[withMem[0].id].usedJSHeapSize||1):1;
  const total=withMem.reduce((s,t)=>s+tabMemory[t.id].usedJSHeapSize,0);

  const row = t => {
    let domain=''; try{domain=new URL(t.url||'').hostname.replace('www.','');}catch(e){}
    const mem=tabMemory[t.id], hMB=mem?mem.usedJSHeapSize/1024/1024:null;
    const pct=mem?Math.round(mem.usedJSHeapSize/maxH*100):0;
    const c=hMB?sevColor(hMB,100,300):'info';
    return `<div class="item-row ${hMB>300?'danger':hMB>100?'warn':''}">
      <div class="item-icon">${t.favIconUrl?`<img src="${t.favIconUrl}" width="16" height="16" style="object-fit:contain">`:'🌐'}</div>
      <div class="item-info">
        <div class="item-name">${escHtml(t.title||domain||'Untitled')}
          ${t.audible?'<span class="tag yellow">🔊</span>':''}
          ${t.discarded?'<span class="tag green">💤</span>':''}
          ${t.pinned?'<span class="tag blue">📌</span>':''}
          ${t.active?'<span class="tag green">●</span>':''}
        </div>
        ${mem?`<div class="heap-bar-wrap" style="margin-top:4px"><div class="heap-bar-fill ${c}" style="width:${pct}%"></div></div>`:''}
      </div>
      <div class="metric-chip"><div class="metric-val ${c}">${hMB!==null?fmtMB(mem.usedJSHeapSize):t.discarded?'~0':'—'}</div><div class="metric-label">JS Heap</div></div>
    </div>`;
  };

  document.getElementById('panel-tabs').innerHTML=`
    <div class="tip-box" style="margin-bottom:10px"><strong>${tabs.length} tabs</strong> · ${withMem.length} measured · <strong>${fmtMB(total)} total JS heap</strong></div>
    ${all.slice(0,30).map(row).join('')}
    ${all.length>30?`<div class="tip-box">…and ${all.length-30} more</div>`:''}
    <div class="tip-box" style="margin-top:8px"><strong>💡</strong> Enable <strong>Memory Saver</strong> in Chrome Settings → Performance.</div>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PERMISSIONS
// ═══════════════════════════════════════════════════════════════════════════════
function renderPerms({ allItems }) {
  const enabled = allItems.filter(i=>i.enabled&&i.type!=='theme');
  const defs=[
    {key:'webRequest',icon:'🌐',label:'Net Intercept',sev:'danger'},
    {key:'<all_urls>',icon:'🔓',label:'All Websites',sev:'danger'},
    {key:'history',icon:'📜',label:'History',sev:'danger'},
    {key:'cookies',icon:'🍪',label:'Cookies',sev:'danger'},
    {key:'clipboardRead',icon:'📋',label:'Clipboard',sev:'danger'},
    {key:'tabs',icon:'🗂️',label:'Tab Mgmt',sev:'warn'},
    {key:'downloads',icon:'⬇️',label:'Downloads',sev:'warn'},
    {key:'nativeMessaging',icon:'💻',label:'Native',sev:'warn'},
    {key:'background',icon:'⚙️',label:'Background',sev:'warn'},
    {key:'identity',icon:'👤',label:'Identity',sev:'warn'},
  ];
  const counts={};
  defs.forEach(d=>{counts[d.key]=0;});
  enabled.forEach(i=>{
    const p=[...(i.permissions||[]),...(i.hostPermissions||[])];
    defs.forEach(d=>{if(p.includes(d.key))counts[d.key]++;});
  });

  const danger=defs.filter(d=>d.sev==='danger'&&counts[d.key]>0);
  const warn=defs.filter(d=>d.sev==='warn'&&counts[d.key]>0);

  let html=`<div class="section-header"><div class="section-title">Risky Permissions</div></div>`;
  if(danger.length>0){
    html+=`<div class="perm-grid">`;
    danger.forEach(d=>{html+=`<div class="perm-item"><div class="perm-icon">${d.icon}</div><div><div class="perm-name">${d.label}</div><div class="perm-count danger">${counts[d.key]} item${counts[d.key]>1?'s':''}</div></div></div>`;});
    html+=`</div>`;
  }
  if(warn.length>0){
    html+=`<div class="section-header" style="margin-top:8px"><div class="section-title">Elevated</div></div><div class="perm-grid">`;
    warn.forEach(d=>{html+=`<div class="perm-item"><div class="perm-icon">${d.icon}</div><div><div class="perm-name">${d.label}</div><div class="perm-count warn">${counts[d.key]} item${counts[d.key]>1?'s':''}</div></div></div>`;});
    html+=`</div>`;
  }
  if(!danger.length&&!warn.length) html+=`<div class="tip-box">✅ No risky permissions detected.</div>`;
  else {
    html+=`<div class="section-header" style="margin-top:12px"><div class="section-title">By Item</div></div>`;
    enabled.forEach(item=>{
      const p=[...(item.permissions||[]),...(item.hostPermissions||[])];
      const risky=defs.filter(d=>p.includes(d.key));
      if(!risky.length) return;
      const ms=risky.some(d=>d.sev==='danger')?'danger':'warn';
      html+=`<div class="item-row ${ms}">
        <div class="item-icon">${iconHtml(item)}</div>
        <div class="item-info">
          <div class="item-name">${escHtml(item.name)} ${item.type!=='extension'?`<span class="tag blue">${typeLabel(item.type)}</span>`:''}</div>
          <div class="item-detail">${risky.map(d=>`<span>${d.icon} ${d.label}</span>`).join('')}</div>
        </div>
        <button class="toggle-btn ${item.enabled?'btn-disable':'btn-enable'}" data-id="${item.id}" data-enabled="${item.enabled}">${item.enabled?'Disable':'Enable'}</button>
      </div>`;
    });
  }
  html+=`<div class="tip-box" style="margin-top:8px"><strong>💡</strong> Remove extensions you don't recognize.</div>`;
  const panel = document.getElementById('panel-perms');
  panel.innerHTML=html;
  wireToggleBtnsStandalone(panel);
}

// ═══════════════════════════════════════════════════════════════════════════════
// LIVE MONITOR
// ═══════════════════════════════════════════════════════════════════════════════
let livePort = null;
let liveActive = false;

let stressPort = null;
let stressRunning = false;
let stressSamples = [];

function startLiveMonitor() {
  if (liveActive) return;
  liveActive = true;

  const panel = document.getElementById('panel-live');
  panel.innerHTML = `<div class="live-connecting"><div class="spinner"></div><p>Attaching to extension &amp; tab processes…<br><span style="font-size:10px;color:var(--warn)">⚠ Yellow bar will appear: <em>"Speed Doctor is debugging this browser"</em></span></p></div>`;

  livePort = chrome.runtime.connect({ name: 'live-monitor' });

  livePort.onMessage.addListener(msg => {
    if (msg.type === 'ready') {
      renderLiveReady(msg.count);
    } else if (msg.type === 'attached') {
      // Update session count in status once all attached
      const st = document.getElementById('live-status');
      if (st) st.textContent = `Attached to ${msg.count} process${msg.count!==1?'es':''} · 2s refresh`;
    } else if (msg.type === 'tick') {
      renderLiveTick(msg);
    } else if (msg.type === 'error') {
      liveActive = false;
      const p = document.getElementById('panel-live');
      if (p) p.innerHTML = `<div class="empty-state"><div class="icon">⚠️</div><p>Live monitor error: ${escHtml(msg.error)}</p></div>`;
    }
  });

  livePort.onDisconnect.addListener(() => {
    liveActive = false;
    livePort = null;
    const dot = document.getElementById('live-dot');
    if (dot) dot.className = 'live-dot off';
    const st = document.getElementById('live-status');
    if (st) st.textContent = 'stopped';
  });
}

function stopLiveMonitor() {
  if (livePort) { try { livePort.disconnect(); } catch(e) {} }
  liveActive = false;
  livePort = null;
}

function renderLiveReady(count) {
  const panel = document.getElementById('panel-live');
  if (!panel) return;
  panel.innerHTML = `
  <div class="live-warn-box">
    <strong>⚠ Debugger active</strong> — Chrome shows a yellow bar while this tab is open. Disappears when you leave this tab.<br>
    <span style="color:var(--muted);font-size:10px">📊 <strong style="color:var(--text)">Tabs</strong>: full CPU + heap. &nbsp;
    🧩 <strong style="color:var(--text)">MV2 extensions</strong> (HTML background page): full CPU + heap. &nbsp;
    ⚙️ <strong style="color:var(--text)">MV3 extensions</strong> (service worker): Chrome blocks external debugger attach — not measurable per-extension.</span>
  </div>
  <div class="live-header">
    <div class="live-title"><span class="live-dot" id="live-dot"></span> Live Monitor</div>
    <span class="live-status" id="live-status">${count > 0 ? `Attached to ${count} process${count!==1?'es':''} · 2s refresh` : 'Attaching to processes…'}</span>
  </div>
  <div class="live-sys-bar">
    <div class="live-sys-card"><div class="live-sys-val" id="lv-cpu" style="color:var(--ok)">—</div><div class="live-sys-label">System CPU</div></div>
    <div class="live-sys-card"><div class="live-sys-val" id="lv-mem" style="color:var(--accent3)">—</div><div class="live-sys-label">RAM Used</div></div>
    <div class="live-sys-card"><div class="live-sys-val" id="lv-free" style="color:var(--accent4)">—</div><div class="live-sys-label">RAM Free</div></div>
  </div>
  <div id="live-process-list"></div>
  <div style="display:flex;align-items:center;justify-content:space-between;margin-top:6px">
    <div class="live-updated" id="live-updated"></div>
    <button id="liveDebugBtn" style="font-size:9px;background:rgba(255,255,255,.05);border:1px solid var(--border);border-radius:4px;color:var(--muted);padding:2px 8px;cursor:pointer;font-family:'Space Mono',monospace">🔍 Debug targets</button>
  </div>
  <div id="live-debug-out" style="display:none;margin-top:6px;font-size:9px;font-family:'Space Mono',monospace;background:var(--surface2);border:1px solid var(--border);border-radius:5px;padding:7px;color:var(--muted);white-space:pre-wrap;max-height:150px;overflow-y:auto"></div>`;
}

function renderLiveTick(data) {
  if (!document.getElementById('live-dot')) return;
  const { processes, sysCpu, sysMemPct, sysMemFreeMB } = data;

  // System stats
  const cpuEl = document.getElementById('lv-cpu');
  const memEl = document.getElementById('lv-mem');
  const freeEl = document.getElementById('lv-free');
  if (cpuEl && sysCpu != null) {
    cpuEl.textContent = sysCpu + '%';
    cpuEl.style.color = sysCpu > 80 ? 'var(--danger)' : sysCpu > 50 ? 'var(--warn)' : 'var(--ok)';
  }
  if (memEl && sysMemPct != null) {
    memEl.textContent = sysMemPct + '%';
    memEl.style.color = sysMemPct > 85 ? 'var(--danger)' : sysMemPct > 70 ? 'var(--warn)' : 'var(--accent3)';
  }
  if (freeEl && sysMemFreeMB != null) {
    freeEl.textContent = sysMemFreeMB > 1024 ? (sysMemFreeMB/1024).toFixed(1)+'G' : sysMemFreeMB+'M';
  }

  const maxCpu = processes.reduce((m, p) => Math.max(m, p.cpuPct||0), 0);
  const dot = document.getElementById('live-dot');
  if (dot) dot.className = `live-dot ${maxCpu > 30 ? 'warn' : ''}`;
  const st = document.getElementById('live-status');
  if (st) st.textContent = `${processes.length} process${processes.length!==1?'es':''} · 2s refresh`;

  const sorted = [...processes].sort((a,b) => (b.cpuPct||0) - (a.cpuPct||0));
  const exts = sorted.filter(p => p.kind === 'ext');
  const tabs = sorted.filter(p => p.kind === 'tab');
  const maxProcCpu = Math.max(sorted[0]?.cpuPct || 0, 1);

  function row(p) {
    const cpu = p.cpuPct ?? 0;
    const hasData = !p.noTarget;
    const isMV3 = p.isMV3SW || p.hasNoTarget;
    const cpuCls = !hasData ? 'dim' : cpu > 30 ? 'danger' : cpu > 10 ? 'warn' : 'ok';
    const barPct = hasData ? Math.min(100, Math.round((cpu / maxProcCpu) * 100)) : 0;
    const barColor = cpu > 30 ? 'var(--danger)' : cpu > 10 ? 'var(--warn)' : 'var(--ok)';
    const heap = p.heapMB != null ? p.heapMB.toFixed(1) + ' MB' : hasData ? '—' : (isMV3 ? 'SW' : '—');
    const heapCls = !hasData ? 'dim' : p.heapMB > 200 ? 'danger' : p.heapMB > 80 ? 'warn' : p.heapMB != null ? 'ok' : 'dim';
    const rowCls = !hasData ? 'cool' : cpu > 30 ? 'hot' : cpu > 10 ? 'warm' : 'cool';
    const cpuStr = !hasData ? (isMV3 ? 'MV3' : '—') : cpu + '%';
    let ic = '🌐';
    if (p.kind === 'ext') {
      ic = safeIcon(p.icons, p.type, 18);
    } else if (p.favIcon && p.favIcon.startsWith('https://')) {
      ic = `<img src="${escHtml(p.favIcon)}" width="14" height="14" style="object-fit:contain">`;
    }
    return `<div class="live-row ${rowCls}" style="${!hasData?'opacity:.5':''}">
      <div class="live-icon">${ic}</div>
      <span class="live-name">${escHtml(p.label)}</span>
      <div class="live-metrics">
        <div class="live-metric"><div class="live-metric-val ${cpuCls}" title="${isMV3&&!hasData?'MV3 service workers cannot be measured by external extensions (Chrome restriction)':''}">${cpuStr}</div><div class="live-metric-label">CPU</div></div>
        <div class="live-cpu-bar"><div class="live-cpu-fill" style="width:${barPct}%;background:${barColor}"></div></div>
        <div class="live-metric"><div class="live-metric-val ${heapCls}">${heap}</div><div class="live-metric-label">JS Heap</div></div>
      </div>
    </div>`;
  }

  let html = '';
  if (exts.length) {
    const live = exts.filter(e => !e.noTarget).length;
    const mv3 = exts.filter(e => e.isMV3SW || e.hasNoTarget).length;
    const note = mv3 > 0 ? ` · ${live} live, ${mv3} MV3` : '';
    html += `<div class="live-section"><div class="live-section-hdr"><span>Extensions (${exts.length}${note})</span><span>CPU · Heap</span></div>${exts.map(row).join('')}</div>`;
  }
  if (tabs.length) html += `<div class="live-section"><div class="live-section-hdr"><span>Tabs (${tabs.length})</span><span>CPU · Heap</span></div>${tabs.map(row).join('')}</div>`;
  if (!html) html = `<div class="empty-state" style="padding:16px"><p>No processes attached yet.</p></div>`;

  const list = document.getElementById('live-process-list');
  if (list) list.innerHTML = html;
  const upd = document.getElementById('live-updated');
  if (upd) upd.textContent = 'Updated ' + new Date().toLocaleTimeString();

  // Wire debug button once it exists
  const dbgBtn = document.getElementById('liveDebugBtn');
  if (dbgBtn) {
    dbgBtn.onclick = () => {
      const out = document.getElementById('live-debug-out');
      if (!out) return;
      out.style.display = 'block';
      out.textContent = 'Fetching targets…';
      chrome.runtime.sendMessage({ type: 'GET_TARGETS_DEBUG' }, r => {
        if (!r) { out.textContent = 'No response'; return; }
        let txt = `Total targets: ${r.total}  |  Ext targets: ${r.extTargets?.length}  |  Attachable: ${r.filtered}\n\n`;
        (r.extTargets || []).forEach(t => {
          txt += `[${t.type}] attached=${t.attached} extId=${t.extId?.slice(0,8)}…\n  url: ${t.url}\n`;
        });
        out.textContent = txt || 'No extension targets found';
      });
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEEP SCAN
// ═══════════════════════════════════════════════════════════════════════════════
let deepScanPort = null;
let deepScanRunning = false;
let cachedDeepResult = null;

function startDeepScan() {
  if (deepScanRunning) return;
  deepScanRunning = true;

  const btn = document.getElementById('deepScanBtn');
  const eta = document.getElementById('deepScanEta');
  btn.disabled = true;
  btn.textContent = '⏳ Running…';

  // Estimate time from cached item count
  const itemCount = cachedData?.allItems?.filter(i => i.enabled && i.type !== 'theme').length || '?';
  if (eta) eta.textContent = `~${typeof itemCount === 'number' ? Math.round(itemCount * 6) : '?'}s estimated`;

  renderDeepScanLive(0, `Starting deep scan of ${itemCount} extensions…`, []);

  deepScanPort = chrome.runtime.connect({ name: 'deep-scan' });

  const liveItems = [];

  deepScanPort.onMessage.addListener(msg => {
    if (msg.type === 'start') {
      renderDeepScanLive(0, 'Opening test tab…', liveItems);
    } else if (msg.type === 'status') {
      renderDeepScanLive(msg.progress, msg.text, liveItems);
    } else if (msg.type === 'item_done') {
      liveItems.push(msg.item);
      renderDeepScanLive(msg.progress, `✅ Done: ${msg.item.name}`, liveItems);
    } else if (msg.type === 'done') {
      deepScanRunning = false;
      deepScanPort.disconnect();
      deepScanPort = null;
      btn.disabled = false;
      btn.textContent = '🔄 Re-run Deep Scan';
      if (eta) eta.textContent = '';
      cachedDeepResult = msg.result;
      try { chrome.storage.session.set({ cachedDeepResult }); } catch(e) {}
      renderDeepScanDone(msg.result);
    } else if (msg.type === 'error') {
      deepScanRunning = false;
      btn.disabled = false;
      btn.textContent = '🔬 Start Deep Scan';
      if (eta) eta.textContent = '';
      const c = document.getElementById('deep-scan-content');
      if (c) c.innerHTML = `<div class="tip-box" style="color:var(--danger);border-color:rgba(255,51,85,.3)">❌ Deep scan failed: ${escHtml(msg.error)}</div>`;
    }
  });

  deepScanPort.onDisconnect.addListener(() => {
    if (deepScanRunning) {
      deepScanRunning = false;
      btn.disabled = false;
      btn.textContent = '🔬 Start Deep Scan';
    }
  });
}

function renderDeepScanLive(progress, statusText, items) {
  const c = document.getElementById('deep-scan-content');
  if (!c) return;

  const listHtml = items.map(item => dsItemRow(item, items[0])).join('');

  c.innerHTML = `
  <div class="deep-scan-progress">
    <div class="dsp-header">
      <span class="dsp-status">${escHtml(statusText)}</span>
      <span class="dsp-pct">${progress}%</span>
    </div>
    <div class="dsp-track"><div class="dsp-bar" id="dsp-bar" style="width:${progress}%"></div></div>
    ${items.length > 0 ? `
    <div style="font-size:9px;color:var(--muted);font-family:'Space Mono',monospace;margin-bottom:5px;text-transform:uppercase;letter-spacing:.08em">Results so far (${items.length} tested)</div>
    <div class="dsp-item-list">${listHtml}</div>` : ''}
  </div>`;
}

function dsItemRow(item, topItem) {
  const maxHeap = Math.abs(topItem?.heapDeltaBytes || 1);
  const heapMB  = item.heapDeltaMB;
  const loadMs  = item.loadDeltaMs;
  const heapCls = heapMB > 20 ? 'danger' : heapMB > 5 ? 'warn' : heapMB > 0 ? 'ok' : 'muted';
  const loadCls = loadMs > 500 ? 'danger' : loadMs > 150 ? 'warn' : loadMs > 0 ? 'ok' : 'muted';
  const rowCls  = heapMB > 20 ? 'high' : heapMB > 5 ? 'med' : 'low';
  const iHtml   = safeIcon(item.icons, item.type, 18);

  const heapStr = heapMB != null ? (heapMB > 0 ? '+' : '') + heapMB.toFixed(1) + ' MB' : '—';
  const loadStr = loadMs != null ? (loadMs > 0 ? '+' : '') + loadMs + 'ms' : '—';

  return `<div class="ds-result-item ${rowCls}">
    <div class="ds-item-icon">${iHtml}</div>
    <span class="ds-item-name">${escHtml(item.name)}</span>
    <div class="ds-item-metrics">
      <div class="ds-metric">
        <div class="ds-metric-val ${heapCls}">${heapStr}</div>
        <div class="ds-metric-label">RAM cost</div>
      </div>
      <div class="ds-metric">
        <div class="ds-metric-val ${loadCls}">${loadStr}</div>
        <div class="ds-metric-label">Load cost</div>
      </div>
    </div>
  </div>`;
}

function renderDeepScanDone(result) {
  const c = document.getElementById('deep-scan-content');
  if (!c) return;

  const { items, baseline } = result;
  if (!items?.length) {
    c.innerHTML = `<div class="tip-box">No results — no enabled extensions found.</div>`;
    return;
  }

  const maxHeap = Math.max(...items.map(i => Math.abs(i.heapDeltaBytes||0)), 1);
  const maxLoad = Math.max(...items.map(i => Math.abs(i.loadDeltaMs||0)), 1);
  const totalHeapMB = items.reduce((s, i) => s + (i.heapDeltaBytes||0), 0) / 1024 / 1024;
  const topRam  = items.filter(i => (i.heapDeltaMB||0) > 0).slice(0, 3);
  const topLoad = [...items].sort((a,b) => (b.loadDeltaMs||0)-(a.loadDeltaMs||0)).slice(0, 3);

  // Build insights
  const insights = [];
  if (items[0]?.heapDeltaMB > 20) insights.push({ sev:'danger', text:`"${items[0].name}" adds ${items[0].heapDeltaMB.toFixed(1)} MB of RAM every page load — largest single cost.` });
  if (totalHeapMB > 50)  insights.push({ sev:'danger', text:`All enabled extensions together add ~${totalHeapMB.toFixed(0)} MB of JS heap per page.` });
  else if (totalHeapMB > 15) insights.push({ sev:'warn', text:`Extensions add ~${totalHeapMB.toFixed(0)} MB of JS heap per page in total.` });
  const slowest = items.reduce((b,i) => (i.loadDeltaMs||0) > (b?.loadDeltaMs||0) ? i : b, null);
  if (slowest?.loadDeltaMs > 500) insights.push({ sev:'danger', text:`"${slowest.name}" slows page load by ${slowest.loadDeltaMs}ms — disabling it could make pages noticeably faster.` });
  else if (slowest?.loadDeltaMs > 150) insights.push({ sev:'warn', text:`"${slowest.name}" adds ${slowest.loadDeltaMs}ms to page load time.` });
  if (baseline?.load) insights.push({ sev:'ok', text:`Baseline page load (all on): ${baseline.load}ms. Tab JS heap: ${(baseline.heap/1024/1024).toFixed(0)} MB.` });
  if (!insights.length) insights.push({ sev:'ok', text:`Extensions appear lightweight — no single one adds significant RAM or load time.` });

  let html = `
  <div class="stress-interp" style="margin-top:10px">`;
  insights.forEach(i => {
    const dot = i.sev==='danger' ? 'var(--danger)' : i.sev==='warn' ? 'var(--warn)' : 'var(--ok)';
    html += `<div class="stress-insight"><div class="issue-dot" style="background:${dot};margin-top:3px;flex-shrink:0"></div><div class="issue-text">${i.text}</div></div>`;
  });
  html += `</div>

  <div class="section-header" style="margin-top:14px">
    <div class="section-title">Per-Extension RAM + Load Time (differential)</div>
  </div>
  <div class="stress-table-wrap">
    <table class="ds-final-table">
      <thead><tr>
        <th style="width:28px"></th>
        <th>Extension</th>
        <th>RAM cost</th>
        <th class="ds-bar-cell"></th>
        <th>Load cost</th>
        <th class="ds-bar-cell"></th>
        <th></th>
      </tr></thead>
      <tbody>`;

  items.forEach(item => {
    const heapMB  = item.heapDeltaMB;
    const loadMs  = item.loadDeltaMs;
    const heapPct = maxHeap > 0 ? Math.round(Math.abs(item.heapDeltaBytes||0) / maxHeap * 100) : 0;
    const loadPct = maxLoad > 0 ? Math.round(Math.abs(loadMs||0) / maxLoad * 100) : 0;
    const heapCls = heapMB > 20 ? 'danger' : heapMB > 5 ? 'warn' : 'ok';
    const loadCls = loadMs > 500 ? 'danger' : loadMs > 150 ? 'warn' : 'ok';
    const iHtml   = safeIcon(item.icons, item.type, 16);

    const liveItem  = cachedData?.allItems?.find(i => i.id === item.id);
    const isEnabled = liveItem?.enabled ?? true;

    html += `<tr class="ds-toggle-row" data-id="${item.id}" data-enabled="${isEnabled}" style="cursor:pointer" title="${isEnabled?'Click row to disable':'Click row to enable'}">
      <td><div style="width:20px;height:20px;border-radius:4px;background:var(--surface2);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;overflow:hidden">${iHtml}</div></td>
      <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;font-weight:500">${escHtml(item.name)}</td>
      <td><span style="font-family:'Space Mono',monospace;font-size:11px;font-weight:700" class="${heapCls}">${heapMB != null ? (heapMB > 0 ? '+' : '') + heapMB.toFixed(1) + ' MB' : '—'}</span></td>
      <td class="ds-bar-cell"><div class="ds-mini-bar"><div class="ds-mini-fill ${heapCls}" style="width:${heapPct}%"></div></div></td>
      <td><span style="font-family:'Space Mono',monospace;font-size:11px;font-weight:700" class="${loadCls}">${loadMs != null ? (loadMs > 0 ? '+' : '') + loadMs + 'ms' : '—'}</span></td>
      <td class="ds-bar-cell"><div class="ds-mini-bar"><div class="ds-mini-fill ${loadCls}" style="width:${loadPct}%"></div></div></td>
      <td onclick="event.stopPropagation()"><button class="toggle-btn ${isEnabled?'btn-disable':'btn-enable'}" data-id="${item.id}" data-enabled="${isEnabled}" style="font-size:8px;padding:2px 7px">${isEnabled?'Disable':'Enable'}</button></td>
    </tr>`;
  });

  html += `</tbody></table></div>
  <div class="tip-box" style="margin-top:6px">
    <strong>How to read:</strong> RAM cost = JS heap added by this extension per page load.
    Load cost = milliseconds added to page load time. Measured by disabling each extension and reloading google.com.
  </div>`;

  c.innerHTML = html;
  wireToggleBtnsStandalone(c);

  // Wire whole-row click for deep scan table
  c.querySelectorAll('.ds-toggle-row').forEach(row => {
    row.onclick = () => {
      const id = row.dataset.id;
      const currentlyEnabled = row.dataset.enabled === 'true';
      const newEnabled = !currentlyEnabled;
      row.dataset.enabled = String(newEnabled);
      row.title = newEnabled ? 'Click row to disable' : 'Click row to enable';
      row.style.opacity = newEnabled ? '' : '0.5';
      const btn = row.querySelector('.toggle-btn');
      if (btn) {
        btn.dataset.enabled = String(newEnabled);
        btn.textContent = newEnabled ? 'Disable' : 'Enable';
        btn.className = `toggle-btn ${newEnabled ? 'btn-disable' : 'btn-enable'}`;
      }
      toggleItem(id, currentlyEnabled);
    };
  });
}

function startStressTest() {
  if(stressRunning) return;
  stressRunning=true; stressSamples=[];
  const btn=document.getElementById('stressBtn');
  btn.disabled=true; btn.textContent='⏳ Running…';
  renderStressLive('start',0,null,[]);
  stressPort=chrome.runtime.connect({name:'stress-test'});
  stressPort.onMessage.addListener(msg=>{
    if(msg.type==='start') renderStressLive('running',0,null,stressSamples);
    else if(msg.type==='phase') { const el=document.getElementById('stress-phase-label'); if(el) el.textContent=msg.label; }
    else if(msg.type==='sample') { stressSamples.push(msg.sample); renderStressLive('running',msg.progress,msg.sample,stressSamples); }
    else if(msg.type==='done') {
      stressRunning=false; stressPort.disconnect(); stressPort=null;
      btn.disabled=false; btn.textContent='🔁 Run Again';
      cachedStressResult=msg.result; saveToSession();
      renderStressDone(msg.result);
    }
    else if(msg.type==='error') { stressRunning=false; btn.disabled=false; btn.textContent='▶ Run 20s Test'; }
  });
  stressPort.onDisconnect.addListener(()=>{ if(stressRunning){stressRunning=false;btn.disabled=false;btn.textContent='▶ Run 20s Test';} });
}

function renderStressLive(state,progress,last,samples) {
  const c=document.getElementById('stress-content'); if(!c) return;
  if(state==='start'||samples.length===0) {
    c.innerHTML=`<div class="stress-live-wrap">
      <div class="stress-timeline-header">
        <span id="stress-phase-label" class="stress-phase">⏱ Starting baseline…</span>
        <span class="stress-progress-pct" id="stress-pct">0%</span>
      </div>
      <div class="stress-progress-track"><div class="stress-progress-bar" id="stress-bar" style="width:0%"></div></div>
      <div class="stress-phases-row">
        <div class="stress-phase-seg baseline">0s Baseline</div>
        <div class="stress-phase-seg tab-open">5s New Tab</div>
        <div class="stress-phase-seg navigating">10s Google</div>
        <div class="stress-phase-seg cooling">15s Cooldown</div>
      </div>
      <div class="stress-chart-wrap" id="stress-chart">${renderSparklines(samples)}</div>
      <div class="stress-samples-info" id="stress-info">Waiting for first sample…</div>
    </div>`; return;
  }
  const bar=document.getElementById('stress-bar'), pct=document.getElementById('stress-pct');
  const info=document.getElementById('stress-info'), chart=document.getElementById('stress-chart');
  if(bar) bar.style.width=progress+'%';
  if(pct) pct.textContent=progress+'%';
  if(chart) chart.innerHTML=renderSparklines(samples);
  if(last&&info) info.innerHTML=`
    <span class="ss-item ${sevCls(last.cpu,50,80)}">CPU ${last.cpu!==null?last.cpu+'%':'—'}</span>
    <span class="ss-item ${sevCls(last.memUsedPct,70,85)}">RAM ${last.memUsedPct!==null?last.memUsedPct+'%':'—'}</span>
    <span class="ss-item info">t=${last.t}s · ${last.phase}</span>`;
}

function renderSparklines(samples) {
  if(samples.length<2) return '';
  const W=456,H=52,P=2;
  const cv=samples.map(s=>s.cpu!==null?s.cpu:0), mv=samples.map(s=>s.memUsedPct!==null?s.memUsedPct:0);
  const mc=Math.max(...cv,10), mm=Math.max(...mv,10);
  const line=(vals,maxV,stroke,fill)=>{
    const n=vals.length, pts=vals.map((v,i)=>`${P+(i/Math.max(n-1,1))*(W-P*2)},${H-P-(v/maxV)*(H-P*2)}`);
    const last=pts[pts.length-1].split(',');
    return `<polygon points="${[...pts,`${last[0]},${H}`,`${P},${H}`].join(' ')}" fill="${fill}" opacity="0.15"/>
      <polyline points="${pts.join(' ')}" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round"/>`;
  };
  const phaseC={baseline:'rgba(68,136,255,.07)',tab_open:'rgba(255,170,0,.07)',navigating:'rgba(255,51,85,.07)',cooling:'rgba(0,204,102,.07)'};
  let bands='',cur=null,ps=0;
  samples.forEach((s,i)=>{
    if(s.phase!==cur){
      if(cur){const x1=P+(ps/Math.max(samples.length-1,1))*(W-P*2),x2=P+(i/Math.max(samples.length-1,1))*(W-P*2);
        bands+=`<rect x="${x1}" y="0" width="${x2-x1}" height="${H}" fill="${phaseC[cur]||'transparent'}"/>`;}
      cur=s.phase; ps=i;
    }
  });
  return `<svg width="${W}" height="${H}" style="display:block;width:100%;height:${H}px;border-radius:6px;background:var(--surface2)">
    ${bands}${line(mv,mm,'#ffaa00','#ffaa00')}${line(cv,mc,'#4488ff','#4488ff')}
    <text x="6" y="10" font-size="9" fill="#4488ff" font-family="monospace">CPU</text>
    <text x="34" y="10" font-size="9" fill="#ffaa00" font-family="monospace">RAM</text>
    <text x="${W-6}" y="10" font-size="9" fill="#6868a0" font-family="monospace" text-anchor="end">${samples.length}s</text>
  </svg>`;
}

function renderStressDone(result) {
  const { samples, cpuBaseline, cpuPeak, cpuNavigate, cpuCooldown,
          memStart, memPeak, itemResults, pageMetrics,
          tabScriptMs, tabTaskMs, tabCPUTimeMs } = result;
  const c = document.getElementById('stress-content');
  if (!c) return;

  const spike  = (cpuPeak != null && cpuBaseline != null) ? cpuPeak - cpuBaseline : null;
  const mSpike = (memPeak != null && memStart    != null) ? memPeak - memStart    : null;
  const sc = (v,w,d) => v >= d ? 'danger' : v >= w ? 'warn' : 'ok';

  // ── Chart ─────────────────────────────────────────────────────────────────
  let html = `
  <div class="stress-done-chart">
    ${renderSparklines(samples)}
    <div class="stress-phase-legend">
      <span class="spl baseline">Baseline</span>
      <span class="spl tab-open">New Tab</span>
      <span class="spl navigating">Google</span>
      <span class="spl cooling">Cooldown</span>
    </div>
  </div>`;

  // ── System metrics grid ───────────────────────────────────────────────────
  html += `
  <div class="stress-metrics-grid">
    <div class="stress-metric-card">
      <div class="smc-label">Baseline CPU</div>
      <div class="smc-val ${sc(cpuBaseline||0,30,60)}">${cpuBaseline != null ? cpuBaseline+'%' : '—'}</div>
      <div class="smc-sub">idle avg</div>
    </div>
    <div class="stress-metric-card">
      <div class="smc-label">Peak CPU</div>
      <div class="smc-val ${sc(cpuPeak||0,50,80)}">${cpuPeak != null ? cpuPeak+'%' : '—'}</div>
      <div class="smc-sub">highest spike</div>
    </div>
    <div class="stress-metric-card">
      <div class="smc-label">CPU Spike</div>
      <div class="smc-val ${sc(spike||0,20,40)}">${spike != null ? '+'+spike+'%' : '—'}</div>
      <div class="smc-sub">vs baseline</div>
    </div>
    <div class="stress-metric-card">
      <div class="smc-label">RAM Spike</div>
      <div class="smc-val ${sc(mSpike||0,3,8)}">${mSpike != null ? '+'+mSpike+'%' : '—'}</div>
      <div class="smc-sub">peak vs start</div>
    </div>
    <div class="stress-metric-card">
      <div class="smc-label">During Nav</div>
      <div class="smc-val ${sc(cpuNavigate||0,50,80)}">${cpuNavigate != null ? cpuNavigate+'%' : '—'}</div>
      <div class="smc-sub">CPU avg</div>
    </div>
    <div class="stress-metric-card">
      <div class="smc-label">Cooldown</div>
      <div class="smc-val ${sc(cpuCooldown||0,30,60)}">${cpuCooldown != null ? cpuCooldown+'%' : '—'}</div>
      <div class="smc-sub">CPU after close</div>
    </div>
  </div>`;

  // ── Tab CDP box — real process CPU for test tab ───────────────────────────
  if (tabCPUTimeMs != null || tabTaskMs != null || tabScriptMs != null) {
    html += `
  <div class="page-metrics-box">
    <div class="pmb-title">🖥️ Test Tab Process — Real CDP CPU Data</div>
    <div class="pmb-grid">
      <div class="pmb-item">
        <span class="pmb-val ${sc(tabCPUTimeMs||0, 500, 2000)}">${tabCPUTimeMs != null ? tabCPUTimeMs+'ms' : '—'}</span>
        <span class="pmb-label">Process CPU</span>
      </div>
      <div class="pmb-item">
        <span class="pmb-val ${sc(tabTaskMs||0, 300, 1000)}">${tabTaskMs != null ? tabTaskMs+'ms' : '—'}</span>
        <span class="pmb-label">Task Time</span>
      </div>
      <div class="pmb-item">
        <span class="pmb-val ${sc(tabScriptMs||0, 200, 800)}">${tabScriptMs != null ? tabScriptMs+'ms' : '—'}</span>
        <span class="pmb-label">JS Exec</span>
      </div>
      <div class="pmb-item">
        <span class="pmb-val ${sc(pageMetrics?.loadTime||0, 2000, 4000)}">${pageMetrics?.loadTime != null ? pageMetrics.loadTime+'ms' : '—'}</span>
        <span class="pmb-label">Page Load</span>
      </div>
    </div>
    <div class="pmb-note">Measured via Chrome DevTools Protocol · <strong>Process CPU</strong> = total CPU time consumed by the tab's renderer process</div>
  </div>`;
  }

  // ── Page load metrics ─────────────────────────────────────────────────────
  if (pageMetrics && (pageMetrics.loadTime || pageMetrics.injectedScripts?.length)) {
    const scriptCount = (pageMetrics.injectedScripts||[]).length;
    html += `
  <div class="page-metrics-box" style="margin-top:-4px">
    <div class="pmb-title">🌐 google.com Load Metrics</div>
    <div class="pmb-grid">
      <div class="pmb-item">
        <span class="pmb-val ${sc(pageMetrics.loadTime||0, 2000, 4000)}">${pageMetrics.loadTime != null ? pageMetrics.loadTime+'ms' : '—'}</span>
        <span class="pmb-label">Load Time</span>
      </div>
      <div class="pmb-item">
        <span class="pmb-val ${sc(pageMetrics.fetchMs||0, 100, 300)}">${pageMetrics.fetchMs != null ? pageMetrics.fetchMs+'ms' : '—'}</span>
        <span class="pmb-label">Fetch RTT</span>
      </div>
      <div class="pmb-item">
        <span class="pmb-val ${scriptCount > 5 ? 'danger' : scriptCount > 2 ? 'warn' : 'ok'}">${scriptCount}</span>
        <span class="pmb-label">Ext Scripts</span>
      </div>
      <div class="pmb-item">
        <span class="pmb-val info">${pageMetrics.resourceCount||0}</span>
        <span class="pmb-label">Resources</span>
      </div>
    </div>
  </div>`;
  }

  // ── Insights ──────────────────────────────────────────────────────────────
  const insights = [];
  if (cpuBaseline > 40)   insights.push({ sev:'danger', text:`High idle CPU (${cpuBaseline}%) — background extensions are consuming CPU even when Chrome is idle.` });
  if (spike > 40)          insights.push({ sev:'danger', text:`Huge CPU spike (+${spike}%) during page load — content scripts or background processes are the likely cause.` });
  else if (spike > 20)     insights.push({ sev:'warn',   text:`Noticeable CPU spike (+${spike}%) — some extensions are slowing page rendering.` });
  if (cpuCooldown > (cpuBaseline||0) + 10) insights.push({ sev:'warn', text:`CPU stayed elevated after tab close — background processes didn't quiet down.` });
  if (mSpike > 8)          insights.push({ sev:'danger', text:`Large RAM spike (+${mSpike}%) from one tab — Chrome or extensions allocating heavily per page.` });
  if (tabCPUTimeMs > 2000) insights.push({ sev:'danger', text:`Test tab consumed ${tabCPUTimeMs}ms of process CPU — very heavy rendering, likely extension overhead.` });
  else if (tabCPUTimeMs > 500) insights.push({ sev:'warn', text:`Test tab used ${tabCPUTimeMs}ms of process CPU during navigation.` });
  if (pageMetrics?.loadTime > 4000) insights.push({ sev:'danger', text:`Page load took ${pageMetrics.loadTime}ms — likely slowed by multiple content scripts.` });
  const topCDP = (itemResults||[]).find(i => i.hasCDPData && (i.bgCPUTimeMs||0) > 100);
  if (topCDP) insights.push({ sev:'warn', text:`"${topCDP.name}" background process used ${topCDP.bgCPUTimeMs}ms of CPU time during the test — measured via CDP.` });
  const topCS = (itemResults||[]).find(i => i.contentScriptMs > 50);
  if (topCS) insights.push({ sev:'warn', text:`"${topCS.name}" injected ${topCS.contentScriptCount} script(s) totalling ${topCS.contentScriptMs}ms execution time on google.com.` });
  if (!insights.length) insights.push({ sev:'ok', text:'Chrome handled the test well. No major CPU spikes or extension overhead detected.' });

  html += `<div class="stress-interp">`;
  insights.forEach(i => {
    const dot = i.sev==='danger' ? 'var(--danger)' : i.sev==='warn' ? 'var(--warn)' : 'var(--ok)';
    html += `<div class="stress-insight"><div class="issue-dot" style="background:${dot};margin-top:3px;flex-shrink:0"></div><div class="issue-text">${i.text}</div></div>`;
  });
  html += `</div>`;

  // ── Per-extension impact table ────────────────────────────────────────────
  html += `
  <div class="section-header" style="margin-top:16px">
    <div class="section-title">Per-Extension Real CPU (CDP) + Content Script Impact</div>
  </div>
  <div class="ext-impact-legend">
    <span class="eil-item"><span class="eil-dot measured"></span> CDP measured (real process CPU)</span>
    <span class="eil-item"><span class="eil-dot perm"></span> Permission estimate</span>
  </div>`;

  if (!itemResults?.length) {
    html += `<div class="tip-box">No enabled extensions found.</div>`;
  } else {
    const maxScore = itemResults[0].totalScore || 1;
    itemResults.forEach(item => {
      const totalPct = Math.round((item.totalScore / maxScore) * 100);
      const measPct  = Math.round((item.measuredScore / maxScore) * 100);
      const permPct  = Math.round((item.permScore / maxScore) * 100);
      const color    = totalPct > 70 ? 'danger' : totalPct > 40 ? 'warn' : 'ok';
      const iHtml    = safeIcon(item.icons, item.type, 18);

      const liveItem  = cachedData?.allItems?.find(i => i.id === item.id);
      const isEnabled = liveItem?.enabled ?? true;

      // Build detail chips
      const details = [];
      if (item.hasCDPData) {
        if ((item.bgCPUTimeMs||0) > 0)  details.push(`<span class="meas-tag ${item.bgCPUTimeMs>200?'danger-tag':item.bgCPUTimeMs>50?'warn-tag':'ok-tag'}">🖥 ${item.bgCPUTimeMs}ms CPU</span>`);
        if ((item.bgTaskMs||0) > 0)      details.push(`<span class="meas-tag ${item.bgTaskMs>100?'warn-tag':'ok-tag'}">⚙ ${item.bgTaskMs}ms tasks</span>`);
        if ((item.bgScriptMs||0) > 0)    details.push(`<span class="meas-tag ${item.bgScriptMs>100?'warn-tag':'ok-tag'}">📜 ${item.bgScriptMs}ms JS</span>`);
      }
      if (item.contentScriptMs > 0)      details.push(`<span class="meas-tag ${item.contentScriptMs>50?'danger-tag':'warn-tag'}">⏱ ${item.contentScriptMs}ms inject</span>`);
      if (item.contentScriptCount > 0)   details.push(`<span class="meas-tag warn-tag">📄 ${item.contentScriptCount} script${item.contentScriptCount>1?'s':''}</span>`);
      if (!item.hasMeasuredData)         details.push(`<span class="meas-tag dim-tag">no bg page · estimate only</span>`);

      const permFlags = [
        item.perms.includes('webRequest') && '<span class="tag red">🌐 net</span>',
        item.perms.includes('<all_urls>')  && '<span class="tag yellow">⚠ all</span>',
        item.perms.includes('background') && '<span class="tag blue">⚙ bg</span>',
        item.type !== 'extension'          && `<span class="tag blue">${typeLabel(item.type)}</span>`,
      ].filter(Boolean).join('');

      html += `
      <div class="ext-impact-card ${color} ${isEnabled?'':'dim'}"
        data-id="${item.id}" data-enabled="${isEnabled}" data-color="${color}"
        title="${isEnabled?'Click to disable':'Click to enable'}">
        <div class="eic-header">
          <div class="item-icon">${iHtml}</div>
          <div class="eic-body">
            <div class="eic-name-row">
              <span class="eic-name">${escHtml(item.name)}</span>
              ${permFlags}
            </div>
            <div class="eic-details">${details.join('')}</div>
          </div>
          <div class="eic-score-col">
            <span class="eic-score ${color}">${item.totalScore}</span>
            <span class="eic-pts">PTS</span>
          </div>
        </div>
        <div class="eic-bars">
          <div class="eic-bar-row">
            <span class="eic-bar-label measured-label">Measured</span>
            <div class="eic-bar-track"><div class="eic-bar-fill measured-fill" style="width:${measPct}%"></div></div>
            <span class="eic-bar-val">${item.measuredScore}</span>
          </div>
          <div class="eic-bar-row">
            <span class="eic-bar-label perm-label">Perms</span>
            <div class="eic-bar-track"><div class="eic-bar-fill perm-fill" style="width:${permPct}%"></div></div>
            <span class="eic-bar-val">${item.permScore}</span>
          </div>
        </div>
        <div class="eic-actions" onclick="event.stopPropagation()">
          <button class="toggle-btn ${isEnabled?'btn-disable':'btn-enable'}" data-id="${item.id}" data-enabled="${isEnabled}">${isEnabled?'Disable':'Enable'}</button>
          <button class="card-action-btn" data-action="details" data-id="${item.id}">⚙ Details</button>
          <span class="status-pill ${isEnabled?'pill-on':'pill-off'}" style="margin-left:auto">${isEnabled?'ON':'OFF'}</span>
        </div>
      </div>`;
    });
  }

  // ── Per-second table ──────────────────────────────────────────────────────
  html += `
  <div class="section-header" style="margin-top:16px">
    <div class="section-title">Per-Second Timeline</div>
  </div>
  <div class="stress-table-wrap">
    <table class="stress-table">
      <thead><tr><th>t</th><th>Phase</th><th>CPU%</th><th>RAM%</th><th>Tab Heap</th></tr></thead>
      <tbody>`;
  samples.forEach(s => {
    const heap = s.testTabHeap ? (s.testTabHeap.used/1024/1024).toFixed(1)+'MB' : '—';
    const pl = {baseline:'Baseline',tab_open:'New Tab',navigating:'Google',cooling:'Cooldown'}[s.phase]||s.phase;
    html += `<tr>
      <td>${s.t}s</td>
      <td class="phase-cell ${s.phase}">${pl}</td>
      <td class="${sevCls(s.cpu,50,80)}">${s.cpu!=null?s.cpu+'%':'—'}</td>
      <td class="${sevCls(s.memUsedPct,70,85)}">${s.memUsedPct!=null?s.memUsedPct+'%':'—'}</td>
      <td>${heap}</td>
    </tr>`;
  });
  html += `</tbody></table></div>`;

  c.innerHTML = html;

  // Wire whole-card click = toggle
  c.querySelectorAll('.ext-impact-card').forEach(card => {
    card.onclick = () => {
      const id = card.dataset.id;
      const enabled = card.dataset.enabled === 'true';
      const newEnabled = !enabled;

      // Update card dataset
      card.dataset.enabled = String(newEnabled);
      const colorCls = card.dataset.color || 'ok';
      card.classList.remove('danger','warn','ok','dim');
      card.classList.add(newEnabled ? colorCls : 'dim');
      card.title = newEnabled ? 'Click to disable' : 'Click to enable';

      // Update status pill
      const pill = card.querySelector('.status-pill');
      if (pill) { pill.textContent = newEnabled?'ON':'OFF'; pill.className=`status-pill ${newEnabled?'pill-on':'pill-off'}`; }

      // Update toggle button — both its data-enabled AND its class/text
      const toggleBtn = card.querySelector('.toggle-btn');
      if (toggleBtn) {
        toggleBtn.dataset.enabled = String(newEnabled);
        toggleBtn.textContent = newEnabled ? 'Disable' : 'Enable';
        toggleBtn.className = `toggle-btn ${newEnabled ? 'btn-disable' : 'btn-enable'}`;
      }

      // Actually toggle via chrome.management
      toggleItem(id, enabled);
    };
  });

  wireToggleBtnsStandalone(c);
  c.querySelectorAll('[data-action="details"]').forEach(btn => {
    btn.onclick = e => { e.stopPropagation(); chrome.tabs.create({ url: `chrome://extensions/?id=${btn.dataset.id}` }); };
  });
}


// ─── Disable all extensions/apps ─────────────────────────────────────────────
async function disableAll() {
  if (!cachedData) return;
  const btn = document.getElementById('disableAllBtn');
  const enabled = cachedData.allItems.filter(i => i.enabled && i.type !== 'theme');
  if (!enabled.length) return;
  if (!confirm(`Disable all ${enabled.length} enabled extensions & apps?`)) return;
  btn.textContent = '⏳ Disabling…';
  btn.disabled = true;
  await Promise.all(enabled.map(item => new Promise(res =>
    chrome.management.setEnabled(item.id, false, res)
  )));
  cachedData.allItems.forEach(i => { if (i.type !== 'theme') i.enabled = false; });
  saveToSession();
  renderAll(cachedData);
  btn.textContent = '⛔ Disable All';
  btn.disabled = false;
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('scanBtn').addEventListener('click', runScan);
  document.getElementById('stressBtn').addEventListener('click', startStressTest);
  document.getElementById('disableAllBtn').addEventListener('click', disableAll);
  document.getElementById('deepScanBtn').addEventListener('click', startDeepScan);

  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  // Load profiles from persistent storage, then restore session data
  loadProfiles(() => {
    loadFromSession((data, stressResult) => {
      if (data) {
        cachedData = data;
        renderAll(data);
        document.getElementById('scanBtn').textContent = '🔄 Rescan';
      } else {
        runScan();
      }
      if (stressResult) {
        cachedStressResult = stressResult;
        renderStressDone(stressResult);
      }
      // Restore deep scan result
      try {
        chrome.storage.session.get(['cachedDeepResult'], r => {
          if (r.cachedDeepResult) {
            cachedDeepResult = r.cachedDeepResult;
            renderDeepScanDone(cachedDeepResult);
            document.getElementById('deepScanBtn').textContent = '🔄 Re-run Deep Scan';
          }
        });
      } catch(e) {}
      renderProfiles();
    });
  });
});
