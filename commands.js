/*
 * SW2026 G-Code Tools - ncSender v2 plugin
 *
 * Tools for G-code produced by the SolidWorks 2026 FrankenOKO post
 * processor. On G-code load, this plugin:
 *
 *   1. TOOL LIBRARY SYNC - parses the tool summary table the post
 *      processor writes at the bottom of every file (TOOL# / TOOL TYPE /
 *      DIAMETER / DESCRIPTION) and reconciles it against the ncSender
 *      Tool Library. New tools are added in one click; tools whose type,
 *      diameter, or description differ from the library are flagged as
 *      conflicts for manual resolution (never auto-overwritten).
 *
 *   2. SLOT MAPPING - once every tool is in the library, lets the user
 *      assign each one to a physical ATC magazine slot via a visual
 *      carousel, with automatic 3-step swapping when a slot is already
 *      occupied by a different tool.
 *
 *   3. G-CODE TRANSLATION - once every tool has a slot, rewrites the
 *      file's T## and H## references to the assigned slot numbers (e.g.
 *      T18 M06 -> T3 M06) so the ATC actually moves to the right
 *      physical position, then reloads the translated file.
 *
 * All three steps happen in a single dialog. The dialog opens whenever a
 * file has tool changes, even if the library is already fully in sync -
 * unlike pure library maintenance, slot translation has to happen on
 * every load for the ATC to work correctly.
 *
 * Runs in the v2 Jint sandbox via onGcodeProgramLoad. The host injects a
 * `pluginContext` global with: log(), getTools(), showDialog().
 *
 * This plugin replaces Dynamic Tool Slot Mapper. Only one of the two
 * should be enabled at a time to avoid duplicate dialogs on file load.
 */

// === Plugin settings (sanitize / defaults) ===
// No persisted user settings yet. Reserved for future SW2026 G-Code Tools
// features (tool wear compensation, etc.). Magazine size is fetched by
// the dialog itself from /api/settings.
function buildInitialConfig(raw) {
  return {};
}

// Marker comment written to the top of translated G-code. When the
// dialog's browser-side translation finishes, it uploads the transformed
// file via /api/gcode-files/load-temp - that endpoint runs plugin
// transforms again, which would re-fire this plugin in a loop. The
// marker breaks the loop: if we see it, the content is already
// translated and we bail immediately.
const SW2026_MARKER = '; ncSender-sw2026-transformed';

// === Entry point ===

function onGcodeProgramLoad(content, context, settings) {
  // Top-level try/catch is load-bearing: AOT-compiled hosts can crash hard
  // on unhandled JS exceptions. Always return original content on failure
  // (host sees a graceful fallback, user can still load the file as-is).
  try {
    if (content && content.length > 0 && content.substring(0, 80).indexOf(SW2026_MARKER) !== -1) {
      return content;
    }

    safeLog('SW2026 G-Code Tools: scanning tool table (' + Math.round(content.length / 1024) + ' KB)...');

    const gcodeTools = parseToolTable(content);
    if (gcodeTools.length === 0) {
      safeLog('No tool summary table found in this file - nothing to sync or map');
      return content;
    }

    const toolLibrary = loadToolLibrary();
    const rows = buildComparisonRows(gcodeTools, toolLibrary);
    const overall = determineOverallStatus(rows);

    safeLog('Tool check: ' + rows.length + ' tool(s) - status: ' + overall.status +
      (overall.allReady ? ' (all ready to map)' : ''));

    showUnifiedDialog(context && context.filename, context && context.sourcePath, rows, overall.status, toolLibrary);

    // Always return the original content. If the user completes mapping,
    // the dialog's own script uploads the translated file via
    // /api/gcode-files/load-temp, which replaces the cached version a
    // moment later - this function never rewrites content directly.
    return content;

  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    safeLog('[SW2026] onGcodeProgramLoad failed: ' + msg);
    return content;
  }
}

function safeLog(msg) {
  try {
    if (typeof pluginContext !== 'undefined' && pluginContext && typeof pluginContext.log === 'function') {
      pluginContext.log('[SW2026] ' + msg);
    }
  } catch (e) { /* swallow */ }
}

// === Tool library ===

function loadToolLibrary() {
  if (typeof pluginContext === 'undefined' || !pluginContext) {
    throw new Error('pluginContext is not defined — host did not inject the plugin context');
  }
  if (typeof pluginContext.getTools !== 'function') {
    throw new Error('pluginContext.getTools is not available — host needs ncSender 2.0.37+ (OSS) or 2.0.88+ (Pro)');
  }

  const tools = pluginContext.getTools();
  const library = {};
  if (!Array.isArray(tools)) return library;

  tools.forEach(function(tool) {
    const toolId = (tool.toolId !== undefined && tool.toolId !== null) ? tool.toolId : tool.id;
    if (toolId !== undefined && toolId !== null) {
      if (tool.toolId === undefined || tool.toolId === null) {
        tool.toolId = tool.id;
      }
      library[toolId] = tool;
    }
  });

  safeLog('Loaded ' + tools.length + ' tool(s) from library');
  return library;
}

// === Parse the SolidWorks 2026 post-processor tool summary table ===
//
// The FrankenOKO post writes a footer block like:
//
//   (  TOOL#     TOOL TYPE     DIAMETER   DESCRIPTION                     )
//   ( -------  --------------  --------   ------------------------------  )
//   (   018       ENDMILL       008.00    8MM CRB 4FL 20 LOC  )
//   (   021     CENTER DRILL    008.00    8MM X 90DEG CRB SPOT DRILL  )
//
// Data rows always start with "(" + a zero-padded tool number, so the
// header ("TOOL#...") and divider ("------...") rows never match this
// pattern and are skipped automatically. Fields are separated by 2+
// spaces, which is what lets a two-word type like "CENTER DRILL" (single
// internal space) stay intact while still splitting from its neighbors.
function parseToolTable(content) {
  const TABLE_ROW_RE = /^\(\s*(\d{2,4})\s{2,}([A-Z][A-Z ]*?)\s{2,}([\d.]+)\s{2,}(.+?)\s*\)\s*$/gm;
  const tools = [];
  const seen = {};
  let m;
  while ((m = TABLE_ROW_RE.exec(content)) !== null) {
    const toolNumber = parseInt(m[1], 10);
    const diameter = parseFloat(m[3]);
    if (isNaN(toolNumber) || isNaN(diameter) || seen[toolNumber]) continue;
    seen[toolNumber] = true;
    const rawType = m[2].trim();
    tools.push({
      toolNumber: toolNumber,
      type: rawType,
      mappedType: mapToolType(rawType, m[4]),
      diameter: diameter,
      description: m[4].trim()
    });
  }
  return tools;
}

// === Map SolidWorks 2026 / FrankenOKO tool types to ncSender's tool type enum ===
//
// ncSender's Tool Library only accepts: flat, ball, v-bit, drill, chamfer,
// surfacing, probe, thread-mill. SolidWorks' post-processor tool table uses
// its own vocabulary (ENDMILL, CENTER DRILL, DRILL, COUNTERSINK, ...), so
// every tool has to be translated before it's sent to /api/tools. Unmapped
// types fall back to "flat" and log a warning so it's visible in the
// ncSender log rather than failing silently or crashing the sync.
function mapToolType(rawType, description) {
  const t = (rawType || '').toUpperCase();
  const d = (description || '').toUpperCase();

  if (t.indexOf('BALL') !== -1 || d.indexOf('BALL') !== -1 || d.indexOf('BULLNOSE') !== -1) {
    return 'ball';
  }
  if (t.indexOf('V-BIT') !== -1 || t.indexOf('VBIT') !== -1 || t.indexOf('V BIT') !== -1 || d.indexOf('V-BIT') !== -1) {
    return 'v-bit';
  }
  if (t.indexOf('CHAMFER') !== -1 || t.indexOf('COUNTERSINK') !== -1) {
    return 'chamfer';
  }
  if (t.indexOf('SURFAC') !== -1) {
    return 'surfacing';
  }
  if (t.indexOf('PROBE') !== -1) {
    return 'probe';
  }
  if (t.indexOf('THREAD') !== -1) {
    return 'thread-mill';
  }
  if (t.indexOf('DRILL') !== -1) {
    return 'drill';
  }
  if (t.indexOf('ENDMILL') !== -1 || t.indexOf('END MILL') !== -1) {
    return 'flat';
  }

  safeLog('Unrecognized tool type "' + rawType + '" - defaulting to "flat". Please verify this tool in the library.');
  return 'flat';
}

// === Compare parsed tools against the library, including slot status ===

function buildComparisonRows(gcodeTools, toolLibrary) {
  return gcodeTools.map(function(gt) {
    const libTool = toolLibrary[gt.toolNumber];

    if (!libTool) {
      return Object.assign({}, gt, {
        action: 'add',
        statusClass: 'green',
        statusLabel: 'New',
        libId: null,
        libType: null,
        libDiameter: null,
        libDescription: null,
        pocketNumber: null,
        slotStatus: 'unassigned'
      });
    }

    const libType = (libTool.type || '').trim();
    const libDiameterNum = (typeof libTool.diameter === 'number') ? libTool.diameter : parseFloat(libTool.diameter);
    const libDescription = (libTool.name || '').trim();
    const pocketNumber = (libTool.toolNumber !== null && libTool.toolNumber !== undefined) ? libTool.toolNumber : null;
    const slotStatus = pocketNumber !== null ? 'assigned' : 'unassigned';

    const typeMatch = libType.toLowerCase() === gt.mappedType.toLowerCase();
    const diaMatch = !isNaN(libDiameterNum) && Math.abs(libDiameterNum - gt.diameter) < 0.005;
    const descMatch = libDescription.toUpperCase() === gt.description.toUpperCase();

    if (typeMatch && diaMatch && descMatch) {
      return Object.assign({}, gt, {
        action: 'match',
        statusClass: 'gray',
        statusLabel: 'In Sync',
        libId: libTool.id,
        libType: libType,
        libDiameter: libDiameterNum,
        libDescription: libDescription,
        pocketNumber: pocketNumber,
        slotStatus: slotStatus
      });
    }

    return Object.assign({}, gt, {
      action: 'conflict',
      statusClass: 'red',
      statusLabel: 'Conflict',
      libId: libTool.id,
      libType: libType,
      libDiameter: libDiameterNum,
      libDescription: libDescription,
      pocketNumber: pocketNumber,
      slotStatus: slotStatus
    });
  });
}

function determineOverallStatus(rows) {
  const hasConflicts = rows.some(function(r) { return r.action === 'conflict'; });
  const hasNew = rows.some(function(r) { return r.action === 'add'; });
  const hasUnassigned = rows.some(function(r) { return r.slotStatus === 'unassigned'; });

  const allReady = !hasConflicts && !hasNew && !hasUnassigned;
  const status = hasConflicts ? 'red' : ((hasNew || hasUnassigned) ? 'yellow' : 'green');

  return { status: status, allReady: allReady, hasConflicts: hasConflicts, hasNew: hasNew, hasUnassigned: hasUnassigned };
}

// === Unified dialog: sync + slot mapping + translation ===

function showUnifiedDialog(filename, sourcePath, rows, status, toolLibrary) {
  const statusConfig = {
    red: {
      color: '#dc3545', bgColor: 'rgba(220, 53, 69, 0.1)', icon: '🔴',
      title: 'Tool Library Conflicts Found',
      message: 'Some tools in this file don\'t match the ncSender Tool Library. Click "Add Tools & Auto-Assign Slots" to update them to the G-code\'s values automatically.'
    },
    yellow: {
      color: '#ffc107', bgColor: 'rgba(255, 193, 7, 0.1)', icon: '🟡',
      title: 'Tools Need Attention',
      message: 'Click "Add Tools & Auto-Assign Slots" to prepare everything at once, or use the table to add/assign individual tools. Adjust anything afterward, then click "Load".'
    },
    green: {
      color: '#28a745', bgColor: 'rgba(40, 167, 69, 0.1)', icon: '🟢',
      title: 'All Tools Ready',
      message: 'Every tool is in the library and assigned to a slot. Click "Load" to translate and run this file.'
    }
  };
  const config = statusConfig[status];

  const dialogToolLibrary = {};
  Object.keys(toolLibrary).forEach(function(key) {
    const tool = toolLibrary[key];
    const toolId = (tool.toolId !== undefined && tool.toolId !== null) ? tool.toolId : tool.id;
    dialogToolLibrary[toolId] = Object.assign({}, tool, { toolId: toolId });
  });

  const html = `
    <style>
      .sw-container {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
        color: var(--color-text-primary, #e0e0e0);
        padding: 14px 18px;
        max-width: 1180px;
        margin: 0 auto;
      }
      .sw-header {
        display: flex; align-items: center; justify-content: space-between;
        flex-wrap: wrap; gap: 8px; margin-bottom: 8px;
      }
      .sw-filename { color: var(--color-text-secondary); font-size: 0.8rem; word-break: break-all; }
      .sw-banner {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 6px 14px; border-radius: 6px; font-size: 0.9rem; font-weight: 600;
        background: ${config.bgColor}; border: 2px solid ${config.color}; color: ${config.color};
      }
      .sw-top {
        display: grid; grid-template-columns: 1fr 1.4fr; gap: 12px;
        align-items: stretch; margin-bottom: 10px;
      }
      .sw-message {
        background: var(--color-surface-muted, #1a1a1a);
        padding: 10px 14px; border-radius: 8px; line-height: 1.4; font-size: 0.85rem;
        display: flex; align-items: center;
      }
      .slot-carousel-section {
        display: flex; align-items: center; justify-content: center; gap: 5px;
        padding: 8px; background: var(--color-surface-muted, #1a1a1a);
        border-radius: 8px; flex-wrap: nowrap;
      }
      .slot-carousel-loading { color: var(--color-text-secondary, #999); font-size: 0.8rem; font-style: italic; }
      .slot-box {
        display: flex; flex-direction: column; align-items: center;
        min-width: 0; flex: 1 1 0; height: 44px;
        background: var(--color-surface, #0a0a0a);
        border: 2px solid var(--color-border, #444);
        border-radius: 5px; overflow: hidden; flex-shrink: 0;
      }
      .slot-box--used { background: var(--color-accent, #1abc9c); border-color: var(--color-accent, #1abc9c); }
      .slot-box--unused { background: var(--color-surface-muted, #2a2a2a); border-color: var(--color-border, #444); opacity: 0.5; }
      .slot-box-content { display: flex; align-items: center; justify-content: center; flex: 1; width: 100%; padding: 0 4px; }
      .slot-tool-id { font-size: 0.85rem; font-weight: 700; color: #fff; }
      .slot-empty { font-size: 1rem; color: var(--color-text-secondary, #666); }
      .slot-box-label {
        font-size: 0.55rem; font-weight: 700; text-transform: uppercase;
        color: var(--color-text-secondary, #999); background: var(--color-surface-muted, #1a1a1a);
        width: 100%; text-align: center; padding: 1px 0; letter-spacing: 0.02em;
      }
      .slot-box--used .slot-box-label { background: color-mix(in srgb, var(--color-accent, #1abc9c) 80%, #000); color: rgba(255,255,255,0.95); }
      .tools-table-container {
        border: 1px solid var(--color-border, #444); border-radius: 8px; margin-bottom: 10px;
      }
      .tools-table { width: 100%; border-collapse: collapse; }
      .tools-table thead { background: var(--color-surface-muted, #1a1a1a); }
      .tools-table th { padding: 5px 10px; text-align: left; font-weight: 600; border-bottom: 2px solid var(--color-border, #444); font-size: 0.75rem; }
      .tools-table td { padding: 4px 10px; border-bottom: 1px solid var(--color-border, #333); vertical-align: middle; font-size: 0.82rem; }
      .tools-table tbody tr:hover { background: var(--color-border, #2a2a2a); }
      .gcode-cell { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 1px; }
      .row-status-badge {
        display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.68rem;
        font-weight: 600; text-transform: uppercase; border: 1px solid transparent; white-space: nowrap;
      }
      .row-status-badge--green { background: rgba(40,167,69,0.2); color: #28a745; border-color: #28a745; }
      .row-status-badge--gray { background: rgba(153,153,153,0.15); color: #999; border-color: #666; }
      .row-status-badge--red { background: rgba(220,53,69,0.2); color: #dc3545; border-color: #dc3545; }
      .tool-num { font-weight: 700; font-size: 0.9rem; }
      .conflict-diff { margin-top: 2px; font-size: 0.7rem; line-height: 1.3; }
      .conflict-diff .lib-val { color: #f59e0b; }
      .conflict-diff .gcode-val { color: #1abc9c; }
      .btn { padding: 9px 18px; border: none; border-radius: 6px; font-size: 0.9rem; font-weight: 600; cursor: pointer; transition: all 0.2s; }
      .btn:disabled { opacity: 0.5; cursor: default; }
      .btn-primary { background: var(--color-accent, #1abc9c); color: white; }
      .btn-primary:hover { opacity: 0.9; }
      .btn-secondary { background: var(--color-surface-muted, #2a2a2a); color: var(--color-text-primary); border: 1px solid var(--color-border, #444); }
      .btn-secondary:hover { background: var(--color-border, #444); }
      .slot-cell {
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        min-width: 60px; cursor: pointer; user-select: none;
      }
      .slot-cell:hover { opacity: 0.8; }
      .slot-cell-placeholder { font-size: 0.65rem; color: #f59e0b; font-weight: 600; }
      .actions { display: flex; gap: 10px; justify-content: center; margin-top: 10px; flex-wrap: wrap; }
      .slot-selector-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 99998; display: none; }
      .slot-selector-overlay.show { display: block; }
      .slot-selector-popup {
        position: fixed; background: var(--color-surface, #2a2a2a); border: 1px solid var(--color-border, #444);
        border-radius: 6px; box-shadow: 0 8px 24px rgba(0,0,0,0.4); min-width: 200px; max-height: 300px;
        display: flex; flex-direction: column; z-index: 99999;
      }
      .slot-selector-header { padding: 10px 12px; font-size: 0.85rem; font-weight: 600; color: var(--color-text-secondary, #999); border-bottom: 1px solid var(--color-border, #444); flex-shrink: 0; }
      .slot-selector-list { overflow-y: auto; flex: 1; }
      .slot-selector-item { padding: 8px 12px; font-size: 0.85rem; color: var(--color-text-primary, #e0e0e0); cursor: pointer; transition: background 0.1s ease; }
      .slot-selector-item:hover { background: var(--color-surface-muted, #1a1a1a); }
      .slot-selector-item--active { background: var(--color-accent, #1abc9c); color: white; }
      .slot-selector-item--active:hover { background: var(--color-accent, #1abc9c); }
      .slot-selector-item--occupied { color: #f59e0b; }
      .slot-selector-item--disabled { color: var(--color-text-secondary, #666); cursor: not-allowed; }
    </style>

    <div class="sw-container">
      <div class="sw-header">
        <div class="sw-filename">${filename || 'G-Code File'}</div>
        <div class="sw-banner" id="swBanner">
          <span id="swIcon">${config.icon}</span>
          <span id="swTitle">${config.title}</span>
        </div>
      </div>

      <div class="sw-top">
        <div class="sw-message" id="swMessage">${config.message}</div>
        <div id="slotCarousel" class="slot-carousel-section">
          <span class="slot-carousel-loading">Loading slots…</span>
        </div>
      </div>

      <div class="tools-table-container">
        <table class="tools-table">
          <thead>
            <tr>
              <th>Tool #</th>
              <th>G-Code Data</th>
              <th>Sync Status</th>
              <th>Slot</th>
            </tr>
          </thead>
          <tbody id="toolsTableBody"></tbody>
        </table>
      </div>

      <div class="actions">
        <button id="prepareBtn" class="btn btn-secondary" disabled>Add Tools &amp; Auto-Assign Slots</button>
        <button id="mapBtn" class="btn btn-primary" disabled>Load</button>
        <button id="bypassBtn" class="btn btn-secondary">Bypass</button>
      </div>
    </div>

    <div id="slotSelectorOverlay" class="slot-selector-overlay">
      <div id="slotSelectorPopup" class="slot-selector-popup">
        <div class="slot-selector-header">Assign to Slot</div>
        <div class="slot-selector-list" id="slotSelectorList"></div>
      </div>
    </div>

    <script>
      (function() {
        const rows = ${JSON.stringify(rows)};
        const toolLibrary = ${JSON.stringify(dialogToolLibrary)};
        const sourcePath = ${JSON.stringify(sourcePath || '')};
        const filename = ${JSON.stringify(filename || 'translated.gcode')};
        let magazineSize = 0;
        let currentSlotRow = null;

        const overlay = document.getElementById('slotSelectorOverlay');
        const popup = document.getElementById('slotSelectorPopup');
        const listContainer = document.getElementById('slotSelectorList');
        const carousel = document.getElementById('slotCarousel');

        function escapeHtml(s) {
          return String(s === null || s === undefined ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }

        function fetchMagazineSize() {
          return fetch('/api/settings')
            .then(function(r) { return r.ok ? r.json() : null; })
            .then(function(s) { return (s && s.tool && typeof s.tool.count === 'number') ? s.tool.count : 8; })
            .catch(function() { return 8; });
        }

        function currentStatus() {
          const hasConflicts = rows.some(function(r) { return r.action === 'conflict'; });
          const hasNew = rows.some(function(r) { return r.action === 'add'; });
          const hasUnassigned = rows.some(function(r) { return r.slotStatus === 'unassigned'; });
          const hasAssignable = rows.some(function(r) { return r.action !== 'add' && r.slotStatus === 'unassigned'; });
          const hasPrepareWork = hasNew || hasAssignable || hasConflicts;
          const allReady = !hasConflicts && !hasNew && !hasUnassigned;
          const status = hasConflicts ? 'red' : ((hasNew || hasUnassigned) ? 'yellow' : 'green');
          return { status: status, allReady: allReady, hasNew: hasNew, hasAssignable: hasAssignable, hasPrepareWork: hasPrepareWork };
        }

        function renderCarousel() {
          const usedToolNumbers = new Set(rows.map(function(r) { return r.toolNumber; }));
          let html = '';
          for (let i = 1; i <= magazineSize; i++) {
            const rowInSlot = rows.find(function(r) { return r.pocketNumber === i; });
            const toolInSlot = Object.values(toolLibrary).find(function(t) { return t.toolNumber === i; });

            let displayId = null;
            if (rowInSlot) displayId = rowInSlot.toolNumber;
            else if (toolInSlot) displayId = toolInSlot.toolId;

            const isUsed = rowInSlot ? usedToolNumbers.has(rowInSlot.toolNumber) : false;
            const cls = displayId !== null ? (isUsed ? 'slot-box--used' : 'slot-box--unused') : '';
            const content = displayId !== null
              ? '<span class="slot-tool-id">#' + displayId + '</span>'
              : '<span class="slot-empty">—</span>';

            html += '<div class="slot-box ' + cls + '">' +
                      '<div class="slot-box-content">' + content + '</div>' +
                      '<div class="slot-box-label">SLOT' + i + '</div>' +
                    '</div>';
          }
          carousel.innerHTML = html;
        }

        function renderTable() {
          const tbody = document.getElementById('toolsTableBody');
          tbody.innerHTML = rows.map(function(r, idx) {
            const gcodeCell = '<strong>' + escapeHtml(r.mappedType) + '</strong> <span style="opacity:0.6">(' + escapeHtml(r.type) + ')</span> — ' +
              r.diameter.toFixed(2) + ' mm — ' + escapeHtml(r.description);

            let syncCell = '<span class="row-status-badge row-status-badge--' + r.statusClass + '">' +
              escapeHtml(r.statusLabel) + '</span>';

            if (r.action === 'conflict') {
              // No user choice here - conflicts are always auto-resolved
              // using the G-code's values when "Add Tools & Auto-Assign
              // Slots" runs. This is purely informational so the user can
              // see what's about to change.
              syncCell += '<div class="conflict-diff">' +
                '<div class="lib-val">Library: ' + escapeHtml(r.libType) + ' — ' +
                  (r.libDiameter !== null ? r.libDiameter.toFixed(2) : '?') + ' mm — ' + escapeHtml(r.libDescription) + '</div>' +
                '<div class="gcode-val">Will use: ' + escapeHtml(r.mappedType) + ' — ' + r.diameter.toFixed(2) + ' mm — ' + escapeHtml(r.description) + '</div>' +
              '</div>';
            }

            let slotCell;
            if (r.action === 'add') {
              slotCell = '<div class="slot-cell-placeholder">Add tool first</div>';
            } else if (r.pocketNumber !== null && r.pocketNumber !== undefined) {
              slotCell = '<div class="slot-cell" data-slot-idx="' + idx + '"><span class="tool-num">SLOT' + r.pocketNumber + '</span></div>';
            } else {
              slotCell = '<div class="slot-cell" data-slot-idx="' + idx + '"><span class="slot-cell-placeholder">Assign Slot</span></div>';
            }

            return '<tr><td class="tool-num">' + r.toolNumber + '</td><td class="gcode-cell">' + gcodeCell + '</td><td>' + syncCell + '</td><td>' + slotCell + '</td></tr>';
          }).join('');
        }

        function updateBanner() {
          const cfg = {
            red: { color: '#dc3545', bg: 'rgba(220,53,69,0.1)', icon: '🔴', title: 'Tool Library Conflicts Found', msg: 'Some tools in this file don\\'t match the ncSender Tool Library. Click "Add Tools & Auto-Assign Slots" to update them to the G-code\\'s values automatically.' },
            yellow: { color: '#ffc107', bg: 'rgba(255,193,7,0.1)', icon: '🟡', title: 'Tools Need Attention', msg: 'Click "Add Tools & Auto-Assign Slots" to prepare everything at once, or use the table to add/assign individual tools. Adjust anything afterward, then click "Load".' },
            green: { color: '#28a745', bg: 'rgba(40,167,69,0.1)', icon: '🟢', title: 'All Tools Ready', msg: 'Every tool is in the library and assigned to a slot. Click "Load" to translate and run this file.' }
          };
          const s = currentStatus();
          const c = cfg[s.status];

          const banner = document.getElementById('swBanner');
          banner.style.background = c.bg;
          banner.style.borderColor = c.color;
          banner.style.color = c.color;
          document.getElementById('swIcon').textContent = c.icon;
          document.getElementById('swTitle').textContent = c.title;
          document.getElementById('swMessage').textContent = c.msg;

          document.getElementById('prepareBtn').disabled = !s.hasPrepareWork;
          document.getElementById('mapBtn').disabled = !s.allReady;
        }

        // === Slot selector popup (adapted from Dynamic Tool Slot Mapper) ===

        function showSlotSelector(row, event) {
          currentSlotRow = row;

          let html = '';
          for (let i = 1; i <= magazineSize; i++) {
            const occupyingRow = rows.find(function(r) { return r.pocketNumber === i && r.toolNumber !== row.toolNumber; });
            const isActive = row.pocketNumber === i;
            let occupiedInfo = '';
            if (occupyingRow) occupiedInfo = ' (Swap with #' + occupyingRow.toolNumber + ')';

            html += '<div class="slot-selector-item ' + (isActive ? 'slot-selector-item--active' : '') + ' ' + (occupyingRow ? 'slot-selector-item--occupied' : '') + '" data-slot="' + i + '">' +
                      'Slot' + i + occupiedInfo +
                    '</div>';
          }
          listContainer.innerHTML = html;

          const rect = event.target.closest('.slot-cell').getBoundingClientRect();
          popup.style.top = (rect.bottom + 5) + 'px';
          popup.style.left = rect.left + 'px';
          overlay.classList.add('show');
        }

        function closeSlotSelector() {
          overlay.classList.remove('show');
          currentSlotRow = null;
        }

        async function selectSlot(slotNumber) {
          if (!currentSlotRow) return;
          const row = currentSlotRow;
          const oldSlot = row.pocketNumber;
          closeSlotSelector();

          if (slotNumber === oldSlot) return;

          try {
            const occupyingRow = rows.find(function(r) { return r.pocketNumber === slotNumber && r.toolNumber !== row.toolNumber; });

            if (occupyingRow) {
              const occupyingLibTool = toolLibrary[occupyingRow.toolNumber];
              const thisLibTool = toolLibrary[row.toolNumber];

              await fetch('/api/tools/' + occupyingLibTool.id, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(Object.assign({}, occupyingLibTool, { toolNumber: null }))
              });
              await fetch('/api/tools/' + thisLibTool.id, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(Object.assign({}, thisLibTool, { toolNumber: slotNumber }))
              });
              if (oldSlot !== null && oldSlot !== undefined) {
                await fetch('/api/tools/' + occupyingLibTool.id, {
                  method: 'PUT', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(Object.assign({}, occupyingLibTool, { toolNumber: oldSlot }))
                });
              }
            } else {
              const thisLibTool = toolLibrary[row.toolNumber];
              await fetch('/api/tools/' + thisLibTool.id, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(Object.assign({}, thisLibTool, { toolNumber: slotNumber }))
              });
            }

            await new Promise(function(resolve) { setTimeout(resolve, 100); });
            await refreshFromServer();
          } catch (err) {
            alert('Failed to assign slot: ' + (err && err.message ? err.message : err));
          }
        }

        // === Refresh library state from server after any change ===

        async function refreshFromServer() {
          try {
            const r = await fetch('/api/tools');
            if (!r.ok) return;
            const tools = await r.json();

            for (const k in toolLibrary) delete toolLibrary[k];
            tools.forEach(function(t) {
              const tid = (t.toolId !== undefined && t.toolId !== null) ? t.toolId : t.id;
              if (tid !== undefined && tid !== null) {
                toolLibrary[tid] = Object.assign({}, t, { toolId: tid });
              }
            });

            rows.forEach(function(row) {
              const libTool = toolLibrary[row.toolNumber];
              if (!libTool) {
                row.action = 'add';
                row.statusClass = 'green';
                row.statusLabel = 'New';
                row.libId = null; row.libType = null; row.libDiameter = null; row.libDescription = null;
                row.pocketNumber = null; row.slotStatus = 'unassigned';
                return;
              }

              const libType = (libTool.type || '').trim();
              const libDiameterNum = (typeof libTool.diameter === 'number') ? libTool.diameter : parseFloat(libTool.diameter);
              const libDescription = (libTool.name || '').trim();
              const pocketNumber = (libTool.toolNumber !== null && libTool.toolNumber !== undefined) ? libTool.toolNumber : null;

              row.libId = libTool.id;
              row.libType = libType;
              row.libDiameter = libDiameterNum;
              row.libDescription = libDescription;
              row.pocketNumber = pocketNumber;
              row.slotStatus = pocketNumber !== null ? 'assigned' : 'unassigned';

              const typeMatch = libType.toLowerCase() === row.mappedType.toLowerCase();
              const diaMatch = !isNaN(libDiameterNum) && Math.abs(libDiameterNum - row.diameter) < 0.005;
              const descMatch = libDescription.toUpperCase() === row.description.toUpperCase();

              if (typeMatch && diaMatch && descMatch) {
                row.action = 'match'; row.statusClass = 'gray'; row.statusLabel = 'In Sync';
              } else {
                row.action = 'conflict'; row.statusClass = 'red'; row.statusLabel = 'Conflict';
              }
            });

            renderCarousel();
            renderTable();
            updateBanner();
          } catch (e) {
            // ignore refresh failures - user can retry
          }
        }

        // === Conflict resolution + slot cell clicks ===

        document.getElementById('toolsTableBody').addEventListener('click', function(e) {
          const slotCell = e.target.closest('.slot-cell');
          if (slotCell) {
            const idx = parseInt(slotCell.getAttribute('data-slot-idx'), 10);
            const row = rows[idx];
            if (row) showSlotSelector(row, e);
          }
        });

        overlay.addEventListener('click', closeSlotSelector);
        popup.addEventListener('click', function(e) { e.stopPropagation(); });
        listContainer.addEventListener('click', function(e) {
          const item = e.target.closest('.slot-selector-item');
          if (item) selectSlot(parseInt(item.getAttribute('data-slot'), 10));
        });

        // === Add new tools to library ===

        // === Auto-Assign Slots ===
        //
        // Fills every tool that's in the library but has no magazine slot
        // yet. If the magazine doesn't have enough empty slots, tools
        // currently occupying a slot but NOT used anywhere in this G-code
        // file are evicted (their slot cleared) to make room - tools that
        // this file actually needs are never evicted. The user is shown a
        // confirmation listing exactly what will be evicted before anything
        // happens, since this reassigns physical ATC positions that may be
        // in use by other jobs.

        // === Step 1: Add every "New" tool to the library ===
        async function addNewToolsToLibrary() {
          const newRows = rows.filter(function(r) { return r.action === 'add'; });
          let failures = 0;
          let firstError = null;

          for (const row of newRows) {
            try {
              const res = await fetch('/api/tools', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  toolId: row.toolNumber, type: row.mappedType, diameter: row.diameter,
                  name: row.description, toolNumber: null
                })
              });
              if (!res.ok) {
                failures++;
                if (!firstError) firstError = await res.text().catch(function() { return res.statusText; });
              }
            } catch (err) {
              failures++;
              if (!firstError) firstError = err && err.message ? err.message : String(err);
            }
          }

          return { failures: failures, firstError: firstError };
        }

        // === Step 2: Auto-resolve every conflict using the G-code's values ===
        //
        // No user choice here by design - conflicts always resolve to the
        // G-code's type/diameter/description. The table still shows the
        // library-vs-G-code diff for transparency before this runs.
        async function resolveConflictsWithGcode() {
          const conflictRows = rows.filter(function(r) { return r.action === 'conflict'; });
          let failures = 0;
          let firstError = null;

          for (const row of conflictRows) {
            const rawLibTool = toolLibrary[row.toolNumber] || {};
            try {
              const res = await fetch('/api/tools/' + row.libId, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(Object.assign({}, rawLibTool, {
                  type: row.mappedType, diameter: row.diameter, name: row.description
                }))
              });
              if (!res.ok) {
                failures++;
                if (!firstError) firstError = await res.text().catch(function() { return res.statusText; });
              }
            } catch (err) {
              failures++;
              if (!firstError) firstError = err && err.message ? err.message : String(err);
            }
          }

          return { failures: failures, firstError: firstError };
        }

        // === Step 3: Auto-assign every library tool that still has no slot ===
        //
        // If the magazine doesn't have enough empty slots, tools currently
        // occupying a slot but NOT used anywhere in this G-code file are
        // evicted (their slot cleared, not deleted from the library) to make
        // room - tools this file actually needs are never evicted. Shows a
        // confirmation listing exactly what will be evicted before anything
        // happens, since this reassigns physical ATC positions that may be
        // in use by other jobs. Returns null if the user cancels at that
        // confirmation (distinct from {failures: 0}, which means it ran
        // cleanly with nothing to fix).
        async function autoAssignSlots() {
          const needed = rows.filter(function(r) { return r.action !== 'add' && r.slotStatus === 'unassigned'; });
          if (needed.length === 0) return { failures: 0, firstError: null };

          const usedInFile = new Set(rows.map(function(r) { return r.toolNumber; }));

          const occupiedBy = {}; // slot -> library tool object
          Object.values(toolLibrary).forEach(function(t) {
            if (t.toolNumber !== null && t.toolNumber !== undefined) {
              occupiedBy[t.toolNumber] = t;
            }
          });

          const emptySlots = [];
          for (let i = 1; i <= magazineSize; i++) {
            if (!occupiedBy[i]) emptySlots.push(i);
          }

          const deficit = needed.length - emptySlots.length;
          let evictionCandidates = [];
          if (deficit > 0) {
            evictionCandidates = Object.keys(occupiedBy)
              .map(function(s) { return parseInt(s, 10); })
              .filter(function(slot) { return !usedInFile.has(occupiedBy[slot].toolId); })
              .sort(function(a, b) { return a - b; })
              .slice(0, deficit);

            if (evictionCandidates.length > 0) {
              const evictionList = evictionCandidates.map(function(slot) {
                return 'Slot ' + slot + ' (tool #' + occupiedBy[slot].toolId + ')';
              }).join(', ');
              const proceed = confirm(
                'Not enough empty slots for all tools in this file.\\n\\n' +
                'To make room, these slots will be cleared (tools removed from their slot, not deleted from the library):\\n' +
                evictionList +
                '\\n\\nContinue?'
              );
              if (!proceed) return null;
            }
          }

          let failures = 0;
          let firstError = null;

          for (const slot of evictionCandidates) {
            const evictTool = occupiedBy[slot];
            try {
              const res = await fetch('/api/tools/' + evictTool.id, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(Object.assign({}, evictTool, { toolNumber: null }))
              });
              if (res.ok) {
                emptySlots.push(slot);
              } else {
                failures++;
                if (!firstError) firstError = await res.text().catch(function() { return res.statusText; });
              }
            } catch (err) {
              failures++;
              if (!firstError) firstError = err && err.message ? err.message : String(err);
            }
          }

          emptySlots.sort(function(a, b) { return a - b; });

          const sortedNeeded = needed.slice().sort(function(a, b) { return a.toolNumber - b.toolNumber; });
          let ranOutOfSlots = false;
          for (const row of sortedNeeded) {
            const slot = emptySlots.shift();
            if (slot === undefined) { ranOutOfSlots = true; break; }

            const libTool = toolLibrary[row.toolNumber];
            if (!libTool) { failures++; continue; }

            try {
              const res = await fetch('/api/tools/' + libTool.id, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(Object.assign({}, libTool, { toolNumber: slot }))
              });
              if (!res.ok) {
                failures++;
                if (!firstError) firstError = await res.text().catch(function() { return res.statusText; });
              }
            } catch (err) {
              failures++;
              if (!firstError) firstError = err && err.message ? err.message : String(err);
            }
          }

          return { failures: failures, firstError: firstError, ranOutOfSlots: ranOutOfSlots };
        }

        // === Combined "Add Tools & Auto-Assign Slots" button ===
        //
        // Runs both steps back to back: add every new tool to the library,
        // then auto-assign a slot to everything that still needs one
        // (including the tools just added). After this runs, the table
        // still reflects live state, so the user can manually tweak
        // anything (resolve a conflict, reassign a specific slot) before
        // clicking "Load".
        document.getElementById('prepareBtn').addEventListener('click', async function() {
          const prepareBtn = document.getElementById('prepareBtn');
          prepareBtn.disabled = true;
          prepareBtn.textContent = 'Adding tools…';

          const addResult = await addNewToolsToLibrary();
          await refreshFromServer();

          prepareBtn.textContent = 'Resolving conflicts…';
          const conflictResult = await resolveConflictsWithGcode();
          await refreshFromServer();

          prepareBtn.textContent = 'Assigning slots…';
          const assignResult = await autoAssignSlots();
          await refreshFromServer();

          prepareBtn.textContent = 'Add Tools & Auto-Assign Slots';

          const totalFailures = addResult.failures + conflictResult.failures + (assignResult ? assignResult.failures : 0);
          const firstError = addResult.firstError || conflictResult.firstError || (assignResult && assignResult.firstError);

          if (assignResult && assignResult.ranOutOfSlots) {
            alert('The magazine doesn\\'t have enough slots for every tool in this file, even after freeing unused slots. Assign the remaining tool(s) manually.');
          } else if (totalFailures > 0) {
            alert(totalFailures + ' step(s) failed.' + (firstError ? '\\n\\nFirst error: ' + firstError : ' Check the ncSender log for details.'));
          }
        });

        // === Bypass ===

        document.getElementById('bypassBtn').addEventListener('click', function() {
          window.parent.postMessage({ type: 'close-plugin-dialog', data: { action: 'bypass' } }, '*');
        });

        // === Load: browser-side G-code translation ===
        //
        // Bypasses Jint's 50 MB memory cap on large files by doing the
        // regex translation in the browser instead of the plugin sandbox.
        function performTranslationInBrowser(content, toolToSlot) {
          return content.replace(/^[^\\n]*(?:M0*6|T\\d|H\\d)[^\\n]*$/gmi, function(line) {
            if (!line) return line;
            const trimmed = line.trim();
            if (!trimmed) return line;
            const firstChar = trimmed.charAt(0);

            if (firstChar === '(' || firstChar === ';') {
              const m = line.match(/T(\\d+)/i);
              if (m) {
                const toolNumber = parseInt(m[1], 10);
                const pocket = toolToSlot[toolNumber];
                if (pocket !== undefined) {
                  return line.replace(/T(\\d+)/i, function(_, num) {
                    return 'T' + pocket + ' [Original: tool ' + num + ']';
                  });
                }
              }
              return line;
            }

            let out = line;
            const tm = line.match(/T(\\d+)/i);
            if (tm) {
              const toolNumber = parseInt(tm[1], 10);
              const pocket = toolToSlot[toolNumber];
              if (pocket !== undefined) out = out.replace(/T\\d+/i, 'T' + pocket);
            }
            const hm = out.match(/H(\\d+)/i);
            if (hm) {
              const heightNumber = parseInt(hm[1], 10);
              const pocket = toolToSlot[heightNumber];
              if (pocket !== undefined) out = out.replace(/H\\d+/i, 'H' + pocket);
            }
            return out;
          });
        }

        document.getElementById('mapBtn').addEventListener('click', async function() {
          const mapBtn = document.getElementById('mapBtn');
          const prepareBtn = document.getElementById('prepareBtn');
          const bypassBtn = document.getElementById('bypassBtn');
          mapBtn.disabled = true; prepareBtn.disabled = true; bypassBtn.disabled = true;
          mapBtn.textContent = 'Loading…';

          try {
            let content;
            if (sourcePath) {
              const r = await fetch('/api/gcode-files/file?path=' + encodeURIComponent(sourcePath));
              if (!r.ok) throw new Error('Failed to fetch source file: HTTP ' + r.status);
              const data = await r.json();
              content = data.content;
            } else {
              const r = await fetch('/api/gcode-files/current/download');
              if (!r.ok) throw new Error('Failed to download G-code: HTTP ' + r.status);
              content = await r.text();
            }

            const toolToSlot = {};
            rows.forEach(function(r) {
              if (r.pocketNumber !== null && r.pocketNumber !== undefined) {
                toolToSlot[r.toolNumber] = r.pocketNumber;
              }
            });

            const transformed = '${SW2026_MARKER}\\n' + performTranslationInBrowser(content, toolToSlot);

            const payload = { content: transformed, filename: filename, sourceFile: sourcePath || null };
            const delays = [0, 250, 500, 1000, 2000, 4000];
            function attempt(i) {
              fetch('/api/gcode-files/load-temp', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
              }).then(function(r) {
                if (r.ok) return;
                if (i + 1 < delays.length) setTimeout(function() { attempt(i + 1); }, delays[i + 1]);
                else console.error('[SW2026 dialog] load-temp failed after retries: HTTP ' + r.status);
              }).catch(function(err) {
                if (i + 1 < delays.length) setTimeout(function() { attempt(i + 1); }, delays[i + 1]);
                else console.error('[SW2026 dialog] load-temp failed after retries:', err);
              });
            }
            setTimeout(function() { attempt(0); }, delays[0]);

            window.parent.postMessage({ type: 'close-plugin-dialog', data: { action: 'map' } }, '*');
          } catch (err) {
            mapBtn.disabled = false; prepareBtn.disabled = !currentStatus().hasPrepareWork; bypassBtn.disabled = false;
            mapBtn.textContent = 'Load';
            alert('Translation failed: ' + (err && err.message ? err.message : err));
          }
        });

        // === Init ===
        renderTable();
        updateBanner();
        fetchMagazineSize().then(function(size) {
          magazineSize = size;
          renderCarousel();
        });
      })();
    <\/script>
  `;

  if (typeof pluginContext.showDialog !== 'function') {
    throw new Error('pluginContext.showDialog is not available — host needs ncSender 2.0.37+ (OSS) or 2.0.88+ (Pro)');
  }

  const response = pluginContext.showDialog('SW2026 G-Code Tools (Tool Library & Slot Mapping)', html, { closable: false });

  if (response && response.action) {
    return response;
  }
  return { action: 'bypass' };
}
