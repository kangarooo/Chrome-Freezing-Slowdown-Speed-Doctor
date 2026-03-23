# Chrome-Freezing-Slowdown-Speed-Doctor


![License: Proprietary](https://img.shields.io/badge/License-Proprietary-red.svg)

## License

Copyright (c) 2026 [Jānis Ķengurs]. All rights reserved.

This software and its source code are proprietary and confidential.
Unauthorized copying, modification, distribution, sublicensing, or
commercial use of this software, in whole or in part, is strictly
prohibited without prior written permission from the copyright owner.

For licensing or partnership inquiries, contact: [kangarooo@gmail.com]


# Chrome Speed Doctor

**Find what's slowing your browser — real per-process CPU, RAM, extension impact, tab heap usage, and more.**

A Chrome extension that gives you a real-time and on-demand view of what every extension, app, and tab is actually costing your system. Built for power users who want Chrome Task Manager–level data without leaving the browser.

---

## Features

### 📡 Live Monitor
Real-time CPU and JS heap per open tab, updated every 2 seconds via Chrome DevTools Protocol (CDP). Shows a system-wide CPU and RAM bar plus per-process rows sorted by CPU usage.

> **Note:** MV3 extensions (service workers) cannot be attached to by external debuggers — Chrome enforces a one-debugger-per-target limit and holds that slot internally. MV2 extensions with HTML background pages are fully measurable. Tabs are always measurable.

### 🔬 20-Second Stress Test
Runs a scripted workload (baseline → open tab → load google.com → cooldown) while sampling system CPU and RAM every second. Uses CDP `Performance.getMetrics` to get real `ProcessCPUTime`, `TaskDuration`, and `ScriptDuration` deltas per extension background process — the same data source Chrome Task Manager uses.

### 🔬 Deep Scan
The only reliable way to measure RAM cost per extension. Disables each extension one-by-one, reloads a test page, measures JS heap and page load time, then re-enables. The delta is that extension's true cost. Takes ~5–6 seconds per extension.

### 🩺 Diagnosis
Scores your Chrome setup 0–100 based on CPU load, RAM pressure, tab count, extension count, risky permissions, duplicate ad blockers, and high-heap tabs. Gives actionable issue cards.

### 💾 Profiles
Save your current extension enable/disable state as a named profile. Apply profiles with one click to switch between setups (e.g. Work, Gaming, Writing). Per-extension toggles inside each profile let you customize before applying. Profiles persist across browser restarts.

### 🔍 Search / Dashboard
All extensions and Chrome apps in a searchable card list, sorted by impact score (enabled first). Click any card to toggle it on/off. Impact score combines permission weight + measured data from the stress test.

### 📊 Resources
System RAM usage with free/used breakdown, per-tab JS heap sorted by size, CPU usage with core count.

### 🗂️ Tabs
All open tabs with JS heap usage, sorted by memory. Flags active, pinned, audible, and discarded tabs.

### 🔐 Permissions
Risky permission audit across all extensions and apps. Flags `webRequest`, `<all_urls>`, background access, native messaging, history, and cookies. Per-item breakdown with disable buttons.

### 🧩 All Items
Full list of every enabled and disabled extension and app with impact scores, permission tags, and disable/enable controls.

---

## Installation (Developer Mode)

Until published to the Chrome Web Store:

1. Download and unzip the release
2. Open `chrome://extensions`
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked** and select the `chrome-perf-extension` folder
5. Pin the extension from the toolbar for quick access

---

## Permissions

| Permission | Why it's needed |
|---|---|
| `tabs` | Read tab URLs, titles, and status |
| `management` | List, enable, and disable extensions and apps |
| `system.memory` | Read system RAM usage |
| `system.cpu` | Read system CPU usage |
| `scripting` | Inject scripts into tabs to measure JS heap |
| `storage` | Persist profiles and cached scan results |
| `debugger` | Attach CDP sessions for real per-process CPU measurement (Live Monitor, Stress Test) |
| `<all_urls>` (host) | Required by `scripting` to measure tabs on any URL |

The `debugger` permission is what causes Chrome to show the **"Speed Doctor is debugging this browser"** yellow bar. This bar appears only while the Live Monitor tab is open or a Stress Test is running. It disappears automatically when you leave those views.

---

## Version History

| Version | Name | What changed |
|---|---|---|
| v1.0 | First Blood | Basic CPU/RAM scan, extensions list, tabs, permissions |
| v1.1 | Heap Hunter | Per-tab JS heap via content script injection |
| v1.2 | Stress Monkey | 20-second stress test with sparkline chart |
| v1.3 | Dashboard | Search tab — card layout, click-to-toggle, stable sort |
| v1.4 | CDP Spy | Real per-process CPU via CDP in stress test |
| v1.5 | Profile Manager | Extension profiles, Disable All, wider popup (660px) |
| v1.6 | Deep Dive | Differential RAM/load-time scan per extension |
| v1.7 | Live Wire | 📡 Live tab — real-time per-process CPU + heap via CDP |
| v1.7.1 | Fast Connect | Live monitor startup: parallel attach, first tick in <1s |
| v1.7.2 | Target Fixed | Service worker target discovery, all extensions shown |
| v1.7.3 | No Noise | CDP `lastError` spam fixed, stale target handling |
| v1.7.4 | Debug Light | Debug targets button, icon fetch attempt |
| v1.7.5 | Icon Fix | `chrome://extension-icon/` approach (later reverted) |
| v1.8.0 | Clean Slate | Icons restored, live monitor CDP logging improved |
| v1.8.1 | Reality Check | MV3 SW limitation documented, Live tab explains what's measurable |
| v1.8.2 | Button Fix | Missing `stressPort`/`stressRunning` declarations restored |
| v1.8.3 | Stress Toggle | Stress test card row click-to-toggle, enable/disable button fixed |
| v1.8.4 | Toggle Fix | Deep scan row click-to-toggle, all panel buttons update in-place |

---

## Technical Notes

### Why MV3 service workers can't be measured
Chrome enforces a **one-debugger-per-target** limit. Chrome's internal DevTools infrastructure permanently holds the debugger slot for all MV3 extension service workers. External extensions using `chrome.debugger.attach()` get "Another debugger is already attached." This is a deliberate security boundary, not a bug. The Deep Scan workaround (differential disable/reload/measure) bypasses this entirely.

### How CDP CPU measurement works
`chrome.debugger.attach({ tabId })` → `Performance.enable({ timeDomain: 'threadTicks' })` → `Performance.getMetrics()`. The `ProcessCPUTime` metric gives cumulative CPU time in seconds for that renderer process. Two samples 2 seconds apart → delta / 2000ms × 100 = CPU%. This is identical to what Chrome Task Manager shows.

### Impact score formula
`permScore` = weighted sum of permissions (webRequest +30, `<all_urls>` +25, background +15, etc.)
`measuredScore` = from CDP data (CPU time, task time, script time) + content script injection timing
`totalScore` = permScore + measuredScore

---

## License

MIT
