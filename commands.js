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
      // Already processed (tool sync + slot translation already ran) -
      // this only exists as a loop guard against load-temp re-firing this
      // same plugin. Tool Wear Compensation is NOT triggered from here:
      // an earlier attempt tried reopening it by reloading the same file
      // and detecting this marker, but clicking a file in ncSender's file
      // browser reads fresh from disk, which never had the marker written
      // to it (load-temp only ever produced an in-memory/cached version) -
      // so reloading actually fired onGcodeProgramLoad twice from two
      // separate sources (the on-disk original, and whatever ncSender
      // still had cached as "current"), showing both dialogs at once.
      // Wear Compensation is reachable via a button in the main dialog
      // instead, available on every load regardless of marker state.
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

    showUnifiedDialog(content, context && context.filename, context && context.sourcePath, rows, overall.status, toolLibrary);

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
        statusClass: 'orange',
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
        statusClass: 'green',
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

// === Parse operations (for Tool Wear Compensation) ===
// Identifies each "( Operation #N: Name )" section the post-processor
// writes, and which tool was active at that point (the most recent
// preceding M6 tool change). An operation's line range runs from right
// after its own header comment to right before the NEXT operation's
// header (or end of file) - this can include the next tool-change
// sequence at the tail end, which is why the wear-compensation transform
// separately tracks G90/G91 modal state and only touches absolute-mode
// coordinates, regardless of which operation's range a line nominally
// falls under.
// Server-side HTML escaping - the existing escapeHtml() only exists
// inside showUnifiedDialog's browser-side <script> block, a completely
// separate execution context from this server-side function.
function escapeHtmlServerSide(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseOperations(content) {
  const lines = content.split(/\r?\n/);
  const opPattern = /^\(\s*Operation\s*#(\d+):\s*(.+?)\s*\)\s*$/i;
  const toolChangePattern = /T\s*0*(\d+)\s+M0*6/i;

  let currentTool = null;
  const operations = [];
  let currentOp = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const tc = line.match(toolChangePattern);
    if (tc) currentTool = parseInt(tc[1], 10);

    const opMatch = line.match(opPattern);
    if (opMatch) {
      if (currentOp) currentOp.endLine = i - 1;
      currentOp = {
        opNumber: parseInt(opMatch[1], 10),
        opName: opMatch[2],
        toolNumber: currentTool,
        startLine: i + 1,
        endLine: null
      };
      operations.push(currentOp);
    }
  }
  if (currentOp) currentOp.endLine = lines.length - 1;

  return operations;
}

// === Unified dialog: sync + slot mapping + translation ===

// === Unified dialog: Tool Management + Operation Management (EXPERIMENTAL layout) ===
//
// v1.13.0-experimental restructures the single flat dialog into two
// independently collapsible sections, each gated behind its own pair of
// buttons - one "do the work" button and one "skip this" button. Neither
// section's G-code transform (slot translation / wear compensation)
// actually runs until the user presses the combined "Bring This G-Code
// To Life!" button at the bottom, which stays disabled until BOTH
// sections have moved off their default "In progress..." state. This is
// a first draft for live testing in the real app - expect follow-up
// tweaks once real screenshots come back.

function showUnifiedDialog(content, filename, sourcePath, rows, status, toolLibrary) {
  const wearCompOperations = parseOperations(content);

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
        flex-wrap: wrap; gap: 8px; margin-bottom: 14px;
      }
      .sw-progname-block { text-align: left; flex: 1 1 auto; min-width: 0; }
      .sw-progname-label {
        font-size: 1rem; font-weight: 700;
        color: var(--color-text-primary, #e0e0e0);
      }
      .sw-filename { color: var(--color-text-secondary, #ccc); font-size: 0.9rem; word-break: break-all; }

      .sw-section {
        border: 1px solid var(--color-border, #3a3f45);
        border-radius: 8px;
        background: var(--color-surface-muted, #1a1a1a);
        margin-bottom: 14px;
        overflow: hidden;
      }
      .sw-section-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 12px 16px; cursor: pointer; user-select: none;
      }
      .sw-section-header:hover { background: var(--color-border, #232323); }
      .sw-section-title {
        display: flex; align-items: center; gap: 10px;
        font-size: 1.02rem; font-weight: 700;
      }
      .sw-chevron {
        display: inline-block; font-size: 0.8rem;
        color: var(--color-text-secondary, #999);
        transition: transform 0.18s ease;
      }
      .sw-section-icon { font-size: 1.05rem; line-height: 1; }
      .sw-section-badge { display: inline-flex; align-items: center; gap: 6px; }
      .sw-badge-icon { font-size: 0.9em; line-height: 1; }
      .sw-section-body { padding: 4px 16px 16px; }
      .sw-section-actions {
        display: flex; gap: 12px; margin-top: 14px; flex-wrap: wrap;
      }
      .sw-section-actions .btn { flex: 1 1 200px; }

      .btn-life {
        display: block; width: 100%; padding: 14px; font-size: 1rem;
        letter-spacing: 0.02em; margin-top: 4px;
      }
      .btn-life:not(:disabled) {
        background: #163a4d !important; color: #eaf6ff !important;
        border: 1px solid #3d8fc4 !important;
        box-shadow: 0 0 10px 1px rgba(61,143,196,0.5) !important;
      }
      .btn-life:not(:disabled):hover { background: #1c4a63 !important; }
      .btn-skip {
        background: transparent !important; color: var(--color-text-secondary, #ccc) !important;
        border: 1px solid var(--color-border, #555) !important;
      }
      .btn-skip:hover:not(:disabled) { background: var(--color-border, #2a2a2a) !important; }

      .sw-main {
        display: flex; gap: 0; align-items: stretch;
        background: var(--color-surface, #101214);
        border-radius: 8px; padding: 8px; overflow: hidden;
      }
      .tools-table-container {
        flex: 1 1 auto; min-width: 0;
        overflow-y: auto;
        border-right: 1px solid var(--color-border, #3a3f45);
        padding-right: 8px;
      }
      .tools-table-container::-webkit-scrollbar { width: 10px; }
      .tools-table-container::-webkit-scrollbar-track { background: var(--color-surface, #1a1c1e); }
      .tools-table-container::-webkit-scrollbar-thumb { background: #565a5f; border-radius: 5px; }
      .tools-table-container::-webkit-scrollbar-thumb:hover { background: #6b6f74; }
      .tools-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
      .tools-table thead { position: sticky; top: 0; background: var(--color-surface-muted-2, #1f2327); z-index: 1; }
      .tools-table th { padding: 6px 8px; text-align: center; font-weight: 600; border-bottom: 2px solid var(--color-border, #3a3f45); font-size: 1rem; color: #ffffff; white-space: nowrap; position: relative; }
      .tools-table td { padding: 4px 8px; border-bottom: 1px solid var(--color-border, #2a2e33); vertical-align: middle; font-size: 0.82rem; position: relative; }
      .tools-table th:not(:last-child)::after,
      .tools-table td:not(:last-child)::after {
        content: '';
        position: absolute;
        top: 6px; bottom: 6px; right: 0;
        width: 1px;
        background: var(--color-border, #3a3f45);
      }
      .tools-table tbody tr:hover { background: var(--color-border, #2a2a2a); }
      .col-toolnum { text-align: center; }
      .tools-table td.col-toolnum { font-size: 1.1rem; }
      .col-status { text-align: center; }
      .col-slot { text-align: center; }
      .tools-table td.col-slot { font-size: 1.2rem; }
      .tools-table th.col-toolnum, .tools-table th.col-status, .tools-table th.col-slot { text-align: center; }

      .wear-input {
        width: 4.5em; text-align: center; font-size: 1.2rem;
        background: var(--color-surface, #0e1113);
        border: 1px solid var(--color-border, #444);
        border-radius: 5px; color: var(--color-text-primary, #e0e0e0);
        padding: 0 4px; height: 32px; box-sizing: border-box;
      }
      .wear-stepper { display: inline-flex; align-items: center; gap: 4px; vertical-align: middle; height: 56px; }
      .wear-arrows { display: flex; flex-direction: column; justify-content: center; height: 56px; }
      .wear-arrow {
        display: flex; align-items: center; justify-content: center;
        background: transparent; border: none; margin: 0;
        padding: 2px 18px; box-sizing: border-box;
        color: var(--color-text-secondary, #999);
        font-size: 1.5rem; line-height: 0.9; cursor: pointer; user-select: none;
        touch-action: manipulation;
      }
      .wear-arrow:hover { color: var(--color-accent, #1abc9c); }
      .wear-input:focus { outline: none; border-color: var(--color-accent, #1abc9c); }
      .wear-input::placeholder { color: #75787c; }

      .gcode-cell { overflow: hidden; }
      .gcode-cell .gc-type { font-weight: 700; }
      .gcode-cell .gc-detail { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: 0.75; font-style: italic; font-size: 0.85em; }
      .row-status-badge {
        display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.68rem;
        font-weight: 600; text-transform: uppercase; border: 1px solid transparent; white-space: nowrap;
      }
      .row-status-badge--green { background: rgba(40,167,69,0.2); color: #28a745; border-color: #28a745; font-size: 0.95rem; padding: 4px 10px; box-shadow: 0 0 8px 1px rgba(40,167,69,0.55); }
      .row-status-badge--orange { background: rgba(249,115,22,0.2); color: #f97316; border-color: #f97316; font-size: 0.95rem; padding: 4px 10px; box-shadow: 0 0 8px 1px rgba(249,115,22,0.55); }
      .row-status-badge--gray { background: rgba(153,153,153,0.15); color: #999; border-color: #666; box-shadow: 0 0 8px 1px rgba(153,153,153,0.4); }
      .row-status-badge--red { background: rgba(220,53,69,0.2); color: #dc3545; border-color: #dc3545; box-shadow: 0 0 8px 1px rgba(220,53,69,0.55); }
      .status-conflict-wrap { border: 3px solid #dc3545; border-radius: 16px; box-shadow: 0 0 10px 1px rgba(220,53,69,0.55); padding: 6px 8px; margin: -4px -8px; }
      .tool-num { font-weight: 700; }
      .conflict-diff { margin-top: 2px; font-size: 0.7rem; line-height: 1.3; }
      .conflict-diff .lib-val { color: #f59e0b; }
      .conflict-diff .gcode-val { color: #1abc9c; }

      .btn { padding: 9px 18px; border: none; border-radius: 6px; font-size: 0.9rem; font-weight: 600; cursor: pointer; transition: all 0.2s; text-transform: uppercase; }
      .btn:disabled {
        opacity: 0.5 !important; cursor: default !important; pointer-events: none !important;
        background: var(--color-surface-muted, #2a2a2a) !important;
        border-color: var(--color-border, #444) !important;
        box-shadow: none !important;
        color: var(--color-text-secondary, #888) !important;
      }
      .btn-glow-green {
        background: #1a4d2e !important; color: #ffffff !important; border: 1px solid #28a745 !important;
        box-shadow: 0 0 10px 1px rgba(40,167,69,0.55) !important;
      }
      .btn-glow-green:hover:not(:disabled) { background: #216339 !important; }

      .slot-cell {
        cursor: pointer; user-select: none; font-weight: 700;
        display: inline-flex; align-items: center; gap: 5px;
        background: var(--color-surface, #0e1113);
        border: 1px solid var(--color-border, #444);
        border-radius: 5px; padding: 0 8px 0 10px;
        height: 32px; box-sizing: border-box;
      }
      .slot-cell::after {
        content: '\\25BE';
        font-size: 2.1rem; font-weight: 400; color: var(--color-text-secondary, #999); line-height: 0.6;
      }
      .slot-cell:hover { border-color: var(--color-accent, #1abc9c); background: var(--color-surface-muted, #1a1a1a); }
      .slot-cell-placeholder { color: #f59e0b; font-weight: 600; cursor: pointer; }

      .slot-selector-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 99998; display: none; }
      .slot-selector-overlay.show { display: block; }
      .slot-selector-popup {
        position: fixed; background: var(--color-surface, #2a2a2a); border: 1px solid var(--color-border, #444);
        border-radius: 6px; box-shadow: 0 8px 24px rgba(0,0,0,0.4); min-width: 200px; max-height: 520px;
        display: flex; flex-direction: column; z-index: 99999;
      }
      .slot-selector-header { padding: 10px 12px; font-size: 0.85rem; font-weight: 600; color: var(--color-text-secondary, #999); border-bottom: 1px solid var(--color-border, #444); flex-shrink: 0; }
      .slot-selector-list { overflow-y: auto; flex: 1; }
      .slot-selector-item { padding: 8px 12px; font-size: 1.2rem; color: var(--color-text-primary, #e0e0e0); cursor: pointer; transition: background 0.1s ease; }
      .slot-selector-item:hover { background: var(--color-surface-muted, #1a1a1a); }
      .slot-selector-item--active { background: var(--color-accent, #1abc9c); color: white; }
      .slot-selector-item--active:hover { background: var(--color-accent, #1abc9c); }
      .slot-selector-item--occupied { color: #f59e0b; }
      .slot-selector-item--disabled { color: var(--color-text-secondary, #666); cursor: not-allowed; }
    </style>

    <div class="sw-container">
      <div class="sw-header">
        <div class="sw-progname-block">
          <span class="sw-progname-label">Program Name: </span><span class="sw-filename">${filename || 'G-Code File'}</span>
        </div>
      </div>

      <div class="sw-section" id="toolSection">
        <div class="sw-section-header" id="toolSectionHeader">
          <div class="sw-section-title">
            <span class="sw-chevron" style="transform: rotate(-90deg);">&#9660;</span>
            <span class="sw-section-icon">&#129520;</span>
            <span>Tool management</span>
          </div>
          <span class="row-status-badge row-status-badge--orange sw-section-badge" id="toolSectionBadge">
            <span class="sw-badge-icon">&#8987;</span>In progress...
          </span>
        </div>
        <div class="sw-section-body" id="toolSectionBody" style="display:none;">
          <div class="sw-main">
            <div class="tools-table-container" id="toolsTableContainer">
              <table class="tools-table">
                <colgroup>
                  <col style="width: 10%;">
                  <col style="width: 33%;">
                  <col style="width: 30%;">
                  <col style="width: 27%;">
                </colgroup>
                <thead>
                  <tr>
                    <th class="col-toolnum">Tool #</th>
                    <th>Program Tool Information</th>
                    <th class="col-status">Status</th>
                    <th class="col-slot">Slot</th>
                  </tr>
                </thead>
                <tbody id="toolsTableBody"></tbody>
              </table>
            </div>
            <div id="slotCarousel"></div>
          </div>
          <div class="sw-section-actions">
            <button id="organizeBtn" type="button" class="btn btn-glow-green">Organize My Tools</button>
            <button id="skipToolsBtn" type="button" class="btn btn-skip">I Don't Need This</button>
          </div>
        </div>
      </div>

      <div class="sw-section" id="opSection">
        <div class="sw-section-header" id="opSectionHeader">
          <div class="sw-section-title">
            <span class="sw-chevron" style="transform: rotate(-90deg);">&#9660;</span>
            <span class="sw-section-icon">&#128737;&#65039;</span>
            <span>Operation management</span>
          </div>
          <span class="row-status-badge row-status-badge--orange sw-section-badge" id="opSectionBadge">
            <span class="sw-badge-icon">&#8987;</span>In progress...
          </span>
        </div>
        <div class="sw-section-body" id="opSectionBody" style="display:none;">
          <table class="wc-table" style="width:100%; border-collapse:collapse; font-size:0.85rem;">
            <thead>
              <tr>
                <th style="text-align:center; padding:8px 10px; background:var(--color-surface-muted-2, #1f2327); color:#fff; border-bottom:2px solid var(--color-border, #3a3f45);">Op #</th>
                <th style="text-align:left; padding:8px 10px; background:var(--color-surface-muted-2, #1f2327); color:#fff; border-bottom:2px solid var(--color-border, #3a3f45);">Operation</th>
                <th style="text-align:center; padding:8px 10px; background:var(--color-surface-muted-2, #1f2327); color:#fff; border-bottom:2px solid var(--color-border, #3a3f45);">Tool #</th>
                <th style="text-align:center; padding:8px 10px; background:var(--color-surface-muted-2, #1f2327); color:#fff; border-bottom:2px solid var(--color-border, #3a3f45);">Z Comp</th>
                <th style="text-align:center; padding:8px 10px; background:var(--color-surface-muted-2, #1f2327); color:#fff; border-bottom:2px solid var(--color-border, #3a3f45);">X&amp;Y Comp</th>
              </tr>
            </thead>
            <tbody id="wcTableBody"></tbody>
          </table>
          <div class="sw-section-actions">
            <button id="applySafetyBtn" type="button" class="btn btn-glow-green">Apply My Safety Net</button>
            <button id="livingEdgeBtn" type="button" class="btn btn-skip">Living On The Edge</button>
          </div>
        </div>
      </div>

      <button id="lifeBtn" type="button" class="btn btn-life" disabled>&#9889; Bring This G-Code To Life!</button>
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
        const wearCompOperations = ${JSON.stringify(wearCompOperations)};
        let magazineSize = 0;
        let currentSlotRow = null;
        let toolSectionState = 'pending';
        let opSectionState = 'pending';
        let storedWearOffsets = {};

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
          return { allReady: allReady, hasNew: hasNew, hasAssignable: hasAssignable, hasPrepareWork: hasPrepareWork };
        }

        // === Section state / accordion machinery ===

        const SECTION_BADGES = {
          pending: { cls: 'orange', icon: '\\u23F3', label: 'In progress...' },
          ready:   { cls: 'green',  icon: '\\u2705', label: 'Ready to go!' },
          skipped: { cls: 'gray',   icon: '\\u23ED\\uFE0F', label: 'Skipped' }
        };

        function applySectionBadge(badgeId, state) {
          const b = SECTION_BADGES[state];
          const el = document.getElementById(badgeId);
          el.className = 'row-status-badge row-status-badge--' + b.cls + ' sw-section-badge';
          el.innerHTML = '<span class="sw-badge-icon">' + b.icon + '</span>' + b.label;
        }

        function setSectionCollapsed(bodyId, headerId, collapsed) {
          document.getElementById(bodyId).style.display = collapsed ? 'none' : 'block';
          const chevron = document.querySelector('#' + headerId + ' .sw-chevron');
          if (chevron) chevron.style.transform = collapsed ? 'rotate(-90deg)' : 'rotate(0deg)';
        }

        function updateLifeButton() {
          document.getElementById('lifeBtn').disabled = (toolSectionState === 'pending' || opSectionState === 'pending');
        }

        function setToolSectionState(state) {
          toolSectionState = state;
          applySectionBadge('toolSectionBadge', state);
          if (state !== 'pending') setSectionCollapsed('toolSectionBody', 'toolSectionHeader', true);
          updateLifeButton();
        }

        function setOpSectionState(state) {
          opSectionState = state;
          applySectionBadge('opSectionBadge', state);
          if (state !== 'pending') setSectionCollapsed('opSectionBody', 'opSectionHeader', true);
          updateLifeButton();
        }

        function wireAccordionHeader(headerId, bodyId) {
          document.getElementById(headerId).addEventListener('click', function() {
            const body = document.getElementById(bodyId);
            const isOpen = body.style.display !== 'none';
            setSectionCollapsed(bodyId, headerId, isOpen);
          });
        }
        wireAccordionHeader('toolSectionHeader', 'toolSectionBody');
        wireAccordionHeader('opSectionHeader', 'opSectionBody');

        function renderCarousel() {
          // Locked visual proportions from the approved design, all scaled
          // by SCALE. Adjust SCALE alone to resize everything proportionally.
          const SCALE = 0.82;
          const PITCH = Math.round(80 * SCALE);
          const FIRST_CY = Math.round(54 * SCALE);
          const BULGE_R = Math.round(52 * SCALE);
          const INNER_R = Math.round(35 * SCALE);
          const CAP_GAP = Math.round(42 * SCALE);
          const CAP_H = Math.round(53 * SCALE);
          const CAP_W = Math.round(88 * SCALE);
          const BOTTOM_PAD = Math.max(2, Math.round(3 * SCALE));
          const cx = Math.round(92 * SCALE);
          const RIGHT_MARGIN = Math.max(6, Math.round(8 * SCALE));
          const SVG_W = cx + BULGE_R + RIGHT_MARGIN;
          const LABEL_FS = Math.max(7, Math.round(13 * SCALE));
          const NUMBER_FS = Math.max(11, Math.round(24 * SCALE));
          const NOTOOL_FS = Math.max(11, Math.round(20 * SCALE));
          const DIGIT_FS = Math.max(13, Math.round(26 * SCALE));
          const TLS_FS = Math.max(9, Math.round(14 * SCALE));
          const KNOB_R = Math.max(8, Math.round(17 * SCALE));
          const LABEL_DY = Math.round(-5 * SCALE);
          const NUMBER_DY = Math.round(19 * SCALE);
          const DIGIT_DY = Math.round(8 * SCALE);
          const KNOB_DY = Math.round(29 * SCALE);
          const TLS_DY = Math.round(33 * SCALE);
          const DIGIT_X = Math.round(16 * SCALE);
          const TOP_PAD = Math.max(4, Math.round(6 * SCALE));

          const n = Math.max(magazineSize, 1);
          const lastCy = TOP_PAD + FIRST_CY + (n - 1) * PITCH;
          const topCy = TOP_PAD + FIRST_CY;
          const capTop = lastCy + CAP_GAP;
          const capBottom = capTop + CAP_H;
          const svgH = capBottom + BOTTOM_PAD;
          const knobCy = capTop + KNOB_DY;
          const tlsY = capTop + TLS_DY;

          const bySlot = {};
          rows.forEach(function(r) {
            if (r.action === 'add') return;
            if (r.pocketNumber === null || r.pocketNumber === undefined) return;
            bySlot[r.pocketNumber] = r;
          });

          let defs = '<defs>' +
            '<filter id="glowGreen" x="-60%" y="-60%" width="220%" height="220%">' +
            '<feGaussianBlur stdDeviation="2.5" result="blur"/>' +
            '<feFlood flood-color="#22c55e" flood-opacity="0.9" result="color"/>' +
            '<feComposite in="color" in2="blur" operator="in" result="glow"/>' +
            '<feMerge><feMergeNode in="glow"/><feMergeNode in="SourceGraphic"/></feMerge>' +
            '</filter>' +
            '<filter id="glowAmber" x="-60%" y="-60%" width="220%" height="220%">' +
            '<feGaussianBlur stdDeviation="2.5" result="blur"/>' +
            '<feFlood flood-color="#f2a623" flood-opacity="0.9" result="color"/>' +
            '<feComposite in="color" in2="blur" operator="in" result="glow"/>' +
            '<feMerge><feMergeNode in="glow"/><feMergeNode in="SourceGraphic"/></feMerge>' +
            '</filter>' +
            '<filter id="outerOutline" x="-15%" y="-15%" width="130%" height="130%">' +
            '<feMorphology in="SourceAlpha" operator="dilate" radius="1.5" result="dilated"/>' +
            '<feFlood flood-color="#4a4d50" flood-opacity="1" result="borderColor"/>' +
            '<feComposite in="borderColor" in2="dilated" operator="in" result="borderShape"/>' +
            '<feComposite in="borderShape" in2="SourceAlpha" operator="out" result="borderOnly"/>' +
            '<feMerge><feMergeNode in="borderOnly"/><feMergeNode in="SourceGraphic"/></feMerge>' +
            '</filter>' +
            '</defs>';

          let bulges = '';
          let inner = '';
          let digits = '';

          for (let i = 1; i <= n; i++) {
            const cy = topCy + (n - i) * PITCH;
            bulges += '<circle cx="' + cx + '" cy="' + cy + '" r="' + BULGE_R + '" fill="#0e1113"/>';

            const occ = bySlot[i];
            let digitColor = '#e8e8e6';
            let digitFilter = '';

            if (occ && occ.action === 'match') {
              inner += '<circle cx="' + cx + '" cy="' + cy + '" r="' + INNER_R + '" fill="#22c55e" filter="url(#glowGreen)"/>' +
                '<text x="' + cx + '" y="' + (cy + LABEL_DY) + '" text-anchor="middle" font-size="' + LABEL_FS + '" fill="#0a2c14">Tool #</text>' +
                '<text x="' + cx + '" y="' + (cy + NUMBER_DY) + '" text-anchor="middle" font-weight="700" font-size="' + NUMBER_FS + '" fill="#0a2c14">' + occ.toolNumber + '</text>';
              digitColor = '#22c55e';
              digitFilter = ' filter="url(#glowGreen)"';
            } else if (occ && occ.action === 'conflict') {
              inner += '<circle cx="' + cx + '" cy="' + cy + '" r="' + INNER_R + '" fill="#f2a623" filter="url(#glowAmber)"/>' +
                '<text x="' + cx + '" y="' + (cy + LABEL_DY) + '" text-anchor="middle" font-size="' + LABEL_FS + '" fill="#3d2500">Tool #</text>' +
                '<text x="' + cx + '" y="' + (cy + NUMBER_DY) + '" text-anchor="middle" font-weight="700" font-size="' + NUMBER_FS + '" fill="#3d2500">' + occ.toolNumber + '</text>';
              digitColor = '#f2a623';
              digitFilter = ' filter="url(#glowAmber)"';
            } else {
              inner += '<circle cx="' + cx + '" cy="' + cy + '" r="' + INNER_R + '" fill="#75787c"/>' +
                '<text x="' + cx + '" y="' + (cy + Math.round(0.3 * NOTOOL_FS)) + '" text-anchor="middle" font-size="' + NOTOOL_FS + '" fill="#0a0a0a">Empty</text>';
            }

            digits += '<text x="' + DIGIT_X + '" y="' + (cy + DIGIT_DY) + '" text-anchor="middle" font-weight="700" font-size="' + DIGIT_FS + '" fill="' + digitColor + '"' + digitFilter + '>' + i + '</text>';
          }

          const capRect = '<rect x="' + (cx - CAP_W / 2) + '" y="' + capTop + '" width="' + CAP_W + '" height="' + CAP_H + '" rx="' + Math.max(4, Math.round(10 * SCALE)) + '" fill="#0e1113"/>';
          const capExtras = '<circle cx="' + cx + '" cy="' + knobCy + '" r="' + KNOB_R + '" fill="#9a9da1" stroke="#0e1113" stroke-width="2"/>' +
            '<text x="4" y="' + tlsY + '" text-anchor="start" font-weight="700" font-size="' + TLS_FS + '" fill="#e8e8e6">TLS</text>';

          carousel.innerHTML = '<svg width="' + SVG_W + '" height="' + svgH + '" viewBox="0 0 ' + SVG_W + ' ' + svgH + '" style="flex-shrink:0; display:block; margin-left:8px;">' +
            defs + '<g filter="url(#outerOutline)">' + bulges + capRect + '</g>' + capExtras + inner + digits + '</svg>';

          const tableContainer = document.getElementById('toolsTableContainer');
          if (tableContainer) tableContainer.style.height = svgH + 'px';
        }

        function titleCase(s) {
          return String(s || '').toLowerCase().replace(/(^|[\\s-])([a-z])/g, function(m, sep, ch) {
            return sep + ch.toUpperCase();
          });
        }

        function renderTable() {
          const tbody = document.getElementById('toolsTableBody');
          tbody.innerHTML = rows.map(function(r, idx) {
            const mappedTitled = titleCase(r.mappedType);
            const rawTitled = titleCase(r.type);
            const combinedType = (mappedTitled.toLowerCase() === rawTitled.toLowerCase())
              ? mappedTitled
              : mappedTitled + ' ' + rawTitled;
            const gcodeCell = '<span class="gc-type">' + escapeHtml(combinedType) + '</span>' +
              '<span class="gc-detail">' + r.diameter.toFixed(2) + ' mm \\u2014 ' + escapeHtml(r.description) + '</span>';

            let syncCell = '<span class="row-status-badge row-status-badge--' + r.statusClass + '">' +
              escapeHtml(r.statusLabel) + '</span>';

            if (r.action === 'conflict') {
              const diff = '<div class="conflict-diff">' +
                '<div class="lib-val">Library: ' + escapeHtml(r.libType) + ' \\u2014 ' +
                  (r.libDiameter !== null ? r.libDiameter.toFixed(2) : '?') + ' mm \\u2014 ' + escapeHtml(r.libDescription) + '</div>' +
                '<div class="gcode-val">Will use: ' + escapeHtml(r.mappedType) + ' \\u2014 ' + r.diameter.toFixed(2) + ' mm \\u2014 ' + escapeHtml(r.description) + '</div>' +
              '</div>';
              syncCell = '<div class="status-conflict-wrap">' + syncCell + diff + '</div>';
            }

            let slotCell;
            if (r.action === 'add') {
              slotCell = '<span class="slot-cell-placeholder">Add tool first</span>';
            } else if (r.pocketNumber !== null && r.pocketNumber !== undefined) {
              slotCell = '<span class="slot-cell tool-num" data-slot-idx="' + idx + '">' + r.pocketNumber + '</span>';
            } else {
              slotCell = '<span class="slot-cell slot-cell-placeholder" data-slot-idx="' + idx + '">Assign</span>';
            }

            return '<tr style="height:64px;"><td class="col-toolnum tool-num">' + r.toolNumber + '</td><td class="gcode-cell">' + gcodeCell + '</td><td class="col-status">' + syncCell + '</td><td class="col-slot">' + slotCell + '</td></tr>';
          }).join('');
        }

        // === Slot selector popup ===

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
                row.statusClass = 'orange';
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
                row.action = 'match'; row.statusClass = 'green'; row.statusLabel = 'In Sync';
              } else {
                row.action = 'conflict'; row.statusClass = 'red'; row.statusLabel = 'Conflict';
              }
            });

            renderCarousel();
            renderTable();
          } catch (e) {
            // ignore refresh failures - user can retry
          }
        }

        // === Tool Wear Compensation: clamp to +/-1.00, color by sign ===

        function updateWearInputColor(input) {
          const val = parseFloat(input.value);
          if (isNaN(val) || val === 0) {
            input.style.color = '#75787c';
          } else if (val > 0) {
            input.style.color = '#28a745';
          } else {
            input.style.color = '#dc3545';
          }
        }

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

        // === Tool Management: add / resolve / auto-assign, then Organize/Skip ===

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

        async function autoAssignSlots() {
          const needed = rows.filter(function(r) { return r.action !== 'add' && r.slotStatus === 'unassigned'; });
          if (needed.length === 0) return { failures: 0, firstError: null };

          const usedInFile = new Set(rows.map(function(r) { return r.toolNumber; }));

          const occupiedBy = {};
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

        document.getElementById('organizeBtn').addEventListener('click', async function() {
          const btn = this;
          const skipBtn = document.getElementById('skipToolsBtn');
          btn.disabled = true; skipBtn.disabled = true;
          btn.textContent = 'Adding tools\\u2026';

          const addResult = await addNewToolsToLibrary();
          await refreshFromServer();

          btn.textContent = 'Resolving conflicts\\u2026';
          const conflictResult = await resolveConflictsWithGcode();
          await refreshFromServer();

          btn.textContent = 'Assigning slots\\u2026';
          const assignResult = await autoAssignSlots();
          await refreshFromServer();

          btn.textContent = 'Organize My Tools';
          btn.disabled = false; skipBtn.disabled = false;

          const totalFailures = addResult.failures + conflictResult.failures + (assignResult ? assignResult.failures : 0);
          const firstError = addResult.firstError || conflictResult.firstError || (assignResult && assignResult.firstError);

          if (assignResult && assignResult.ranOutOfSlots) {
            alert('The magazine doesn\\'t have enough slots for every tool in this file, even after freeing unused slots. Assign the remaining tool(s) manually, then click Organize My Tools again.');
          } else if (totalFailures > 0) {
            alert(totalFailures + ' step(s) failed.' + (firstError ? '\\n\\nFirst error: ' + firstError : ' Check the ncSender log for details.'));
          }

          if (currentStatus().allReady) {
            setToolSectionState('ready');
          }
        });

        document.getElementById('skipToolsBtn').addEventListener('click', function() {
          setToolSectionState('skipped');
        });

        // === Operation Management: wear compensation table + Apply/Skip ===

        function renderWearCompTable() {
          const tbody = document.getElementById('wcTableBody');
          tbody.innerHTML = wearCompOperations.map(function(op, idx) {
            const zCell = '<div class="wear-stepper">' +
              '<input type="text" class="wear-input" inputmode="decimal" pattern="^-?[0-9][.][0-9]{2}$" maxlength="5" placeholder="0.00" title="Format: -1.00 to 1.00" data-op-idx="' + idx + '" data-axis="z">' +
              '<div class="wear-arrows">' +
              '<span class="wear-arrow wear-arrow-up" role="button" tabindex="0" data-op-idx="' + idx + '" data-axis="z" data-dir="1" aria-label="Increase by 0.01">&#9650;</span>' +
              '<span class="wear-arrow wear-arrow-down" role="button" tabindex="0" data-op-idx="' + idx + '" data-axis="z" data-dir="-1" aria-label="Decrease by 0.01">&#9660;</span>' +
              '</div></div>';
            const xyCell = '<div class="wear-stepper">' +
              '<input type="text" class="wear-input" inputmode="decimal" pattern="^-?[0-9][.][0-9]{2}$" maxlength="5" placeholder="0.00" title="Format: -1.00 to 1.00" data-op-idx="' + idx + '" data-axis="xy">' +
              '<div class="wear-arrows">' +
              '<span class="wear-arrow wear-arrow-up" role="button" tabindex="0" data-op-idx="' + idx + '" data-axis="xy" data-dir="1" aria-label="Increase by 0.01">&#9650;</span>' +
              '<span class="wear-arrow wear-arrow-down" role="button" tabindex="0" data-op-idx="' + idx + '" data-axis="xy" data-dir="-1" aria-label="Decrease by 0.01">&#9660;</span>' +
              '</div></div>';
            return '<tr>' +
              '<td style="padding:8px 10px; text-align:center; font-weight:700; border-bottom:1px solid var(--color-border, #2a2e33);">' + op.opNumber + '</td>' +
              '<td style="padding:8px 10px; border-bottom:1px solid var(--color-border, #2a2e33);">' + escapeHtml(op.opName) + '</td>' +
              '<td style="padding:8px 10px; text-align:center; border-bottom:1px solid var(--color-border, #2a2e33);">' + (op.toolNumber !== null ? op.toolNumber : '\\u2014') + '</td>' +
              '<td style="padding:8px 10px; text-align:center; border-bottom:1px solid var(--color-border, #2a2e33);">' + zCell + '</td>' +
              '<td style="padding:8px 10px; text-align:center; border-bottom:1px solid var(--color-border, #2a2e33);">' + xyCell + '</td>' +
              '</tr>';
          }).join('');
        }

        document.getElementById('wcTableBody').addEventListener('click', function(e) {
          const arrow = e.target.closest('.wear-arrow');
          if (!arrow) return;
          const dir = parseFloat(arrow.getAttribute('data-dir'));
          const input = arrow.closest('.wear-stepper').querySelector('.wear-input');
          const current = parseFloat(input.value);
          const base = isNaN(current) ? 0 : current;
          let next = Math.round((base * 100) + (dir * 1)) / 100;
          next = Math.max(-1, Math.min(1, next));
          input.value = next.toFixed(2);
          updateWearInputColor(input);
        });

        document.getElementById('wcTableBody').addEventListener('input', function(e) {
          const input = e.target.closest('.wear-input');
          if (!input) return;
          const raw = parseFloat(input.value);
          if (!isNaN(raw) && (raw > 1 || raw < -1)) {
            input.value = Math.max(-1, Math.min(1, raw)).toFixed(2);
          }
          updateWearInputColor(input);
        });

        document.getElementById('wcTableBody').addEventListener('keydown', function(e) {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          const arrow = e.target.closest('.wear-arrow');
          if (arrow) { e.preventDefault(); arrow.click(); }
        });

        document.getElementById('applySafetyBtn').addEventListener('click', function() {
          storedWearOffsets = {};
          document.querySelectorAll('#wcTableBody .wear-input').forEach(function(input) {
            const idx = input.getAttribute('data-op-idx');
            const axis = input.getAttribute('data-axis');
            const val = parseFloat(input.value);
            if (!storedWearOffsets[idx]) storedWearOffsets[idx] = { xy: 0, z: 0 };
            if (!isNaN(val)) storedWearOffsets[idx][axis] = val;
          });
          setOpSectionState('ready');
        });

        document.getElementById('livingEdgeBtn').addEventListener('click', function() {
          setOpSectionState('skipped');
        });

        function wcShiftLine(line, xyOffset, zOffset) {
          return line.replace(/([XYZR])(-?(?:[0-9]+[.]?[0-9]*|[.][0-9]+))/g, function(match, letter, numStr) {
            const num = parseFloat(numStr);
            const delta = (letter === 'X' || letter === 'Y') ? xyOffset : zOffset;
            const shifted = Math.round((num + delta) * 10000) / 10000;
            return letter + shifted;
          });
        }

        function wcHasGWord(line, word) {
          const tokens = line.toUpperCase().split(' ');
          for (let i = 0; i < tokens.length; i++) {
            if (tokens[i] === word) return true;
          }
          return false;
        }

        function applyWearCompensation(fileContent, opOffsets) {
          const lines = fileContent.split(/\\r?\\n/);
          const lineOffset = new Array(lines.length).fill(null);

          wearCompOperations.forEach(function(op, idx) {
            const offset = opOffsets[idx];
            if (!offset || (offset.xy === 0 && offset.z === 0)) return;
            for (let i = op.startLine; i <= op.endLine && i < lines.length; i++) {
              lineOffset[i] = offset;
            }
          });

          let absoluteMode = true;
          const result = lines.map(function(line, i) {
            if (wcHasGWord(line, 'G91')) absoluteMode = false;
            if (wcHasGWord(line, 'G90')) absoluteMode = true;

            const offset = lineOffset[i];
            if (!offset) return line;
            if (!absoluteMode) return line;
            if (/^\\s*\\(/.test(line)) return line;

            return wcShiftLine(line, offset.xy, offset.z);
          });

          return result.join('\\r\\n');
        }

        // === Tool translation (T##/H## -> assigned slot) ===

        function performTranslationInBrowser(fileContent, toolToSlot) {
          return fileContent.replace(/^[^\\n]*(?:M0*6|T\\d|H\\d)[^\\n]*$/gmi, function(line) {
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

        async function fetchOriginalContent() {
          if (sourcePath) {
            const r = await fetch('/api/gcode-files/file?path=' + encodeURIComponent(sourcePath));
            if (!r.ok) throw new Error('Failed to fetch source file: HTTP ' + r.status);
            const data = await r.json();
            return data.content;
          }
          const r = await fetch('/api/gcode-files/current/download');
          if (!r.ok) throw new Error('Failed to download G-code: HTTP ' + r.status);
          return r.text();
        }

        // === Bring This G-Code To Life! - combined submit ===
        //
        // Disabled until both sections have moved off "pending". Runs
        // whichever transforms each section locked in (skip = no
        // transform for that section) as a single combined G-code
        // rewrite, then reloads the translated file once.

        document.getElementById('lifeBtn').addEventListener('click', async function() {
          const btn = this;
          btn.disabled = true;
          btn.textContent = 'Bringing it to life\\u2026';

          try {
            if (toolSectionState === 'skipped' && opSectionState === 'skipped') {
              window.parent.postMessage({ type: 'close-plugin-dialog', data: { action: 'bypass' } }, '*');
              return;
            }

            let fileContent = await fetchOriginalContent();

            if (toolSectionState === 'ready') {
              const toolToSlot = {};
              rows.forEach(function(r) {
                if (r.pocketNumber !== null && r.pocketNumber !== undefined) toolToSlot[r.toolNumber] = r.pocketNumber;
              });
              fileContent = performTranslationInBrowser(fileContent, toolToSlot);
            }

            if (opSectionState === 'ready') {
              fileContent = applyWearCompensation(fileContent, storedWearOffsets);
            }

            const transformed = '${SW2026_MARKER}\\n' + fileContent;
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

            window.parent.postMessage({ type: 'close-plugin-dialog', data: { action: 'life' } }, '*');
          } catch (err) {
            btn.disabled = false;
            btn.textContent = '\\u26A1 Bring This G-Code To Life!';
            alert('Failed to bring this G-code to life: ' + (err && err.message ? err.message : err));
          }
        });

        // === Init ===
        renderTable();
        renderWearCompTable();
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

  const response = pluginContext.showDialog('SolidWorks 2026 G-Code Tools', html, { closable: false });

  if (response && response.action) {
    return response;
  }
  return { action: 'bypass' };
}
