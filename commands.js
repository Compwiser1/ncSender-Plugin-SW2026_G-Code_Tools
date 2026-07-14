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
 *      carousel. Selecting an already-occupied slot overrides it -
 *      whichever tool was there is unassigned, not swapped elsewhere.
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
// marker breaks that specific loop.
//
// The marker includes a timestamp rather than being a permanent block:
// only an occurrence within SW2026_REOPEN_SUPPRESS_MS of "now" is treated
// as the immediate load-temp echo and suppressed - an older marker (or
// none at all, confirmed to be the normal case since load-temp only ever
// produces an in-memory/cached version and never writes the marker back
// to the actual file on disk) falls through and shows the dialog again
// normally on a later reload.
//
// Operation Manager's values are NOT persisted via this file-embedded
// marker - an earlier attempt at that was tested live and confirmed not
// to work, for the same reason: reloading a file reads the pristine,
// never-marked version from disk, so anything written only into the
// translated/uploaded content never round-trips back. See the
// browser-side localStorage-based persistence instead (keyed by the
// file's path), which lives in ncSender's own UI process rather than the
// file content, so it doesn't depend on what does or doesn't get written
// to disk.
const SW2026_MARKER_PREFIX = '; ncSender-sw2026-transformed:';
const SW2026_REOPEN_SUPPRESS_MS = 5000;

function twcExtractMarkerTimestamp(content) {
  const idx = content.indexOf(SW2026_MARKER_PREFIX);
  if (idx === -1) return null;
  const rest = content.substring(idx + SW2026_MARKER_PREFIX.length, idx + SW2026_MARKER_PREFIX.length + 20);
  const m = rest.match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

// === Entry point ===

function onGcodeProgramLoad(content, context, settings) {
  // Top-level try/catch is load-bearing: AOT-compiled hosts can crash hard
  // on unhandled JS exceptions. Always return original content on failure
  // (host sees a graceful fallback, user can still load the file as-is).
  try {
    if (content && content.length > 0) {
      const markerTs = twcExtractMarkerTimestamp(content.substring(0, 160));
      if (markerTs !== null && (Date.now() - markerTs) < SW2026_REOPEN_SUPPRESS_MS) {
        // The immediate echo from this plugin's own load-temp upload -
        // suppress it so we don't reopen the dialog milliseconds after
        // the user just finished with it.
        return content;
      }
      // Otherwise: no marker at all (first load), or an old-enough
      // marker that this is a deliberate later reload - fall through and
      // show the dialog again either way.
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
  // Supports both the original parenthesized-comment tool table and the
  // newer semicolon-comment format (no closing bracket, since ; comments
  // run to end of line rather than being wrapped in a pair like parens).
  const TABLE_ROW_RE_PAREN = /^\(\s*(\d{2,4})\s{2,}([A-Z][A-Z ]*?)\s{2,}([\d.]+)\s{2,}(.+?)\s*\)\s*$/gm;
  const TABLE_ROW_RE_SEMI = /^;\s*(\d{2,4})\s{2,}([A-Z][A-Z ]*?)\s{2,}([\d.]+)\s{2,}(.+?)\s*$/gm;
  const tools = [];
  const seen = {};

  function extract(re) {
    let m;
    while ((m = re.exec(content)) !== null) {
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
  }

  extract(TABLE_ROW_RE_PAREN);
  extract(TABLE_ROW_RE_SEMI);
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
  // Old format: "( Operation #N: Name )" header, "( Notes: ... )" right after.
  const opPatternParen = /^\(\s*Operation\s*#(\d+):\s*(.+?)\s*\)\s*$/i;
  const notesPatternParen = /^\(\s*Notes:\s*(.*?)\s*\)\s*$/i;
  // New format: semicolon comments, no explicit operation number - a
  // fixed 3-line block instead ("Operation Summary" label, then
  // "- Description: Name", then "- Notes: ...").
  const opSummaryPatternSemi = /^;\s*Operation\s+Summary\s*$/i;
  const descPatternSemi = /^;\s*-\s*Description:\s*(.+?)\s*$/i;
  const notesPatternSemi = /^;\s*-\s*Notes:\s*(.*?)\s*$/i;
  const toolChangePattern = /T\s*0*(\d+)\s+M0*6/i;

  let currentTool = null;
  const operations = [];
  let currentOp = null;

  function twcDirectionFor(opNotes) {
    // TWC direction comes only from the words "internal"/"external"
    // appearing in the Notes text (case-insensitive) - any numeric
    // suffix (TWC_INTERNAL_1, TWC_External_2, ...) is ignored, since
    // it's just a tracking label from the CAM process and has no
    // bearing on which way the offset should push the toolpath.
    const notesLower = opNotes.toLowerCase();
    if (notesLower.indexOf('internal') !== -1) return 'internal';
    if (notesLower.indexOf('external') !== -1) return 'external';
    return null;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const tc = line.match(toolChangePattern);
    if (tc) currentTool = parseInt(tc[1], 10);

    const opMatchParen = line.match(opPatternParen);
    if (opMatchParen) {
      if (currentOp) currentOp.endLine = i - 1;
      let opNotes = '';
      if (i + 1 < lines.length) {
        const notesMatch = lines[i + 1].match(notesPatternParen);
        if (notesMatch) opNotes = notesMatch[1];
      }
      currentOp = {
        opNumber: parseInt(opMatchParen[1], 10),
        opName: opMatchParen[2],
        opNotes: opNotes,
        twcDirection: twcDirectionFor(opNotes),
        toolNumber: currentTool,
        startLine: i + 1,
        endLine: null
      };
      operations.push(currentOp);
      continue;
    }

    if (opSummaryPatternSemi.test(line)) {
      if (currentOp) currentOp.endLine = i - 1;
      let opName = '';
      let opNotes = '';
      if (i + 1 < lines.length) {
        const descMatch = lines[i + 1].match(descPatternSemi);
        if (descMatch) opName = descMatch[1];
      }
      if (i + 2 < lines.length) {
        const notesMatch = lines[i + 2].match(notesPatternSemi);
        if (notesMatch) opNotes = notesMatch[1];
      }
      currentOp = {
        opNumber: operations.length + 1,
        opName: opName,
        opNotes: opNotes,
        twcDirection: twcDirectionFor(opNotes),
        toolNumber: currentTool,
        startLine: i + 3,
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
        width: 100%;
        max-width: 1180px;
        margin: 0 auto;
        box-sizing: border-box;
      }

      .sw-compat-row {
        display: flex; justify-content: flex-end;
        margin-bottom: 8px;
      }
      .sw-compat-badge {
        display: inline-flex; align-items: center; gap: 5px;
        background: rgba(249,115,22,0.12);
        border: 1px solid #f97316;
        border-radius: 999px;
        padding: 3px 11px;
        font-size: 0.72rem;
        font-weight: 600;
        color: #f97316;
        text-decoration: none;
        white-space: nowrap;
      }
      .sw-compat-badge:hover { background: rgba(249,115,22,0.22); text-decoration: underline; }

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
        text-transform: uppercase; letter-spacing: 0.02em;
        flex-shrink: 0;
        min-width: 230px;
      }
      .sw-section-stats {
        font-size: 1.02rem; font-weight: 400; font-style: normal;
        text-transform: none; letter-spacing: normal;
        color: var(--color-text-secondary, #999);
        margin-left: 60px;
        white-space: nowrap;
      }
      .sw-section-stats--inline {
        flex: 1 1 auto;
        margin-left: 0;
        text-align: center;
      }
      .stat-dot { font-size: 1.1rem; vertical-align: -1px; }
      .sw-section-badge-slot {
        display: inline-flex; justify-content: flex-end;
        min-width: 200px; flex-shrink: 0;
      }
      .sw-chevron {
        display: inline-flex; align-items: center; justify-content: center;
        font-size: 1.5rem; line-height: 0.9;
        padding: 2px 14px; box-sizing: border-box;
        color: var(--color-text-secondary, #999);
        transition: transform 0.18s ease;
        touch-action: manipulation;
      }
      .sw-section-icon { font-size: 1.4rem; line-height: 1; display: inline-flex; align-items: center; }
      .sw-section-badge { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; }
      .sw-badge-icon { font-size: 1.25em; line-height: 1; display: inline-flex; align-items: center; }
      .sw-section-body { padding: 4px 16px 16px; }
      .sw-section-actions {
        display: flex; gap: 12px; margin-top: 14px; flex-wrap: wrap;
      }
      .sw-section-actions .btn { flex: 1 1 200px; }

      .btn-life {
        display: flex; align-items: center; justify-content: center; gap: 8px;
        width: 100%; padding: 14px; font-size: 1rem;
        letter-spacing: 0.02em; margin-top: 4px;
      }
      .btn-life-icon { font-size: 1.3em; line-height: 1; display: inline-flex; align-items: center; }
      .btn-life:not(:disabled) {
        background: #163a4d !important; color: #eaf6ff !important;
        border: 1px solid #3d8fc4 !important;
        box-shadow: 0 0 10px 1px rgba(61,143,196,0.5) !important;
      }
      .btn-life:not(:disabled):hover { background: #1c4a63 !important; }
      .btn-glow-red {
        background: #5a1a22 !important; color: #ffffff !important; border: 1px solid #dc3545 !important;
        box-shadow: 0 0 10px 1px rgba(220,53,69,0.55) !important;
      }
      .btn-glow-red:hover:not(:disabled) { background: #712530 !important; }

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
      .row-status-badge--gray { background: rgba(153,153,153,0.15); color: #999; border-color: #666; font-size: 0.95rem; padding: 4px 10px; box-shadow: 0 0 8px 1px rgba(153,153,153,0.4); }
      .row-status-badge--red { background: rgba(220,53,69,0.2); color: #dc3545; border-color: #dc3545; box-shadow: 0 0 8px 1px rgba(220,53,69,0.55); }
      .sw-section-badge.row-status-badge--red { font-size: 0.95rem; padding: 4px 10px; }
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

      .twc-modal-overlay {
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0,0,0,0.6);
        z-index: 999999;
        display: none;
        align-items: center; justify-content: center;
      }
      .twc-modal-overlay.show { display: flex; }
      .twc-modal {
        background: var(--color-surface-muted, #1a1a1a);
        border: 1px solid var(--color-border, #3a3f45);
        border-radius: 10px;
        width: 90%; max-width: 560px; max-height: 80vh;
        display: flex; flex-direction: column;
        box-shadow: 0 16px 48px rgba(0,0,0,0.55);
      }
      .twc-modal.twc-modal--wide { max-width: 960px; }
      .twc-modal-header {
        display: flex; align-items: center; gap: 10px;
        padding: 16px 20px;
        border-bottom: 1px solid var(--color-border, #3a3f45);
        flex-shrink: 0;
      }
      .twc-modal-icon { font-size: 1.4rem; line-height: 1; }
      .twc-modal-title { font-size: 1.05rem; font-weight: 700; color: var(--color-text-primary, #e0e0e0); }
      .twc-modal-body {
        padding: 16px 20px;
        overflow-y: auto;
        font-size: 0.9rem; line-height: 1.5;
        color: var(--color-text-primary, #e0e0e0);
      }
      .twc-modal-body p { margin: 0 0 12px; }
      .twc-modal-body p:last-child { margin-bottom: 0; }
      .twc-modal-actions {
        display: flex; justify-content: flex-end; gap: 10px;
        padding: 14px 20px;
        border-top: 1px solid var(--color-border, #3a3f45);
        flex-shrink: 0;
      }
      .twc-modal-actions .btn { flex: 0 0 auto; padding: 9px 22px; }

      .twc-warning-stats {
        font-size: 0.85rem; font-weight: 600;
        color: var(--color-text-secondary, #999);
        margin-bottom: 12px;
      }
      .twc-warning-table { width: 100%; border-collapse: collapse; }
      .twc-warning-table th {
        text-align: left; padding: 7px 10px; font-size: 0.72rem;
        text-transform: uppercase; letter-spacing: 0.04em;
        background: var(--color-surface-muted-2, #1f2327); color: #fff;
        border-bottom: 2px solid var(--color-border, #3a3f45);
      }
      .twc-warning-table td {
        padding: 9px 10px; border-bottom: 1px solid var(--color-border, #2a2e33);
        vertical-align: top;
      }
      .twc-warning-num { font-weight: 700; white-space: nowrap; width: 100px; color: var(--color-text-secondary, #999); }
      .twc-warning-heading { font-weight: 700; }
      .twc-warning-detail {
        font-style: italic; font-size: 0.85em; opacity: 0.8;
        margin-top: 3px; margin-left: 14px;
      }
      .twc-warning-footer { margin-top: 14px; font-size: 0.85rem; color: var(--color-text-secondary, #999); }

      .twc-info-icon {
        position: relative;
        display: inline-flex;
        cursor: help;
        opacity: 0.8;
        font-weight: 400;
        vertical-align: middle;
      }
      .twc-info-icon:hover { opacity: 1; }
      .twc-info-tooltip {
        visibility: hidden;
        opacity: 0;
        position: absolute;
        top: calc(100% + 12px);
        right: -6px;
        width: 230px;
        max-width: 70vw;
        background-color: #14171a;
        color: #eaeaea;
        border: 2px solid #f97316;
        border-radius: 8px;
        box-shadow: 0 0 14px 2px rgba(249,115,22,0.6), 0 10px 28px rgba(0,0,0,0.5);
        padding: 10px 12px;
        font-size: 0.75rem;
        font-weight: 400;
        line-height: 1.4;
        text-align: left;
        white-space: normal;
        text-transform: none;
        letter-spacing: normal;
        pointer-events: none;
        transition: opacity 0.12s ease;
        z-index: 100000;
      }
      .twc-info-tooltip::after {
        content: '';
        position: absolute;
        bottom: 100%;
        right: 10px;
        border: 6px solid transparent;
        border-bottom-color: #f97316;
      }
      .twc-info-tooltip::before {
        content: '';
        position: absolute;
        bottom: calc(100% - 2px);
        right: 12px;
        border: 4px solid transparent;
        border-bottom-color: #14171a;
        z-index: 1;
      }
      .twc-info-icon:hover .twc-info-tooltip,
      .twc-info-icon:focus .twc-info-tooltip {
        visibility: visible;
        opacity: 1;
      }
      .twc-warning-fix { width: 90px; text-align: right; white-space: nowrap; }
      .twc-fix-btn { padding: 6px 16px; font-size: 0.78rem; }

      .twc-endmill-caption {
        position: absolute; left: 24px; top: 14px;
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        font-size: 30px; font-weight: 600; letter-spacing: 0.16em;
        text-transform: uppercase; color: #98a1ad;
        animation: twc-caption-flash 1.2s ease-in-out infinite;
      }
      @keyframes twc-caption-flash { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }

      .twc-endmill-travel {
        position: absolute; left: 0; top: 0; width: 1px; height: 1px;
        animation: twc-endmill-travel 10s linear infinite;
      }
      @keyframes twc-endmill-travel {
        0%      { transform: translate(70px, -60px); }
        1.6%    { transform: translate(70px, -44px); }
        19.2%   { transform: translate(1850px, -44px); }
        20.8%   { transform: translate(1850px, -28px); }
        38.4%   { transform: translate(70px, -28px); }
        40%     { transform: translate(70px, -12px); }
        57.6%   { transform: translate(1850px, -12px); }
        59.2%   { transform: translate(1850px, 4px); }
        76.8%   { transform: translate(70px, 4px); }
        78.4%   { transform: translate(70px, 20px); }
        96%     { transform: translate(1850px, 20px); }
        96.01%, 100% { transform: translate(70px, -60px); }
      }

      .twc-endmill-flutes { animation: twc-flute-spin 0.15s linear infinite; }
      @keyframes twc-flute-spin { from { transform: translateX(0); } to { transform: translateX(-168px); } }

      .twc-endmill-led { animation: twc-led-pulse 0.6s ease-in-out infinite; }
      @keyframes twc-led-pulse { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }

      .twc-chip-wrap { animation: twc-chip-visibility 10s linear infinite; }
      @keyframes twc-chip-visibility {
        0%, 1.6%      { opacity: 0; }
        2.2%, 18.6%   { opacity: 1; }
        19.2%, 20.8%  { opacity: 0; }
        21.4%, 37.8%  { opacity: 1; }
        38.4%, 40%    { opacity: 0; }
        40.6%, 57%    { opacity: 1; }
        57.6%, 59.2%  { opacity: 0; }
        59.8%, 76.2%  { opacity: 1; }
        76.8%, 78.4%  { opacity: 0; }
        79%, 95.4%    { opacity: 1; }
        96%, 100%     { opacity: 0; }
      }

      /* Each band spans the tool's FULL 1780px travel range (clipped by
         the block's own overflow:hidden to its real 1700px width), so a
         plain 0-to-100%-of-pass linear scaleX is mathematically the same
         function of time as the tool's own position - no separate
         crossing-point percentage calculation to accidentally get
         wrong. Direction alternates via transform-origin only (left for
         rightward passes, right for leftward). All five snap back to
         hidden together right at the loop point. */
      .twc-remove-band-1, .twc-remove-band-3, .twc-remove-band-5 { transform-origin: left; }
      .twc-remove-band-2, .twc-remove-band-4 { transform-origin: right; }
      .twc-remove-band-1 { animation: twc-remove-band-1 10s linear infinite; }
      @keyframes twc-remove-band-1 {
        0%, 1.6%     { transform: scaleX(0); }
        19.2%        { transform: scaleX(1); }
        96%          { transform: scaleX(1); }
        96.01%, 100% { transform: scaleX(0); }
      }
      .twc-remove-band-2 { animation: twc-remove-band-2 10s linear infinite; }
      @keyframes twc-remove-band-2 {
        0%, 20.8%    { transform: scaleX(0); }
        38.4%        { transform: scaleX(1); }
        96%          { transform: scaleX(1); }
        96.01%, 100% { transform: scaleX(0); }
      }
      .twc-remove-band-3 { animation: twc-remove-band-3 10s linear infinite; }
      @keyframes twc-remove-band-3 {
        0%, 40%      { transform: scaleX(0); }
        57.6%        { transform: scaleX(1); }
        96%          { transform: scaleX(1); }
        96.01%, 100% { transform: scaleX(0); }
      }
      .twc-remove-band-4 { animation: twc-remove-band-4 10s linear infinite; }
      @keyframes twc-remove-band-4 {
        0%, 59.2%    { transform: scaleX(0); }
        76.8%        { transform: scaleX(1); }
        96%          { transform: scaleX(1); }
        96.01%, 100% { transform: scaleX(0); }
      }
      .twc-remove-band-5 { animation: twc-remove-band-5 10s linear infinite; }
      @keyframes twc-remove-band-5 {
        0%, 78.4%    { transform: scaleX(0); }
        96%          { transform: scaleX(1); }
        96.01%, 100% { transform: scaleX(0); }
      }

      /* The now-fully-removed block snaps out of view right as the
         bands reset, then rises back up from below the visible canvas
         with fresh material already showing (bands already hidden by
         the time it's back in view). */
      .twc-endmill-block { animation: twc-block-rise 10s linear infinite; }
      @keyframes twc-block-rise {
        0%, 96%      { transform: translateY(0); }
        96.01%       { transform: translateY(150px); }
        100%         { transform: translateY(0); }
      }

      .twc-chip {
        animation: twc-chip-fly 0.85s cubic-bezier(.25,.6,.35,1) infinite;
        transform: translate(0,0) rotate(0deg);
        opacity: 0;
      }
      @keyframes twc-chip-fly {
        0%   { transform: translate(0,0) rotate(0deg); opacity: 0; }
        12%  { opacity: 1; }
        100% { transform: translate(var(--tx), var(--ty)) rotate(var(--tr)); opacity: 0; }
      }

      .twc-processing-body p { text-align: left; }
      .twc-processing-body p:first-of-type { text-align: center; font-weight: 600; margin-bottom: 16px; }

      .wear-input.twc-longpressing {
        transition: box-shadow 0.6s linear, border-color 0.6s linear;
        box-shadow: inset 0 0 0 2px rgba(249,115,22,0.85);
        border-color: #f97316;
      }
      .wear-input.twc-longpress-done {
        transition: box-shadow 0.25s ease, border-color 0.25s ease;
        box-shadow: inset 0 0 0 2px rgba(40,167,69,0.85);
        border-color: #28a745;
      }
    </style>

    <div class="sw-container">
      <div class="sw-compat-row">
        <a href="https://github.com/Compwiser1/ncSender-Plugin-SW2026_G-Code_Tools/releases/latest" id="swReleaseLink" class="sw-compat-badge" rel="noopener" title="This plugin only works with G-code from the SW2026 FrankenOKO post processor. Click to get the latest post processor and plugin release.">
          <span aria-hidden="true">&#9888;&#65039;</span>
          <span>SW2026 Post Processor Required</span>
          <span aria-hidden="true">&#8599;</span>
        </a>
      </div>
      <div class="sw-section" id="toolSection">
        <div class="sw-section-header" id="toolSectionHeader">
          <div class="sw-section-title">
            <span class="sw-chevron" style="transform: rotate(-90deg);">&#9660;</span>
            <span class="sw-section-icon">&#129520;</span>
            <span>Tool Manager</span>
          </div>
          <div class="sw-section-stats sw-section-stats--inline" id="toolSectionStats"></div>
          <div class="sw-section-badge-slot">
            <span class="row-status-badge row-status-badge--orange sw-section-badge" id="toolSectionBadge">
              <span class="sw-badge-icon">&#8987;</span>In progress...
            </span>
          </div>
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
                    <th>Tool Description</th>
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
            <button id="skipToolsBtn" type="button" class="btn btn-glow-red">I Don't Need This</button>
          </div>
        </div>
      </div>

      <div class="sw-section" id="opSection">
        <div class="sw-section-header" id="opSectionHeader">
          <div class="sw-section-title">
            <span class="sw-chevron" style="transform: rotate(-90deg);">&#9660;</span>
            <span class="sw-section-icon">&#128737;&#65039;</span>
            <span>Operation Manager</span>
          </div>
          <div class="sw-section-stats sw-section-stats--inline" id="opSectionStats"></div>
          <div class="sw-section-badge-slot">
            <span class="row-status-badge row-status-badge--orange sw-section-badge" id="opSectionBadge">
              <span class="sw-badge-icon">&#8987;</span>In progress...
            </span>
          </div>
        </div>
        <div class="sw-section-body" id="opSectionBody" style="display:none;">
          <table class="wc-table" style="width:100%; border-collapse:collapse; font-size:0.85rem;">
            <thead>
              <tr>
                <th style="text-align:center; padding:8px 10px; background:var(--color-surface-muted-2, #1f2327); color:#fff; border-bottom:2px solid var(--color-border, #3a3f45);">Op #</th>
                <th style="text-align:center; padding:8px 10px; background:var(--color-surface-muted-2, #1f2327); color:#fff; border-bottom:2px solid var(--color-border, #3a3f45);">Operation Description</th>
                <th style="text-align:center; padding:8px 10px; background:var(--color-surface-muted-2, #1f2327); color:#fff; border-bottom:2px solid var(--color-border, #3a3f45);">Tool #</th>
                <th style="text-align:center; padding:8px 10px; background:var(--color-surface-muted-2, #1f2327); color:#fff; border-bottom:2px solid var(--color-border, #3a3f45);">Tool Description</th>
                <th style="text-align:center; padding:8px 10px; background:var(--color-surface-muted-2, #1f2327); color:#fff; border-bottom:2px solid var(--color-border, #3a3f45);">Z Offset</th>
                <th style="text-align:center; padding:8px 10px; background:var(--color-surface-muted-2, #1f2327); color:#fff; border-bottom:2px solid var(--color-border, #3a3f45);">X &amp; Y Offset <span class="twc-info-icon" tabindex="0">&#9432;<span class="twc-info-tooltip">This is a RADIUS value, not diameter - the hole/boss's overall size across changes by 2x this amount. Example: entering 0.10 changes the diameter by 0.20mm, not 0.10mm.</span></span></th>
              </tr>
            </thead>
            <tbody id="wcTableBody"></tbody>
          </table>
          <div class="sw-section-actions">
            <button id="applySafetyBtn" type="button" class="btn" disabled>Apply Offset</button>
            <button id="livingEdgeBtn" type="button" class="btn btn-glow-red">Live On The Edge</button>
          </div>
        </div>
      </div>

      <button id="lifeBtn" type="button" class="btn btn-life" disabled><span class="btn-life-icon">&#9889;</span> Bring This G-Code To Life!</button>
    </div>

    <div id="slotSelectorOverlay" class="slot-selector-overlay">
      <div id="slotSelectorPopup" class="slot-selector-popup">
        <div class="slot-selector-header">Assign to Slot</div>
        <div class="slot-selector-list" id="slotSelectorList"></div>
      </div>
    </div>

    <div id="twcModalOverlay" class="twc-modal-overlay">
      <div class="twc-modal" id="twcModalCard">
        <div class="twc-modal-header">
          <span class="twc-modal-icon" id="twcModalIcon">&#9888;&#65039;</span>
          <span class="twc-modal-title" id="twcModalTitle">Notice</span>
        </div>
        <div class="twc-modal-body" id="twcModalBody"></div>
        <div class="twc-modal-actions" id="twcModalActions">
          <button id="twcModalCancelBtn" type="button" class="btn btn-glow-red" style="display:none;">Cancel</button>
          <button id="twcModalOkBtn" type="button" class="btn btn-glow-green">OK</button>
        </div>
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

        // Persists Operation Manager's Z/X&Y values in the browser
        // (ncSender's own UI process), keyed by this file's path - NOT
        // written into the G-code itself, since that was tried and
        // confirmed not to work: load-temp only ever produces an
        // in-memory/cached version of the translated file and never
        // writes the marker or any embedded values back to the actual
        // file on disk, so reloading the file always reads the pristine
        // original with nothing to restore from. This lives here
        // instead, so it doesn't depend on what does or doesn't get
        // written to disk.
        const TWC_STORAGE_KEY = 'sw2026-twc-values:' + (sourcePath || filename);

        function twcLoadStoredValues() {
          try {
            const raw = window.localStorage ? window.localStorage.getItem(TWC_STORAGE_KEY) : null;
            return raw ? JSON.parse(raw) : {};
          } catch (e) {
            return {};
          }
        }

        function twcSaveStoredValues(values) {
          try {
            if (window.localStorage) window.localStorage.setItem(TWC_STORAGE_KEY, JSON.stringify(values));
          } catch (e) {
            // ignore storage failures (unavailable, quota, private mode, etc.)
          }
        }

        const storedTwcValues = twcLoadStoredValues();

        const overlay = document.getElementById('slotSelectorOverlay');
        const popup = document.getElementById('slotSelectorPopup');
        const listContainer = document.getElementById('slotSelectorList');
        const carousel = document.getElementById('slotCarousel');

        // === Custom modal (replaces native alert()/confirm(), which
        // render as plain unstyled OS popups outside our control) ===

        function twcShowModal(title, icon, message, showCancel) {
          return new Promise(function(resolve) {
            const modalOverlay = document.getElementById('twcModalOverlay');
            document.getElementById('twcModalTitle').textContent = title;
            document.getElementById('twcModalIcon').textContent = icon;
            const body = document.getElementById('twcModalBody');
            body.innerHTML = '';
            String(message).split('\\n\\n').forEach(function(para) {
              const p = document.createElement('p');
              p.textContent = para;
              body.appendChild(p);
            });
            const okBtn = document.getElementById('twcModalOkBtn');
            const cancelBtn = document.getElementById('twcModalCancelBtn');
            cancelBtn.style.display = showCancel ? '' : 'none';

            function cleanup(result) {
              modalOverlay.classList.remove('show');
              okBtn.removeEventListener('click', onOk);
              cancelBtn.removeEventListener('click', onCancel);
              resolve(result);
            }
            function onOk() { cleanup(true); }
            function onCancel() { cleanup(false); }
            okBtn.addEventListener('click', onOk);
            cancelBtn.addEventListener('click', onCancel);
            modalOverlay.classList.add('show');
          });
        }

        function twcAlert(message, title) {
          return twcShowModal(title || 'Notice', '\u26A0\uFE0F', message, false);
        }

        function twcConfirm(message, title) {
          return twcShowModal(title || 'Please Confirm', '\u26A0\uFE0F', message, true);
        }

        // Renders a compact table of structured warnings - one row per
        // error, numbered "Error #1", "Error #2", ... - with a bold
        // heading and a smaller italic, indented detail line beneath it,
        // instead of a wall of plain text. Widens the modal so most rows
        // fit on one or two lines.
        function twcShowWarningTable(title, warningsArr, footerNote, showCancel) {
          return new Promise(function(resolve) {
            const modalOverlay = document.getElementById('twcModalOverlay');
            const modalCard = document.getElementById('twcModalCard');
            document.getElementById('twcModalTitle').textContent = title;
            document.getElementById('twcModalIcon').textContent = '\u26A0\uFE0F';
            const body = document.getElementById('twcModalBody');
            body.innerHTML = '';

            const count = warningsArr.length;
            const stats = document.createElement('div');
            stats.className = 'twc-warning-stats';
            stats.textContent = count + (count === 1 ? ' Error Found' : ' Errors Found');
            body.appendChild(stats);

            const table = document.createElement('table');
            table.className = 'twc-warning-table';
            const thead = document.createElement('thead');
            const headRow = document.createElement('tr');
            const th1 = document.createElement('th'); th1.textContent = 'Error';
            const th2 = document.createElement('th'); th2.textContent = 'Details';
            const th3 = document.createElement('th'); th3.textContent = '';
            headRow.appendChild(th1); headRow.appendChild(th2); headRow.appendChild(th3);
            thead.appendChild(headRow);
            table.appendChild(thead);

            const tbody = document.createElement('tbody');
            warningsArr.forEach(function(w, i) {
              const tr = document.createElement('tr');
              const tdNum = document.createElement('td');
              tdNum.className = 'twc-warning-num';
              tdNum.textContent = 'Error #' + (i + 1);
              const tdDetails = document.createElement('td');
              const headingDiv = document.createElement('div');
              headingDiv.className = 'twc-warning-heading';
              headingDiv.textContent = w.heading;
              const detailDiv = document.createElement('div');
              detailDiv.className = 'twc-warning-detail';
              detailDiv.textContent = w.detail;
              tdDetails.appendChild(headingDiv);
              tdDetails.appendChild(detailDiv);
              tr.appendChild(tdNum);
              tr.appendChild(tdDetails);

              const tdFix = document.createElement('td');
              tdFix.className = 'twc-warning-fix';
              if (w.kind === 'size' && w.opIdx !== undefined && w.opIdx !== null) {
                const fixBtn = document.createElement('button');
                fixBtn.type = 'button';
                fixBtn.className = 'btn btn-glow-green twc-fix-btn';
                fixBtn.textContent = 'Fix';
                fixBtn.addEventListener('click', function() {
                  const input = document.querySelector('#wcTableBody .wear-input[data-op-idx="' + w.opIdx + '"][data-axis="xy"]');
                  if (!input) return;
                  const current = parseFloat(input.value);
                  const sign = (!isNaN(current) && current < 0) ? -1 : 1;
                  input.value = (sign * w.maxSafe).toFixed(2);
                  updateWearInputColor(input);
                  updateApplySafetyBtnState();
                  updateOpSectionStats();
                  fixBtn.disabled = true;
                  fixBtn.textContent = 'Fixed';
                });
                tdFix.appendChild(fixBtn);
              }
              tr.appendChild(tdFix);

              tbody.appendChild(tr);
            });
            table.appendChild(tbody);
            body.appendChild(table);

            if (footerNote) {
              const footer = document.createElement('div');
              footer.className = 'twc-warning-footer';
              footer.textContent = footerNote;
              body.appendChild(footer);
            }

            modalCard.classList.add('twc-modal--wide');

            const okBtn = document.getElementById('twcModalOkBtn');
            const cancelBtn = document.getElementById('twcModalCancelBtn');
            cancelBtn.style.display = showCancel ? '' : 'none';

            function cleanup(result) {
              modalOverlay.classList.remove('show');
              modalCard.classList.remove('twc-modal--wide');
              okBtn.removeEventListener('click', onOk);
              cancelBtn.removeEventListener('click', onCancel);
              resolve(result);
            }
            function onOk() { cleanup(true); }
            function onCancel() { cleanup(false); }
            okBtn.addEventListener('click', onOk);
            cancelBtn.addEventListener('click', onCancel);
            modalOverlay.classList.add('show');
          });
        }

        // Shown while a potentially slow offset computation runs (large
        // files with many operations/depth passes can take a real,
        // noticeable amount of time to check every line). No OK/Cancel
        // buttons - this isn't asking anything, it's just letting the
        // person know work is happening and what that work actually is,
        // with something to read while they wait. Dismissed
        // programmatically via twcHideModal() once the real work
        // finishes, not by user interaction.
        // Vanilla-JS port of a Claude Design "omelette" scene (endmill-scene.jsx):
        // a flat endmill face-mills an aluminum bar across a strip, throwing
        // chips, on a seamless 8s loop (feed pass -> retract -> rapid return
        // while the finished part slides out and a fresh blank slides in).
        // Reimplemented without React/the Stage timeline framework - this
        // dialog has neither available - using the exact same coordinate
        // system, easing curves, and chip-particle physics, driven by a
        // plain requestAnimationFrame loop updating element styles directly.
        // Pure CSS animation - the endmill scene from Claude Design was
        // ported once as a requestAnimationFrame + per-frame JS style
        // update loop, but that approach silently freezes: JS is
        // single-threaded, and the offset check this modal covers for is
        // a genuinely heavy, fully SYNCHRONOUS computation that blocks
        // the main thread for the whole wait - during which NO rAF
        // callback can run at all, so a JS-driven animation goes
        // completely static for almost the entire time it's visible.
        // CSS @keyframes animations on transform/opacity run on the
        // browser's compositor thread instead, independent of the
        // blocked JS thread, so they keep animating smoothly regardless
        // of how long the computation takes. This does mean some of the
        // original scene's JS-only touches (the per-tool-position
        // machined/raw reveal wipe, the swap-in of a fresh blank part)
        // aren't reproduced here, since those specifically depended on
        // per-frame JS computation - the core identity (endmill
        // traveling, spinning flutes, LED, a continuous stream of
        // tumbling chips, a "processing" caption) is preserved.
        function twcBuildEndmillAnim(root) {
          root.style.cssText = 'position:relative; width:1920px; height:220px; overflow:hidden; background:transparent;';

          const stock = document.createElement('div');
          stock.className = 'twc-endmill-block';
          stock.style.cssText = 'position:absolute; left:110px; top:126px; width:1700px; height:80px; overflow:hidden; border-radius:0 0 3px 3px; background:linear-gradient(180deg, #aeb4bd 0%, #999fa9 22%, #a9afb9 34%, #8c929c 75%, #767b84 100%);';
          const stockHatch = document.createElement('div');
          stockHatch.style.cssText = 'position:absolute; inset:0; opacity:0.5; background:repeating-linear-gradient(90deg, rgba(0,0,0,0.10) 0 7px, transparent 7px 12px);';
          stock.appendChild(stockHatch);
          // Five progressively-deeper passes, zigzagging left-right-left
          // etc. Each band spans the tool's FULL 1780px travel range
          // (110-40 to 1810+40, not just the block's own 1700px), clipped
          // by the block's own overflow:hidden - this makes the reveal
          // track the tool's actual position by construction (same
          // linear function of time), rather than needing a separate,
          // easy-to-get-subtly-wrong percentage calculation for exactly
          // when the tool crosses the block's true edges. A small 1.5px
          // vertical overlap between adjacent bands closes off any
          // possible seam between rows.
          const OVERTRAVEL = 40;
          const BAND_H5 = 80 / 5;
          const BAND_OVERLAP = 1.5;
          for (let i = 0; i < 5; i++) {
            const top = i * BAND_H5 - (i === 0 ? 0 : BAND_OVERLAP);
            const bottom = (i + 1) * BAND_H5 + (i === 4 ? 0 : BAND_OVERLAP);
            const band = document.createElement('div');
            band.className = 'twc-remove-band twc-remove-band-' + (i + 1);
            band.style.cssText = 'position:absolute; left:-' + OVERTRAVEL + 'px; top:' + top + 'px; width:' + (1700 + 2 * OVERTRAVEL) + 'px; height:' + (bottom - top) + 'px; background:var(--color-surface-muted, #1a1a1a); transform:scaleX(0);';
            stock.appendChild(band);
          }
          root.appendChild(stock);

          const caption = document.createElement('div');
          caption.className = 'twc-endmill-caption';
          caption.textContent = 'Processing...';
          root.appendChild(caption);

          const travel = document.createElement('div');
          travel.className = 'twc-endmill-travel';
          root.appendChild(travel);

          const shadow = document.createElement('div');
          shadow.style.cssText = 'position:absolute; left:-44px; top:105px; width:88px; height:10px; border-radius:50%; background:rgba(0,0,0,0.28); filter:blur(4px);';
          travel.appendChild(shadow);

          const endmill = document.createElement('div');
          endmill.style.cssText = 'position:absolute; left:-52px; top:0; width:104px; height:182px; overflow:hidden;';
          travel.appendChild(endmill);

          const housing = document.createElement('div');
          housing.style.cssText = 'position:absolute; left:0; top:0; width:104px; height:64px; background:linear-gradient(90deg, #23262c, #3c4149 30%, #4a505a 50%, #383d45 72%, #1f2228); border-radius:0 0 12px 12px; box-shadow:0 4px 10px rgba(0,0,0,0.35);';
          const led = document.createElement('div');
          led.className = 'twc-endmill-led';
          led.style.cssText = 'position:absolute; right:14px; top:48px; width:7px; height:7px; border-radius:50%; background:#ffc266;';
          housing.appendChild(led);
          endmill.appendChild(housing);

          const collet = document.createElement('div');
          collet.style.cssText = 'position:absolute; left:15px; top:64px; width:74px; height:26px; clip-path:polygon(0 0, 100% 0, 84% 100%, 16% 100%); background:linear-gradient(90deg, #565c66, #9aa1ab 32%, #c3c9d1 50%, #8d949e 70%, #494f58);';
          endmill.appendChild(collet);

          const shank = document.createElement('div');
          shank.style.cssText = 'position:absolute; left:35px; top:90px; width:34px; height:18px; background:linear-gradient(90deg, #6a7079, #b9bfc8 40%, #d9dee5 52%, #a5abb5 68%, #5d636c);';
          endmill.appendChild(shank);

          const flutes = document.createElement('div');
          flutes.style.cssText = 'position:absolute; left:22px; top:108px; width:60px; height:74px; border-radius:0 0 7px 7px; overflow:hidden;';
          const fluteStripe = document.createElement('div');
          fluteStripe.className = 'twc-endmill-flutes';
          fluteStripe.style.cssText = 'position:absolute; top:0; left:-168px; width:420px; height:100%; background:repeating-linear-gradient(64deg, #1c1f24 0px 7px, #8d95a1 7px 10px, #e9eef4 10px 14px);';
          flutes.appendChild(fluteStripe);
          const fluteShade = document.createElement('div');
          fluteShade.style.cssText = 'position:absolute; inset:0; background:linear-gradient(90deg, rgba(0,0,0,0.55), rgba(0,0,0,0.05) 26%, rgba(255,255,255,0.4) 46%, rgba(255,255,255,0.05) 62%, rgba(0,0,0,0.55));';
          flutes.appendChild(fluteShade);
          endmill.appendChild(flutes);

          const tip = document.createElement('div');
          tip.style.cssText = 'position:absolute; left:22px; top:177px; width:60px; height:9px; border-radius:50%; background:linear-gradient(90deg, #2a2e34, #6c737d 50%, #262a30);';
          endmill.appendChild(tip);

          const glint = document.createElement('div');
          glint.style.cssText = 'position:absolute; left:-44px; top:-25px; width:56px; height:40px; background:radial-gradient(closest-side, rgba(255,255,255,0.95), rgba(215,230,255,0.4) 55%, transparent); filter:blur(1px); opacity:0.75;';
          travel.appendChild(glint);

          const chipWrap = document.createElement('div');
          chipWrap.className = 'twc-chip-wrap';
          chipWrap.style.cssText = 'position:absolute; left:0; top:120px; width:1px; height:1px;';
          travel.appendChild(chipWrap);

          const CHIP_COUNT = 14;
          for (let i = 0; i < CHIP_COUNT; i++) {
            const angle = (i / CHIP_COUNT) * Math.PI * 1.3 - 0.55;
            const dist = 55 + (i % 4) * 16;
            const tx = Math.round(Math.cos(angle) * dist);
            const ty = Math.round(-Math.abs(Math.sin(angle) * dist) - 12 - (i % 3) * 10);
            const tr = (i % 2 === 0 ? 1 : -1) * (220 + i * 17);
            const size = 5 + (i % 4) * 2;
            const chip = document.createElement('div');
            chip.className = 'twc-chip';
            chip.style.cssText = 'position:absolute; left:0; top:0; width:' + size + 'px; height:' + Math.round(size * 0.7) + 'px; border-radius:70% 30% 60% 40%; background:linear-gradient(135deg, #f2f5f9, #98a0ac 60%, #c6ccd5); box-shadow:0 0 2px rgba(255,255,255,0.3); --tx:' + tx + 'px; --ty:' + ty + 'px; --tr:' + tr + 'deg; animation-delay:' + (i * 0.09).toFixed(2) + 's;';
            chipWrap.appendChild(chip);
          }
        }

        function twcShowProcessingModal(title, paragraphs) {
          const modalOverlay = document.getElementById('twcModalOverlay');
          const modalCard = document.getElementById('twcModalCard');
          document.getElementById('twcModalTitle').textContent = title;
          document.getElementById('twcModalIcon').textContent = '\u23F3';
          const body = document.getElementById('twcModalBody');
          body.className = 'twc-modal-body twc-processing-body';
          body.innerHTML = '';

          const animOuter = document.createElement('div');
          animOuter.style.cssText = 'width:100%; max-width:860px; margin:0 auto 16px; overflow:hidden; border-radius:8px;';
          const animInner = document.createElement('div');
          animOuter.appendChild(animInner);
          body.appendChild(animOuter);

          twcBuildEndmillAnim(animInner);

          // Scale is applied AFTER twcBuildEndmillAnim, not before - that
          // function sets root.style.cssText itself as its first action,
          // which silently wipes out any transform set here beforehand.
          // This exact bug was already fixed once in the earlier
          // JS-driven version and was accidentally reintroduced when the
          // animation was rewritten as pure CSS, since the "set cssText
          // then build" ordering got copy-pasted back in - confirmed via
          // live verification (animation rendering at full 1920px size,
          // clipped by the modal instead of scaled to fit).
          const animScale = 860 / 1920;
          animInner.style.transformOrigin = 'top left';
          animInner.style.transform = 'scale(' + animScale + ')';
          animInner.style.marginBottom = (220 * animScale - 220) + 'px';

          paragraphs.forEach(function(para) {
            const p = document.createElement('p');
            p.textContent = para;
            body.appendChild(p);
          });

          document.getElementById('twcModalActions').style.display = 'none';
          modalCard.classList.add('twc-modal--wide');
          modalOverlay.classList.add('show');
        }

        function twcHideModal() {
          const modalOverlay = document.getElementById('twcModalOverlay');
          const modalCard = document.getElementById('twcModalCard');
          document.getElementById('twcModalActions').style.display = '';
          document.getElementById('twcModalBody').className = 'twc-modal-body';
          modalCard.classList.remove('twc-modal--wide');
          modalOverlay.classList.remove('show');
        }

        // A short pause after showing the processing modal, purely so
        // the browser gets a chance to actually paint it before the
        // heavy synchronous offset computation blocks the UI thread -
        // without this, JS being single-threaded means the modal could
        // be added to the DOM but never visually appear before the
        // blocking work starts and finishes.
        function twcYieldToRender() {
          return new Promise(function(resolve) { setTimeout(resolve, 50); });
        }

        const TWC_PROCESSING_TEXT = [
          'Tool Wear Compensation adjusts your G-code to account for the small amount of material lost as a cutting edge wears down over time.',
          'For each operation: circular features (bores, bosses) are checked against their own radius, since an offset larger than the feature itself would invert it. General profiles are offset perpendicular to their own path, with corners re-joined to keep the toolpath continuous.',
          'Every result is also checked against every other operation\\'s toolpath at the same cutting depth, to catch any accidental collision before anything is written.',
          'Larger files with more operations and depth passes take longer to check, since every line is analyzed individually.'
        ];

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
          skipped: { cls: 'red',    icon: '\\u23ED\\uFE0F', label: 'Skipped' }
        };

        // Ready/Skipped badge text always mirrors the exact button label
        // the user clicked, so the header and the button that produced
        // that state can never drift out of sync with each other.
        const TOOL_BADGE_LABELS = { ready: 'Tools Organized', skipped: "I Didn't Need This" };
        const OP_BADGE_LABELS = { ready: 'Offsets Applied', skipped: 'Living On The Edge' };
        // Hazard symbol for Tool Manager's skipped state.
        const TOOL_BADGE_ICONS = { skipped: '\\u26A0\\uFE0F' };
        // Caution/warning icon for Operation Manager's skipped state - a
        // better fit for "Living On The Edge" than the generic skip icon.
        const OP_BADGE_ICONS = { skipped: '\\u26A0\\uFE0F' };

        function applySectionBadge(badgeId, state, labelOverride, iconOverride) {
          const b = SECTION_BADGES[state];
          const el = document.getElementById(badgeId);
          el.className = 'row-status-badge row-status-badge--' + b.cls + ' sw-section-badge';
          el.innerHTML = '<span class="sw-badge-icon">' + (iconOverride || b.icon) + '</span>' + (labelOverride || b.label);
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
          applySectionBadge('toolSectionBadge', state, TOOL_BADGE_LABELS[state], TOOL_BADGE_ICONS[state]);
          if (state !== 'pending') setSectionCollapsed('toolSectionBody', 'toolSectionHeader', true);
          document.getElementById('organizeBtn').disabled = (state === 'ready');
          updateLifeButton();
        }

        function setOpSectionState(state) {
          opSectionState = state;
          applySectionBadge('opSectionBadge', state, OP_BADGE_LABELS[state], OP_BADGE_ICONS[state]);
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
          // HEIGHT_SCALE additionally trims 5% off just the vertical-extent
          // measurements (slot spacing, cap height/gap, top/bottom padding)
          // to show more of the section without scrolling - circle radii
          // and widths are untouched so nothing gets squished into an oval.
          const SCALE = 0.82;
          const HEIGHT_SCALE = 0.95;
          const PITCH = Math.round(80 * SCALE * HEIGHT_SCALE);
          const FIRST_CY = Math.round(54 * SCALE * HEIGHT_SCALE);
          const BULGE_R = Math.round(52 * SCALE);
          const INNER_R = Math.round(35 * SCALE);
          const CAP_GAP = Math.round(42 * SCALE * HEIGHT_SCALE);
          const CAP_H = Math.round(53 * SCALE * HEIGHT_SCALE);
          const CAP_W = Math.round(88 * SCALE);
          const BOTTOM_PAD = Math.max(2, Math.round(3 * SCALE * HEIGHT_SCALE));
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
          const KNOB_DY = Math.round(29 * SCALE * HEIGHT_SCALE);
          const TLS_DY = Math.round(33 * SCALE * HEIGHT_SCALE);
          const DIGIT_X = Math.round(16 * SCALE);
          const TOP_PAD = Math.max(4, Math.round(6 * SCALE * HEIGHT_SCALE));

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

        // Shared "Tool Description" markup - used by both the Tool
        // management table (Tool Description column) and the Operation
        // management table (Tool Description column added after Tool #),
        // so both sections always show identical wording for the same tool.
        function buildToolDescCell(row) {
          if (!row) return '\\u2014';
          const mappedTitled = titleCase(row.mappedType);
          const rawTitled = titleCase(row.type);
          const combinedType = (mappedTitled.toLowerCase() === rawTitled.toLowerCase())
            ? mappedTitled
            : mappedTitled + ' ' + rawTitled;
          return '<span class="gc-type">' + escapeHtml(combinedType) + '</span>' +
            '<span class="gc-detail">' + row.diameter.toFixed(2) + ' mm \\u2014 ' + escapeHtml(row.description) + '</span>';
        }

        function findRowByToolNumber(toolNumber) {
          return rows.find(function(r) { return r.toolNumber === toolNumber; });
        }

        // === Header summary stats ===

        function updateToolSectionStats() {
          const total = rows.length;
          const inSync = rows.filter(function(r) { return r.action === 'match'; }).length;
          const newCount = rows.filter(function(r) { return r.action === 'add'; }).length;
          const conflicts = rows.filter(function(r) { return r.action === 'conflict'; }).length;

          const el = document.getElementById('toolSectionStats');
          el.innerHTML = '<strong>' + total + ' tool' + (total === 1 ? '' : 's') + '</strong>' +
            ' &middot; <span class="stat-dot" style="color:#28a745;">&#9679;</span> ' + inSync + ' In Sync' +
            ' &middot; <span class="stat-dot" style="color:#f97316;">&#9679;</span> ' + newCount + ' New' +
            ' &middot; <span class="stat-dot" style="color:#dc3545;">&#9679;</span> ' + conflicts + ' Conflict' + (conflicts === 1 ? '' : 's');
        }

        function updateOpSectionStats() {
          const total = wearCompOperations.length;

          const toolSet = {};
          wearCompOperations.forEach(function(op) {
            if (op.toolNumber !== null && op.toolNumber !== undefined) toolSet[op.toolNumber] = true;
          });
          const toolCount = Object.keys(toolSet).length;

          const coveredOps = {};
          document.querySelectorAll('#wcTableBody .wear-input').forEach(function(input) {
            const idx = input.getAttribute('data-op-idx');
            const val = parseFloat(input.value);
            if (!isNaN(val) && val !== 0) coveredOps[idx] = true;
          });
          const coverage = Object.keys(coveredOps).length;

          const el = document.getElementById('opSectionStats');
          el.innerHTML = '<strong>' + total + ' operation' + (total === 1 ? '' : 's') + '</strong>' +
            ' &middot; ' + coverage + ' of ' + total + ' set' +
            ' &middot; spans ' + toolCount + ' tool' + (toolCount === 1 ? '' : 's');
        }

        function renderTable() {
          const tbody = document.getElementById('toolsTableBody');
          tbody.innerHTML = rows.map(function(r, idx) {
            const gcodeCell = buildToolDescCell(r);

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
            if (occupyingRow) occupiedInfo = ' (Currently tool #' + occupyingRow.toolNumber + ' - will be unassigned)';

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
            await twcAlert('Failed to assign slot: ' + (err && err.message ? err.message : err));
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
            updateToolSectionStats();
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
              const proceed = await twcConfirm(
                'Not enough empty slots for all tools in this file.\\n\\n' +
                'To make room, these slots will be cleared (tools removed from their slot, not deleted from the library):\\n\\n' +
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
            await twcAlert('The magazine doesn\\'t have enough slots for every tool in this file, even after freeing unused slots. Assign the remaining tool(s) manually, then click Organize My Tools again.');
          } else if (totalFailures > 0) {
            await twcAlert(totalFailures + ' step(s) failed.' + (firstError ? '\\n\\nFirst error: ' + firstError : ' Check the ncSender log for details.'));
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
            const stored = storedTwcValues[idx] || storedTwcValues[String(idx)];
            const storedZ = stored && typeof stored.z === 'number' ? twcSignedFixed(stored.z) : '';
            const storedXy = stored && typeof stored.xy === 'number' ? twcSignedFixed(stored.xy) : '';
            const zCell = '<div class="wear-stepper">' +
              '<input type="text" class="wear-input" inputmode="decimal" pattern="^[+-]?[0-9][.][0-9]{2}$" maxlength="5" placeholder="0.00" title="Format: -1.00 to 1.00" value="' + storedZ + '" data-op-idx="' + idx + '" data-axis="z">' +
              '<div class="wear-arrows">' +
              '<span class="wear-arrow wear-arrow-up" role="button" tabindex="0" data-op-idx="' + idx + '" data-axis="z" data-dir="1" aria-label="Increase by 0.01">&#9650;</span>' +
              '<span class="wear-arrow wear-arrow-down" role="button" tabindex="0" data-op-idx="' + idx + '" data-axis="z" data-dir="-1" aria-label="Decrease by 0.01">&#9660;</span>' +
              '</div></div>';
            const xyCell = '<div class="wear-stepper">' +
              '<input type="text" class="wear-input" inputmode="decimal" pattern="^[+-]?[0-9][.][0-9]{2}$" maxlength="5" placeholder="0.00" title="Format: -1.00 to 1.00" value="' + storedXy + '" data-op-idx="' + idx + '" data-axis="xy">' +
              '<div class="wear-arrows">' +
              '<span class="wear-arrow wear-arrow-up" role="button" tabindex="0" data-op-idx="' + idx + '" data-axis="xy" data-dir="1" aria-label="Increase by 0.01">&#9650;</span>' +
              '<span class="wear-arrow wear-arrow-down" role="button" tabindex="0" data-op-idx="' + idx + '" data-axis="xy" data-dir="-1" aria-label="Decrease by 0.01">&#9660;</span>' +
              '</div></div>';
            const opCell = '<span class="gc-type">' + escapeHtml(op.opName) + '</span>' +
              (op.opNotes ? '<span style="display:block; font-style:italic; font-size:0.85em; opacity:0.75; white-space:normal; word-break:break-word; margin-top:2px;">' + escapeHtml(op.opNotes) + '</span>' : '');
            return '<tr>' +
              '<td style="padding:8px 10px; text-align:center; font-weight:700; border-bottom:1px solid var(--color-border, #2a2e33);">' + op.opNumber + '</td>' +
              '<td class="gcode-cell" style="padding:8px 10px; white-space:normal; word-break:break-word; border-bottom:1px solid var(--color-border, #2a2e33);">' + opCell + '</td>' +
              '<td style="padding:8px 10px; text-align:center; border-bottom:1px solid var(--color-border, #2a2e33);">' + (op.toolNumber !== null ? op.toolNumber : '\\u2014') + '</td>' +
              '<td class="gcode-cell" style="padding:8px 10px; border-bottom:1px solid var(--color-border, #2a2e33);">' + buildToolDescCell(findRowByToolNumber(op.toolNumber)) + '</td>' +
              '<td style="padding:8px 10px; text-align:center; border-bottom:1px solid var(--color-border, #2a2e33);">' + zCell + '</td>' +
              '<td style="padding:8px 10px; text-align:center; border-bottom:1px solid var(--color-border, #2a2e33);">' + xyCell + '</td>' +
              '</tr>';
          }).join('');
        }

        // === Apply Offset stays grayed out until at least one Z/X&Y
        // value is non-zero, then lights up green (item 3). ===
        function updateApplySafetyBtnState() {
          const btn = document.getElementById('applySafetyBtn');
          let hasNonZero = false;
          document.querySelectorAll('#wcTableBody .wear-input').forEach(function(input) {
            const val = parseFloat(input.value);
            if (!isNaN(val) && val !== 0) hasNonZero = true;
          });
          btn.disabled = !hasNonZero;
          btn.classList.toggle('btn-glow-green', hasNonZero);
        }

        function twcSignedFixed(val) {
          if (val === 0) return '0.00';
          const fixed = val.toFixed(2);
          return val >= 0 ? '+' + fixed : fixed;
        }

        function twcCollectAndSaveCurrentValues() {
          const values = {};
          document.querySelectorAll('#wcTableBody .wear-input').forEach(function(input) {
            const idx = input.getAttribute('data-op-idx');
            const axis = input.getAttribute('data-axis');
            const val = parseFloat(input.value);
            if (!values[idx]) values[idx] = { xy: 0, z: 0 };
            if (!isNaN(val)) values[idx][axis] = val;
          });
          twcSaveStoredValues(values);
        }

        function twcStepArrowOnce(arrow) {
          const dir = parseFloat(arrow.getAttribute('data-dir'));
          const input = arrow.closest('.wear-stepper').querySelector('.wear-input');
          const current = parseFloat(input.value);
          const base = isNaN(current) ? 0 : current;
          let next = Math.round((base * 100) + (dir * 1)) / 100;
          next = Math.max(-1, Math.min(1, next));
          input.value = twcSignedFixed(next);
          updateWearInputColor(input);
          updateApplySafetyBtnState();
          updateOpSectionStats();
          twcCollectAndSaveCurrentValues();
        }

        // Touchscreens fire both a real touchstart AND a synthetic
        // mousedown shortly after for the same physical tap (kept for
        // backward compatibility with mouse-only code) - without a
        // guard, that means every tap on a touchscreen double-fires
        // whatever a mousedown handler does. Recording when a touch just
        // happened and having every mousedown handler skip itself if one
        // did fires the real touch handling once and ignores the
        // trailing synthetic echo.
        const TWC_TOUCH_MOUSE_IGNORE_MS = 400;
        let twcLastTouchTs = 0;
        function twcMarkTouch() { twcLastTouchTs = Date.now(); }
        function twcIsSyntheticMouseAfterTouch() { return (Date.now() - twcLastTouchTs) < TWC_TOUCH_MOUSE_IGNORE_MS; }

        // Press and hold a stepper arrow to repeat quickly instead of
        // needing one click per 0.01 step - a short initial delay (so a
        // normal quick click still only steps once), then repeats at a
        // fast fixed interval until released. All the actual stepping
        // happens here (mousedown/touchstart), not in a 'click' handler,
        // so a held press doesn't also fire an extra step when the
        // browser's own click event follows the eventual mouseup.
        const TWC_STEP_REPEAT_DELAY_MS = 1000;
        const TWC_STEP_REPEAT_INTERVAL_MS = 100;
        let twcStepTimeout = null;
        let twcStepInterval = null;

        function twcStopStepping() {
          if (twcStepTimeout) { clearTimeout(twcStepTimeout); twcStepTimeout = null; }
          if (twcStepInterval) { clearInterval(twcStepInterval); twcStepInterval = null; }
        }

        function twcStartStepping(arrow) {
          twcStopStepping();
          twcStepArrowOnce(arrow);
          twcStepTimeout = setTimeout(function() {
            twcStepInterval = setInterval(function() {
              twcStepArrowOnce(arrow);
            }, TWC_STEP_REPEAT_INTERVAL_MS);
          }, TWC_STEP_REPEAT_DELAY_MS);
        }

        document.getElementById('wcTableBody').addEventListener('mousedown', function(e) {
          if (twcIsSyntheticMouseAfterTouch()) return;
          const arrow = e.target.closest('.wear-arrow');
          if (!arrow) return;
          twcStartStepping(arrow);
        });
        document.getElementById('wcTableBody').addEventListener('touchstart', function(e) {
          const arrow = e.target.closest('.wear-arrow');
          if (!arrow) return;
          twcMarkTouch();
          twcStartStepping(arrow);
        }, { passive: true });
        document.addEventListener('mouseup', twcStopStepping);
        document.addEventListener('touchend', twcStopStepping);
        document.addEventListener('touchcancel', twcStopStepping);

        document.getElementById('wcTableBody').addEventListener('input', function(e) {
          const input = e.target.closest('.wear-input');
          if (!input) return;
          const raw = parseFloat(input.value);
          if (!isNaN(raw) && (raw > 1 || raw < -1)) {
            input.value = Math.max(-1, Math.min(1, raw)).toFixed(2);
          }
          updateWearInputColor(input);
          updateApplySafetyBtnState();
          updateOpSectionStats();
          twcCollectAndSaveCurrentValues();
        });

        // Finalizes the +/- sign format once the user is done typing
        // (on blur, not on every keystroke) - reformatting mid-typing
        // would fight with the person still entering digits.
        document.getElementById('wcTableBody').addEventListener('blur', function(e) {
          const input = e.target.closest('.wear-input');
          if (!input) return;
          const val = parseFloat(input.value);
          if (!isNaN(val)) {
            input.value = twcSignedFixed(val);
            updateWearInputColor(input);
            twcCollectAndSaveCurrentValues();
          }
        }, true);

        // Long press (~600ms) on a Z Offset or X & Y Offset field resets
        // it to 0.00 - a quick way to clear a single value without
        // selecting and retyping. A brief visual fill shows the hold
        // building up, and a quick green flash confirms the reset.
        const TWC_LONGPRESS_MS = 600;
        let twcLongPressTimer = null;
        let twcLongPressTarget = null;

        function twcCancelLongPress() {
          if (twcLongPressTimer) { clearTimeout(twcLongPressTimer); twcLongPressTimer = null; }
          if (twcLongPressTarget) { twcLongPressTarget.classList.remove('twc-longpressing'); twcLongPressTarget = null; }
        }

        document.getElementById('wcTableBody').addEventListener('mousedown', function(e) {
          if (twcIsSyntheticMouseAfterTouch()) return;
          const input = e.target.closest('.wear-input');
          if (!input) return;
          twcCancelLongPress();
          twcLongPressTarget = input;
          input.classList.add('twc-longpressing');
          twcLongPressTimer = setTimeout(function() {
            input.value = '0.00';
            updateWearInputColor(input);
            updateApplySafetyBtnState();
            updateOpSectionStats();
            twcCollectAndSaveCurrentValues();
            input.classList.remove('twc-longpressing');
            input.classList.add('twc-longpress-done');
            setTimeout(function() { input.classList.remove('twc-longpress-done'); }, 300);
            twcLongPressTimer = null;
            twcLongPressTarget = null;
          }, TWC_LONGPRESS_MS);
        });

        document.getElementById('wcTableBody').addEventListener('touchstart', function(e) {
          const input = e.target.closest('.wear-input');
          if (!input) return;
          twcMarkTouch();
          twcCancelLongPress();
          twcLongPressTarget = input;
          input.classList.add('twc-longpressing');
          twcLongPressTimer = setTimeout(function() {
            input.value = '0.00';
            updateWearInputColor(input);
            updateApplySafetyBtnState();
            updateOpSectionStats();
            twcCollectAndSaveCurrentValues();
            input.classList.remove('twc-longpressing');
            input.classList.add('twc-longpress-done');
            setTimeout(function() { input.classList.remove('twc-longpress-done'); }, 300);
            twcLongPressTimer = null;
            twcLongPressTarget = null;
          }, TWC_LONGPRESS_MS);
        }, { passive: true });

        // Release listeners live on the document, not just wcTableBody -
        // a mouse can move off the input (or the whole table) before
        // release, and that should still cancel the pending long press.
        document.addEventListener('mouseup', twcCancelLongPress);
        document.addEventListener('touchend', twcCancelLongPress);
        document.addEventListener('touchcancel', twcCancelLongPress);

        document.getElementById('wcTableBody').addEventListener('keydown', function(e) {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          const arrow = e.target.closest('.wear-arrow');
          if (arrow) { e.preventDefault(); twcStepArrowOnce(arrow); }
        });

        document.getElementById('applySafetyBtn').addEventListener('click', async function() {
          const btn = this;
          const offsets = {};
          document.querySelectorAll('#wcTableBody .wear-input').forEach(function(input) {
            const idx = input.getAttribute('data-op-idx');
            const axis = input.getAttribute('data-axis');
            const val = parseFloat(input.value);
            if (!offsets[idx]) offsets[idx] = { xy: 0, z: 0 };
            if (!isNaN(val)) offsets[idx][axis] = val;
          });

          btn.disabled = true;
          btn.textContent = 'Checking\\u2026';
          twcShowProcessingModal('Checking Your Offset(s)\\u2026', TWC_PROCESSING_TEXT);
          try {
            await twcYieldToRender();
            const fileContent = await fetchOriginalContent();
            const result = applyRadialAndZOffsets(fileContent, offsets);
            twcHideModal();
            btn.disabled = false;
            btn.textContent = 'Apply Offset';
            if (result.warnings.length > 0) {
              await twcShowWarningTable('Some Offsets Could Not Be Applied', result.warnings, 'Everything else will still be applied.', false);
            }
            storedWearOffsets = offsets;
            twcSaveStoredValues(offsets);
            setOpSectionState('ready');
          } catch (err) {
            twcHideModal();
            btn.disabled = false;
            btn.textContent = 'Apply Offset';
            await twcAlert('Failed to validate the offset(s): ' + (err && err.message ? err.message : err));
          }
        });

        document.getElementById('livingEdgeBtn').addEventListener('click', function() {
          // Skipping means "don't apply anything, and don't remember
          // these values as if they should come back next time" - clear
          // the inputs, the in-memory offsets, and the persisted browser
          // storage together, so a later reopen starts genuinely fresh
          // instead of restoring values that were explicitly skipped.
          document.querySelectorAll('#wcTableBody .wear-input').forEach(function(input) {
            input.value = '0.00';
            updateWearInputColor(input);
          });
          storedWearOffsets = {};
          twcSaveStoredValues({});
          setOpSectionState('skipped');
        });

        // === TWC (Tool Wear Compensation) internal/external offset engine ===
        //
        // STAGE 1 (circles only): an operation's Notes field determines
        // direction - "internal" (bore, more removal = bigger hole) or
        // "external" (boss, more removal = smaller boss). A negative
        // X & Y Offset value always means "remove more material" and a
        // positive value always means "keep more material", regardless
        // of internal/external - achieved by applying the offset with
        // an opposite sign depending on direction:
        //   internal: newRadius = oldRadius - value
        //   external: newRadius = oldRadius + value
        //
        // Only operations whose arc geometry resolves to one or more
        // clean, fully-closed circles are supported in this stage. Any
        // operation tagged internal/external with a non-zero value whose
        // geometry is NOT simple circles (e.g. a mixed line/arc outer
        // profile) is left completely untouched and reported as
        // unsupported - no partial/best-effort offsetting is attempted.
        // Arbitrary-profile support (true perpendicular-to-path
        // offsetting) is planned as a follow-up stage.
        //
        // Safety checks, both hard failures (operation left untouched,
        // clear reason reported, nothing written for ANY operation until
        // every entered offset passes):
        //   - new radius must stay positive (self-intersection/inversion)
        //   - the new circle must not cross any other operation's
        //     toolpath anywhere else in the file
        //
        // The whole file's G-code is parsed ONCE into a flat list of
        // resolved (modal-carryover-aware) moves before any of this
        // runs, since post-processor output isn't guaranteed to restate
        // X/Y on every line (confirmed only after real testing - see the
        // corner-arc bug this caught during development).

        function wcHasGWord(line, word) {
          const tokens = line.toUpperCase().split(' ');
          for (let i = 0; i < tokens.length; i++) {
            if (tokens[i] === word) return true;
          }
          return false;
        }

        // 0.15mm - the post processor rounds X/Y to 1 decimal place but
        // I/J to 2, so a real, correctly-defined arc's computed center
        // and start/end-to-center radii can legitimately vary by up to
        // ~0.07mm from that rounding alone, depending on which quadrant
        // of the circle a given arc move is derived from (confirmed
        // against real sample data). Genuinely different radii or
        // centers in a non-circular profile differ by whole
        // millimeters, so this tolerance doesn't risk misclassifying
        // real mixed geometry, and real distinct features on a
        // machined part are never this close together.
        const TWC_EPS = 0.15;

        // A tighter, separate threshold for "does this actually cross
        // other geometry" - TWC_EPS is deliberately loose to absorb
        // coordinate-rounding noise when matching/clustering circles,
        // but that's too loose for a genuine collision check.
        const TWC_COLLISION_EPS = 0.05;

        function twcMaxSafeOffset(radius) {
          return Math.max(0, Math.floor((radius - 0.02) * 100) / 100);
        }

        function twcDist(ax, ay, bx, by) {
          return Math.sqrt((ax - bx) * (ax - bx) + (ay - by) * (ay - by));
        }

        function twcNormalize(x, y) {
          const l = Math.sqrt(x * x + y * y);
          return l < 1e-9 ? { x: 0, y: 0 } : { x: x / l, y: y / l };
        }

        function twcTokenNumber(tokens, letter) {
          for (let k = 0; k < tokens.length; k++) {
            const t = tokens[k];
            if (t.length > 1 && t.charAt(0).toUpperCase() === letter) {
              const v = parseFloat(t.substring(1));
              if (!isNaN(v)) return v;
            }
          }
          return null;
        }

        function twcTokenMotion(tokens) {
          for (let k = 0; k < tokens.length; k++) {
            const m = tokens[k].match(/^G0?([0-3])$/i);
            if (m) return parseInt(m[1], 10);
          }
          return null;
        }

        // Parses the whole file into one resolved-position record per
        // line that touches X/Y/Z/I/J - modal carryover aware, so a line
        // that only restates X still resolves a correct Y from whatever
        // was last commanded. G91 (incremental) lines update the mode
        // flag only; their coordinates are never trusted or touched,
        // matching the same rule the existing Z-offset transform follows.
        // Converts a G02/G03 R-format arc (radius mode) to the
        // equivalent I/J offset (start -> center), using the exact
        // formula GRBL itself uses internally to interpret R-mode arcs -
        // this file's own target controller ("SW2026 FrankenOKO GRBL
        // Metric Mill") - so this matches how the machine actually
        // resolves it, including which of the two possible centers is
        // correct (positive R = minor/short arc, negative R = major/
        // long arc). Returns null if the given radius is too small for
        // the chord between start and end (geometrically impossible).
        function twcRadiusToIJ(startX, startY, endX, endY, r, isCW) {
          const x = endX - startX;
          const y = endY - startY;
          const distSq = x * x + y * y;
          let h_x2_div_d = 4 * r * r - distSq;
          if (h_x2_div_d < 0) return null;
          h_x2_div_d = -Math.sqrt(h_x2_div_d) / Math.sqrt(distSq);
          if (!isCW) h_x2_div_d = -h_x2_div_d;
          let absR = r;
          if (absR < 0) {
            h_x2_div_d = -h_x2_div_d;
            absR = -absR;
          }
          return {
            iVal: 0.5 * (x - (y * h_x2_div_d)),
            jVal: 0.5 * (y + (x * h_x2_div_d))
          };
        }

        function parseFileMoves(fileContent) {
          const lines = fileContent.split(/\\r?\\n/);
          let curX = 0, curY = 0, curZ = 0;
          let absoluteMode = true;
          let motion = null;
          const moves = [];

          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (/^\\s*[(;]/.test(line)) continue;
            const tokens = line.trim().split(/\\s+/).filter(Boolean);
            if (tokens.length === 0) continue;

            if (wcHasGWord(line, 'G91')) absoluteMode = false;
            if (wcHasGWord(line, 'G90')) absoluteMode = true;

            const mv = twcTokenMotion(tokens);
            if (mv !== null) motion = mv;

            const xVal = twcTokenNumber(tokens, 'X');
            const yVal = twcTokenNumber(tokens, 'Y');
            const zVal = twcTokenNumber(tokens, 'Z');
            let iVal = twcTokenNumber(tokens, 'I');
            let jVal = twcTokenNumber(tokens, 'J');
            const rVal = twcTokenNumber(tokens, 'R');

            const startX = curX, startY = curY, startZ = curZ;

            if (absoluteMode) {
              if (xVal !== null) curX = xVal;
              if (yVal !== null) curY = yVal;
              if (zVal !== null) curZ = zVal;
            }

            // R-format arc (this post processor's current convention) -
            // convert to the equivalent I/J once here so the rest of the
            // engine (which works entirely in center/radius terms) needs
            // no further changes. isRFormat + the original signed R are
            // kept so output-writing can write back R instead of I/J,
            // preserving the file's own convention.
            let isRFormat = false;
            let signedR = null;
            if (iVal === null && jVal === null && rVal !== null && (motion === 2 || motion === 3)) {
              const conv = twcRadiusToIJ(startX, startY, curX, curY, rVal, motion === 2);
              if (conv) {
                iVal = conv.iVal;
                jVal = conv.jVal;
                isRFormat = true;
                signedR = rVal;
              }
            }

            const hasAny = (xVal !== null || yVal !== null || zVal !== null || iVal !== null || jVal !== null);
            if (!hasAny) continue;

            moves.push({
              lineIndex: i,
              absoluteMode: absoluteMode,
              motion: motion,
              startX: startX, startY: startY, startZ: startZ,
              x: curX, y: curY, z: curZ,
              hasX: xVal !== null, hasY: yVal !== null,
              iVal: iVal, jVal: jVal,
              isRFormat: isRFormat, signedR: signedR,
              isArc: (motion === 2 || motion === 3) && (iVal !== null || jVal !== null)
            });
          }

          return moves;
        }

        // === Stage 2: general contour (line + arc) geometry ===
        //
        // Builds a "path element" list for an operation - one entry per
        // real cutting move (G01/G02/G03 only; G00 rapids are excluded
        // since they're repositioning, not material removal). Some post
        // processors emit degenerate zero-length "placeholder" arc lines
        // around tight corners (I/J stated but no real X/Y movement,
        // confirmed against real sample data) - those are skipped too,
        // since they carry no real geometry.
        function buildPathElements(moves, startLine, endLine) {
          const elements = [];
          for (let k = 0; k < moves.length; k++) {
            const m = moves[k];
            if (m.lineIndex < startLine || m.lineIndex > endLine) continue;
            if (!m.absoluteMode) continue;
            if (m.motion === 0 || m.motion === null) continue;
            if (twcDist(m.startX, m.startY, m.x, m.y) < TWC_EPS) continue;
            if (m.isArc) {
              const cx = m.startX + m.iVal, cy = m.startY + m.jVal;
              const r1 = twcDist(cx, cy, m.startX, m.startY);
              const r2 = twcDist(cx, cy, m.x, m.y);
              if (Math.abs(r1 - r2) > TWC_EPS) continue;
              elements.push({
                type: 'arc', start: { x: m.startX, y: m.startY }, end: { x: m.x, y: m.y },
                center: { x: cx, y: cy }, radius: (r1 + r2) / 2, cw: m.motion === 2, lineIndex: m.lineIndex, z: m.z,
                isRFormat: m.isRFormat, rSign: m.isRFormat ? (m.signedR >= 0 ? 1 : -1) : null
              });
            } else if (m.hasX || m.hasY) {
              elements.push({ type: 'line', start: { x: m.startX, y: m.startY }, end: { x: m.x, y: m.y }, lineIndex: m.lineIndex, z: m.z });
            }
          }
          return elements;
        }

        // Splits a sequence of path elements into maximal contiguous
        // chains (each element's start matching the previous element's
        // end). A chain may or may not close back on its own start -
        // both are handled by the offsetting step below.
        function segmentChains(elements) {
          const chains = [];
          let current = [];
          for (let i = 0; i < elements.length; i++) {
            const el = elements[i];
            if (current.length > 0) {
              const prevEnd = current[current.length - 1].end;
              if (twcDist(prevEnd.x, prevEnd.y, el.start.x, el.start.y) >= TWC_EPS) {
                chains.push(current);
                current = [];
              }
            }
            current.push(el);
          }
          if (current.length > 0) chains.push(current);
          return chains;
        }

        // Finds every genuinely closed, consistent-radius circular
        // feature among an operation's arc moves - regardless of what
        // else those arcs are contiguous with (a stepped/multi-diameter
        // counterbore mixes several distinct circles with short radial
        // "connector" lines moving between diameters, all in one
        // unbroken sequence - those connector lines are never part of
        // any real boundary, so circles are detected independently of
        // chain segmentation, by clustering arcs on center+radius and
        // checking that specific cluster's own closure, exactly as
        // Stage 1 always has). Arcs that don't belong to any closing
        // cluster simply aren't returned here - they're not an error,
        // they're handled by the general path engine instead.
        function extractCircleFeatures(moves, op) {
          const arcMoves = moves.filter(function(m) {
            return m.lineIndex >= op.startLine && m.lineIndex <= op.endLine && m.isArc && m.absoluteMode;
          });

          const groups = [];
          for (let k = 0; k < arcMoves.length; k++) {
            const m = arcMoves[k];
            const cx = m.startX + m.iVal, cy = m.startY + m.jVal;
            const r1 = twcDist(cx, cy, m.startX, m.startY);
            const r2 = twcDist(cx, cy, m.x, m.y);
            if (Math.abs(r1 - r2) > TWC_EPS) continue;
            let group = null;
            for (let g = 0; g < groups.length; g++) {
              if (twcDist(cx, cy, groups[g].center.x, groups[g].center.y) <= TWC_EPS &&
                  Math.abs(r1 - groups[g].radius) <= TWC_EPS) { group = groups[g]; break; }
            }
            if (!group) { group = { center: { x: cx, y: cy }, radius: r1, moves: [] }; groups.push(group); }
            group.moves.push(m);
          }

          const circles = [];
          for (let g = 0; g < groups.length; g++) {
            const group = groups[g];
            const gm = group.moves.slice().sort(function(a, b) { return a.lineIndex - b.lineIndex; });
            let runStart = null, runLastEnd = null;
            const closesOk = [];
            for (let m = 0; m < gm.length; m++) {
              const mv = gm[m];
              const isContiguous = (runLastEnd !== null) &&
                Math.abs(mv.startX - runLastEnd.x) < TWC_EPS && Math.abs(mv.startY - runLastEnd.y) < TWC_EPS;
              if (!isContiguous) {
                if (runStart !== null) closesOk.push(twcDist(runStart.x, runStart.y, runLastEnd.x, runLastEnd.y) < TWC_EPS);
                runStart = { x: mv.startX, y: mv.startY };
              }
              runLastEnd = { x: mv.x, y: mv.y };
            }
            if (runStart !== null) closesOk.push(twcDist(runStart.x, runStart.y, runLastEnd.x, runLastEnd.y) < TWC_EPS);

            if (closesOk.length > 0 && closesOk.indexOf(false) === -1) {
              circles.push({ center: group.center, radius: group.radius, lineIndices: gm.map(function(m) { return m.lineIndex; }) });
            }
          }

          return circles;
        }

        function computeNewRadius(direction, oldRadius, value) {
          return direction === 'internal' ? (oldRadius - value) : (oldRadius + value);
        }

        // grow > 0 always means "grow the enclosed area" and grow < 0
        // means "shrink" it, regardless of internal/external - the sign
        // flip that turns the user's always-physical value (negative =
        // remove more material) into this purely geometric quantity is
        // the exact same convention already used for circles.
        function computeGrowAmount(direction, value) {
          return direction === 'internal' ? -value : value;
        }

        function twcWindingSign(chain) {
          const pts = chain.map(function(el) { return el.start; });
          pts.push(chain[chain.length - 1].end);
          let area = 0;
          for (let i = 0; i < pts.length - 1; i++) area += pts[i].x * pts[i + 1].y - pts[i + 1].x * pts[i].y;
          return area >= 0 ? 1 : -1;
        }

        function twcArcPointAndTangent(el, t) {
          const cx = el.center.x, cy = el.center.y;
          const a0 = Math.atan2(el.start.y - cy, el.start.x - cx);
          let a1 = Math.atan2(el.end.y - cy, el.end.x - cx);
          let sweep = a1 - a0;
          if (el.cw) { while (sweep > 0) sweep -= 2 * Math.PI; if (Math.abs(sweep) < 1e-9) sweep = -2 * Math.PI; }
          else { while (sweep < 0) sweep += 2 * Math.PI; if (Math.abs(sweep) < 1e-9) sweep = 2 * Math.PI; }
          const a = a0 + sweep * t;
          const px = cx + el.radius * Math.cos(a), py = cy + el.radius * Math.sin(a);
          const dir = sweep >= 0 ? 1 : -1;
          return { point: { x: px, y: py }, tangent: { x: -Math.sin(a) * dir, y: Math.cos(a) * dir } };
        }

        function twcOutwardNormalFor(tangent, wind) {
          const n = twcNormalize(tangent.x, tangent.y);
          return wind === 1 ? { x: n.y, y: -n.x } : { x: -n.y, y: n.x };
        }

        // Offsets one element perpendicular to its own local direction
        // by growAmount, using the chain's overall winding to know which
        // way is "outward". Lines shift in parallel; arcs keep the same
        // center and change radius by +/- growAmount, whichever
        // direction actually corresponds to growing the enclosed area
        // for THAT arc's own curvature (a concave notch and a convex
        // bulge move opposite ways for the same growAmount).
        function twcOffsetElement(el, growAmount, wind) {
          if (el.type === 'line') {
            const n = twcNormalize(el.end.x - el.start.x, el.end.y - el.start.y);
            const o = twcOutwardNormalFor(n, wind);
            return {
              type: 'line',
              start: { x: el.start.x + o.x * growAmount, y: el.start.y + o.y * growAmount },
              end: { x: el.end.x + o.x * growAmount, y: el.end.y + o.y * growAmount }
            };
          }
          const mid = twcArcPointAndTangent(el, 0.5);
          const o = twcOutwardNormalFor(mid.tangent, wind);
          const toCenter = { x: el.center.x - mid.point.x, y: el.center.y - mid.point.y };
          const towardCenter = (o.x * toCenter.x + o.y * toCenter.y) > 0;
          const newRadius = towardCenter ? (el.radius - growAmount) : (el.radius + growAmount);
          if (newRadius <= 0.01) return null;
          const f = newRadius / el.radius;
          return {
            type: 'arc',
            start: { x: el.center.x + (el.start.x - el.center.x) * f, y: el.center.y + (el.start.y - el.center.y) * f },
            end: { x: el.center.x + (el.end.x - el.center.x) * f, y: el.center.y + (el.end.y - el.center.y) * f },
            center: el.center, radius: newRadius, cw: el.cw
          };
        }

        function twcLineLineIntersect(p1, p2, p3, p4) {
          const d1x = p2.x - p1.x, d1y = p2.y - p1.y, d2x = p4.x - p3.x, d2y = p4.y - p3.y;
          const denom = d1x * d2y - d1y * d2x;
          if (Math.abs(denom) < 1e-9) return null;
          const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom;
          return { x: p1.x + t * d1x, y: p1.y + t * d1y };
        }

        function twcLineCircleIntersect(p1, p2, center, radius, ref) {
          const dx = p2.x - p1.x, dy = p2.y - p1.y;
          const fx = p1.x - center.x, fy = p1.y - center.y;
          const a = dx * dx + dy * dy, b = 2 * (fx * dx + fy * dy), c = fx * fx + fy * fy - radius * radius;
          const disc = b * b - 4 * a * c;
          if (disc < 0) return null;
          const s = Math.sqrt(disc);
          const t1 = (-b + s) / (2 * a), t2 = (-b - s) / (2 * a);
          const pt1 = { x: p1.x + t1 * dx, y: p1.y + t1 * dy }, pt2 = { x: p1.x + t2 * dx, y: p1.y + t2 * dy };
          return twcDist(pt1.x, pt1.y, ref.x, ref.y) <= twcDist(pt2.x, pt2.y, ref.x, ref.y) ? pt1 : pt2;
        }

        function twcCircleCircleIntersect(c1, r1, c2, r2, ref) {
          const d = twcDist(c1.x, c1.y, c2.x, c2.y);
          if (d > r1 + r2 || d < Math.abs(r1 - r2) || d < 1e-9) return null;
          const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
          const h2 = r1 * r1 - a * a;
          if (h2 < 0) return null;
          const h = Math.sqrt(h2);
          const xm = c1.x + a * (c2.x - c1.x) / d, ym = c1.y + a * (c2.y - c1.y) / d;
          const pt1 = { x: xm + h * (c2.y - c1.y) / d, y: ym - h * (c2.x - c1.x) / d };
          const pt2 = { x: xm - h * (c2.y - c1.y) / d, y: ym + h * (c2.x - c1.x) / d };
          return twcDist(pt1.x, pt1.y, ref.x, ref.y) <= twcDist(pt2.x, pt2.y, ref.x, ref.y) ? pt1 : pt2;
        }

        // Reconciles the corner between two independently-offset
        // elements. Tries the direct intersection of the two offset
        // elements first (correct for both a convex corner that just
        // needs extending and a concave corner that needs trimming); if
        // that's missing or unreasonably far from the original corner,
        // falls back to inserting a small fillet arc of radius
        // |growAmount| centered on the original vertex - the standard
        // way to round a gap that opens up when growing outward past
        // what a direct intersection can bridge.
        function twcJoinCorner(a, b, origVertex, growAmount) {
          let candidate = null;
          if (a.type === 'line' && b.type === 'line') candidate = twcLineLineIntersect(a.start, a.end, b.start, b.end);
          else if (a.type === 'line' && b.type === 'arc') candidate = twcLineCircleIntersect(a.start, a.end, b.center, b.radius, origVertex);
          else if (a.type === 'arc' && b.type === 'line') candidate = twcLineCircleIntersect(b.start, b.end, a.center, a.radius, origVertex);
          else candidate = twcCircleCircleIntersect(a.center, a.radius, b.center, b.radius, origVertex);

          const maxReasonable = Math.max(5 * Math.abs(growAmount), 2);
          if (candidate && twcDist(candidate.x, candidate.y, origVertex.x, origVertex.y) <= maxReasonable) {
            return { vertex: candidate, fillet: null };
          }

          const r = Math.abs(growAmount);
          if (r < 0.01) return null;
          const startAngle = Math.atan2(a.end.y - origVertex.y, a.end.x - origVertex.x);
          const endAngle = Math.atan2(b.start.y - origVertex.y, b.start.x - origVertex.x);
          let sweepCCW = endAngle - startAngle;
          while (sweepCCW < 0) sweepCCW += 2 * Math.PI;
          const cw = (2 * Math.PI - sweepCCW) < sweepCCW;
          return { vertex: null, fillet: { type: 'arc', start: a.end, end: b.start, center: origVertex, radius: r, cw: cw } };
        }

        // Offsets a whole chain (open lead-in/profile/lead-out, or a
        // fully closed loop) by growAmount: independently offsets every
        // element, then reconciles every internal corner (and the
        // wrap-around corner too, if the chain genuinely closes). Open
        // chains' two free ends are left as simple translations - no
        // joining needed there, since they're real approach/depart
        // moves, not part of the enclosed boundary.
        function offsetChainGeneral(chain, growAmount, useRFormat) {
          const wind = twcWindingSign(chain);
          const offsetEls = [];
          for (let i = 0; i < chain.length; i++) {
            const o = twcOffsetElement(chain[i], growAmount, wind);
            if (!o) {
              const r = chain[i].radius;
              return { ok: false, kind: 'size', maxSafe: twcMaxSafeOffset(r) };
            }
            offsetEls.push(o);
          }

          const n = offsetEls.length;
          const closes = twcDist(chain[0].start.x, chain[0].start.y, chain[n - 1].end.x, chain[n - 1].end.y) < TWC_EPS;
          const insertions = [];
          const cornerCount = closes ? n : (n - 1);

          for (let i = 0; i < cornerCount; i++) {
            const aIdx = i, bIdx = (i + 1) % n;
            const a = offsetEls[aIdx], b = offsetEls[bIdx];
            const origVertex = chain[aIdx].end;
            const gap = twcDist(a.end.x, a.end.y, b.start.x, b.start.y);
            if (gap < 0.02) continue;
            const joined = twcJoinCorner(a, b, origVertex, growAmount);
            if (!joined) return { ok: false, kind: 'other', reason: 'a corner in this profile could not be closed cleanly' };
            if (joined.fillet) {
              insertions.push({ afterLineIndex: chain[aIdx].lineIndex, element: joined.fillet, isRFormat: useRFormat });
            } else {
              a.end = joined.vertex;
              b.start = joined.vertex;
            }
          }

          return { ok: true, offsetEls: offsetEls, insertions: insertions };
        }

        function twcSampleArcSweep(center, radius, start, end, cw) {
          const samples = [];
          const a0 = Math.atan2(start.y - center.y, start.x - center.x);
          let a1 = Math.atan2(end.y - center.y, end.x - center.x);
          let sweep = a1 - a0;
          if (cw) { while (sweep > 0) sweep -= 2 * Math.PI; if (Math.abs(sweep) < 1e-9) sweep = -2 * Math.PI; }
          else { while (sweep < 0) sweep += 2 * Math.PI; if (Math.abs(sweep) < 1e-9) sweep = 2 * Math.PI; }
          const steps = Math.max(4, Math.ceil(Math.abs(sweep) / (Math.PI / 60)));
          for (let s = 0; s <= steps; s++) {
            const a = a0 + sweep * (s / steps);
            samples.push({ x: center.x + radius * Math.cos(a), y: center.y + radius * Math.sin(a) });
          }
          return samples;
        }

        function sampleOffsetChain(offsetEls, insertions) {
          const samples = [];
          offsetEls.forEach(function(el) {
            if (el.type === 'line') {
              const len = twcDist(el.start.x, el.start.y, el.end.x, el.end.y);
              const steps = Math.max(1, Math.min(50, Math.ceil(len)));
              for (let s = 0; s <= steps; s++) {
                const t = s / steps;
                samples.push({ x: el.start.x + (el.end.x - el.start.x) * t, y: el.start.y + (el.end.y - el.start.y) * t });
              }
            } else {
              samples.push.apply(samples, twcSampleArcSweep(el.center, el.radius, el.start, el.end, el.cw));
            }
          });
          insertions.forEach(function(ins) {
            const el = ins.element;
            samples.push.apply(samples, twcSampleArcSweep(el.center, el.radius, el.start, el.end, el.cw));
          });
          return samples;
        }

        // Coarse sampled point cloud of every OTHER move in the file
        // (absolute-mode only), used for the cross-feature collision
        // check - arcs sampled every ~3 degrees, lines every ~1mm
        // (capped) so both curved and straight geometry are represented
        // closely enough for a safety check without being expensive.
        function buildGeometrySamples(moves) {
          const samples = [];
          for (let k = 0; k < moves.length; k++) {
            const m = moves[k];
            if (!m.absoluteMode) continue;
            if (m.isArc) {
              const cx = m.startX + m.iVal, cy = m.startY + m.jVal;
              const r = twcDist(cx, cy, m.startX, m.startY);
              twcSampleArcSweep({ x: cx, y: cy }, r, { x: m.startX, y: m.startY }, { x: m.x, y: m.y }, m.motion === 2)
                .forEach(function(p) { p.lineIndex = m.lineIndex; p.z = m.z; samples.push(p); });
            } else if (m.hasX || m.hasY) {
              const len = twcDist(m.startX, m.startY, m.x, m.y);
              const steps = Math.max(1, Math.min(50, Math.ceil(len / 1.0)));
              for (let s = 0; s <= steps; s++) {
                const t = s / steps;
                samples.push({ x: m.startX + (m.x - m.startX) * t, y: m.startY + (m.y - m.startY) * t, lineIndex: m.lineIndex, z: m.z });
              }
            }
          }
          return samples;
        }

        // Two features only pose a real collision risk if they actually
        // cut at overlapping depths - a shallow facing pass across the
        // whole top surface will be geometrically "close" in X/Y to
        // almost anything below it, but poses no real interference since
        // the tool never revisits that X/Y at the deeper feature's Z.
        // Confirmed necessary after a real facing operation produced a
        // false collision against a mounting-hole feature machined much
        // deeper - the two never actually meet.
        const TWC_Z_TOLERANCE = 0.5;

        function circleCollidesWithOthers(center, newRadius, ourZMin, ourZMax, samples, excludeLineIndexSet) {
          const steps = 72;
          for (let s = 0; s < steps; s++) {
            const a = (s / steps) * 2 * Math.PI;
            const px = center.x + newRadius * Math.cos(a);
            const py = center.y + newRadius * Math.sin(a);
            for (let k = 0; k < samples.length; k++) {
              const sp = samples[k];
              if (excludeLineIndexSet[sp.lineIndex]) continue;
              if (sp.z < ourZMin - TWC_Z_TOLERANCE || sp.z > ourZMax + TWC_Z_TOLERANCE) continue;
              if (twcDist(px, py, sp.x, sp.y) < TWC_COLLISION_EPS) return true;
            }
          }
          return false;
        }

        function pathSamplesCollideWithOthers(newSamples, ourZMin, ourZMax, otherSamples, excludeLineIndexSet) {
          for (let i = 0; i < newSamples.length; i++) {
            for (let k = 0; k < otherSamples.length; k++) {
              const sp = otherSamples[k];
              if (excludeLineIndexSet[sp.lineIndex]) continue;
              if (sp.z < ourZMin - TWC_Z_TOLERANCE || sp.z > ourZMax + TWC_Z_TOLERANCE) continue;
              if (twcDist(newSamples[i].x, newSamples[i].y, sp.x, sp.y) < TWC_COLLISION_EPS) return true;
            }
          }
          return false;
        }

        function twcArcGcodeLine(el, useRFormat) {
          const x = Math.round(el.end.x * 10000) / 10000;
          const y = Math.round(el.end.y * 10000) / 10000;
          if (useRFormat) {
            const rOut = Math.round(el.radius * 10000) / 10000;
            return (el.cw ? 'G02' : 'G03') + ' X' + x + ' Y' + y + ' R' + rOut;
          }
          const iVal = Math.round((el.center.x - el.start.x) * 10000) / 10000;
          const jVal = Math.round((el.center.y - el.start.y) * 10000) / 10000;
          return (el.cw ? 'G02' : 'G03') + ' X' + x + ' Y' + y + ' I' + iVal + ' J' + jVal;
        }

        // Main entry point. Every operation with a non-zero entered
        // value is processed independently, and WITHIN an operation,
        // every distinct closed/open geometry chain is ALSO processed
        // independently - a specific chain that fails (unsupported
        // shape, would self-intersect, would cross other geometry) is
        // left completely untouched and reported as a warning, while
        // every other chain (in the same or a different operation) that
        // succeeds is still applied. Nothing is ever silently wrong -
        // every skip is reported by name with a reason.
        function applyRadialAndZOffsets(fileContent, opOffsets) {
          const rawWarnings = [];
          const lineNotes = {};
          const rewrites = {};
          const insertions = [];
          const zShiftLines = {};

          const moves = parseFileMoves(fileContent);
          const allSamples = buildGeometrySamples(moves);

          // Whether THIS FILE uses R-format arcs at all - determined
          // once, file-wide, rather than inferred from whichever element
          // happens to precede a given corner (a straight line has no
          // arc format at all, so checking just the preceding element
          // silently produced I/J-format inserted fillets even in an
          // otherwise all-R-format file whenever a line preceded the
          // corner - confirmed as a real bug from a reported file
          // showing an inserted "G03 ... I0 J-0.99" line with no
          // N-number in the middle of an otherwise all-R-format profile).
          const fileUsesRFormat = moves.some(function(m) { return m.isRFormat; });

          // Newly inserted corner-fillet lines get a real, IN-SEQUENCE
          // N-number, not a collision-avoiding-but-out-of-order one - a
          // placeholder is used here, then the whole file's N-sequence
          // is properly renumbered in one pass at the very end (see
          // below), which is the only way to make an inserted line's
          // number actually fit between its real neighbors rather than
          // just being unique.
          const TWC_INSERTED_N_PLACEHOLDER = 'N0';

          // Lines where "R" means arc radius (this post processor's
          // R-format arcs), not a canned-cycle retract plane - the
          // Z-offset shift below must never touch these, or it corrupts
          // the arc's radius by the unrelated Z value. Confirmed as a
          // real bug: applying both a Z Offset and an X & Y Offset to
          // the same operation was shifting arc radii by the Z amount
          // too, since the original Z-shift regex (written before this
          // post processor existed, when "R" only ever meant a canned-
          // cycle retract height) matches Z and R together.
          const rFormatArcLines = {};
          moves.forEach(function(m) {
            if (m.isArc && m.isRFormat) rFormatArcLines[m.lineIndex] = true;
          });

          wearCompOperations.forEach(function(op, idx) {
            const offset = opOffsets[idx];
            if (!offset) return;

            if (offset.z !== 0) {
              // Only real feed moves (G01/G02/G03) get compensated - a
              // G00 rapid retract/reposition (e.g. a clearance height
              // between passes) isn't cutting anything, so it has no
              // business being shifted by a wear-compensation value.
              // Modal state (m.motion) correctly carries forward even
              // for bare "Z19.0"-style lines that don't restate the
              // G-word, so a line continuing in rapid mode stays
              // excluded and a line continuing in feed mode stays
              // included, matching real G-code semantics.
              moves.forEach(function(m) {
                if (m.lineIndex >= op.startLine && m.lineIndex <= op.endLine && m.motion !== 0 && m.motion !== null) {
                  zShiftLines[m.lineIndex] = offset.z;
                }
              });
            }

            const xyValue = offset.xy;
            if (!xyValue) return;

            const noteText = 'TWC: [X/Y] ' + twcSignedFixed(xyValue);

            if (!op.twcDirection) {
              rawWarnings.push({
                opNumber: op.opNumber, opName: op.opName, opIdx: idx, kind: 'other',
                heading: 'Operation #' + op.opNumber + ' (' + op.opName + '): No internal/external tag.',
                detail: 'Add "internal" or "external" to this operation\\'s Notes to apply an offset.'
              });
              return;
            }

            const elements = buildPathElements(moves, op.startLine, op.endLine);
            if (elements.length === 0) {
              rawWarnings.push({
                opNumber: op.opNumber, opName: op.opName, opIdx: idx, kind: 'other',
                heading: 'Operation #' + op.opNumber + ' (' + op.opName + '): No geometry found.',
                detail: 'This operation has no cuttable X/Y moves to offset.'
              });
              return;
            }

            // Pass 1: extract every genuine closed circle, regardless of
            // what else it's contiguous with (a stepped counterbore
            // mixes several diameters with short radial connector lines
            // in one unbroken run - those connectors are consumed as
            // "belonging to no circle" and left for pass 2 to sort out).
            const circleFeatures = extractCircleFeatures(moves, op);
            const consumedLines = {};
            circleFeatures.forEach(function(c) { c.lineIndices.forEach(function(li) { consumedLines[li] = true; }); });

            // Stable, whole-operation tightest limit - computed once from
            // EVERY arc in this operation (both circles and any real
            // arcs in the remainder profile), not just whichever
            // features happen to fail at the specific value being
            // tried. The same post processor's coordinate rounding can
            // give nominally-identical corners across different depth
            // passes slightly different radii, so only checking
            // currently-failing features made the reported limit shift
            // depending on what offset was attempted - this fixes that
            // by reporting the true tightest constraint up front, always.
            let opTightestRadius = null;
            circleFeatures.forEach(function(c) {
              if (opTightestRadius === null || c.radius < opTightestRadius) opTightestRadius = c.radius;
            });
            elements.forEach(function(el) {
              if (el.type === 'arc' && (opTightestRadius === null || el.radius < opTightestRadius)) opTightestRadius = el.radius;
            });
            const opMaxSafe = (opTightestRadius !== null) ? twcMaxSafeOffset(opTightestRadius) : 0;

            circleFeatures.forEach(function(cls) {
              const newRadius = computeNewRadius(op.twcDirection, cls.radius, xyValue);
              if (newRadius <= 0.01) {
                rawWarnings.push({ opNumber: op.opNumber, opName: op.opName, opIdx: idx, kind: 'size', maxSafe: opMaxSafe });
                return;
              }

              const excludeSet = {};
              moves.forEach(function(m) {
                if (m.lineIndex >= op.startLine && m.lineIndex <= op.endLine) excludeSet[m.lineIndex] = true;
              });
              let clsZMin = Infinity, clsZMax = -Infinity;
              cls.lineIndices.forEach(function(li) {
                const m = moves.find(function(mv) { return mv.lineIndex === li; });
                if (!m) return;
                if (m.z < clsZMin) clsZMin = m.z;
                if (m.z > clsZMax) clsZMax = m.z;
                if (m.startZ < clsZMin) clsZMin = m.startZ;
                if (m.startZ > clsZMax) clsZMax = m.startZ;
              });
              if (circleCollidesWithOthers(cls.center, newRadius, clsZMin, clsZMax, allSamples, excludeSet)) {
                rawWarnings.push({
                  opNumber: op.opNumber, opName: op.opName, opIdx: idx, kind: 'other',
                  heading: 'Operation #' + op.opNumber + ' (' + op.opName + '): Toolpath collision.',
                  detail: 'This offset would cross another operation\\'s toolpath at the same depth.'
                });
                return;
              }

              const factor = newRadius / cls.radius;
              let localFailed = false;

              cls.lineIndices.forEach(function(li) {
                const m = moves.find(function(mv) { return mv.lineIndex === li; });
                const r = rewrites[li] || {};
                r.x = cls.center.x + (m.x - cls.center.x) * factor;
                r.y = cls.center.y + (m.y - cls.center.y) * factor;
                const newStartX = cls.center.x + (m.startX - cls.center.x) * factor;
                const newStartY = cls.center.y + (m.startY - cls.center.y) * factor;
                r.iVal = cls.center.x - newStartX;
                r.jVal = cls.center.y - newStartY;
                if (m.isRFormat) {
                  r.isRFormat = true;
                  r.rVal = (m.signedR >= 0 ? 1 : -1) * newRadius;
                }
                rewrites[li] = r;
                lineNotes[li] = noteText;
              });

              moves.forEach(function(m) {
                if (m.lineIndex < op.startLine || m.lineIndex > op.endLine) return;
                if (!m.absoluteMode || m.isArc) return;
                if (!m.hasX && !m.hasY) return;
                const dEnd = twcDist(m.x, m.y, cls.center.x, cls.center.y);
                if (Math.abs(dEnd - cls.radius) > TWC_EPS) return;
                consumedLines[m.lineIndex] = true;
                const nx = cls.center.x + (m.x - cls.center.x) * factor;
                const ny = cls.center.y + (m.y - cls.center.y) * factor;
                if ((Math.abs(nx - m.x) > TWC_EPS && !m.hasX) || (Math.abs(ny - m.y) > TWC_EPS && !m.hasY)) {
                  rawWarnings.push({
                    opNumber: op.opNumber, opName: op.opName, opIdx: idx, kind: 'other',
                    heading: 'Operation #' + op.opNumber + ' (' + op.opName + '): Unsupported line pattern.',
                    detail: 'Line ' + (m.lineIndex + 1) + ' needs an axis change but doesn\\'t explicitly state it.'
                  });
                  localFailed = true;
                  return;
                }
                const r = rewrites[m.lineIndex] || {};
                if (m.hasX) r.x = nx;
                if (m.hasY) r.y = ny;
                rewrites[m.lineIndex] = r;
                lineNotes[m.lineIndex] = noteText;
              });
            });

            // Pass 2: whatever wasn't consumed by a circle is either a
            // real boundary to offset generally (Outside Profile-style),
            // or an isolated 1-2 element radial connector fragment left
            // behind between two different-diameter circles - those
            // fragments aren't part of any real boundary and are simply
            // left untouched, silently, since that's expected and not a
            // problem to report.
            const remainderElements = elements.filter(function(el) { return !consumedLines[el.lineIndex]; });
            const remainderChains = segmentChains(remainderElements);

            remainderChains.forEach(function(chain) {
              if (chain.length < 3) return;

              const growAmount = computeGrowAmount(op.twcDirection, xyValue);
              const result = offsetChainGeneral(chain, growAmount, fileUsesRFormat);
              if (!result.ok) {
                if (result.kind === 'size') {
                  rawWarnings.push({ opNumber: op.opNumber, opName: op.opName, opIdx: idx, kind: 'size', maxSafe: opMaxSafe });
                } else {
                  rawWarnings.push({
                    opNumber: op.opNumber, opName: op.opName, opIdx: idx, kind: 'other',
                    heading: 'Operation #' + op.opNumber + ' (' + op.opName + '): Unsupported geometry.',
                    detail: (result.reason.charAt(0).toUpperCase() + result.reason.slice(1)) + '.'
                  });
                }
                return;
              }

              const chainSamples = sampleOffsetChain(result.offsetEls, result.insertions);
              // Excludes this operation's ENTIRE own geometry, not just
              // this one chain - a feature's other depth passes (or
              // other sibling features in the same operation) are the
              // same nominal shape at the same X/Y, so comparing this
              // chain's NEW position against their still-original
              // position would falsely look like a collision. Collision
              // checking is about catching surprise interaction with a
              // genuinely DIFFERENT operation, not a feature's own
              // repeats.
              const excludeSet = {};
              moves.forEach(function(m) {
                if (m.lineIndex >= op.startLine && m.lineIndex <= op.endLine) excludeSet[m.lineIndex] = true;
              });
              let chainZMin = Infinity, chainZMax = -Infinity;
              chain.forEach(function(el) {
                if (el.z < chainZMin) chainZMin = el.z;
                if (el.z > chainZMax) chainZMax = el.z;
              });
              if (pathSamplesCollideWithOthers(chainSamples, chainZMin, chainZMax, allSamples, excludeSet)) {
                rawWarnings.push({
                  opNumber: op.opNumber, opName: op.opName, opIdx: idx, kind: 'other',
                  heading: 'Operation #' + op.opNumber + ' (' + op.opName + '): Toolpath collision.',
                  detail: 'This section of the profile would cross another operation\\'s toolpath at the same depth.'
                });
                return;
              }

              for (let i = 0; i < chain.length; i++) {
                const el = result.offsetEls[i];
                const r = rewrites[chain[i].lineIndex] || {};
                r.x = el.end.x;
                r.y = el.end.y;
                if (el.type === 'arc') {
                  r.iVal = el.center.x - el.start.x;
                  r.jVal = el.center.y - el.start.y;
                  if (chain[i].isRFormat) {
                    r.isRFormat = true;
                    r.rVal = chain[i].rSign * el.radius;
                  }
                }
                rewrites[chain[i].lineIndex] = r;
                lineNotes[chain[i].lineIndex] = noteText;
              }
              result.insertions.forEach(function(ins) {
                insertions.push({ afterLineIndex: ins.afterLineIndex, text: TWC_INSERTED_N_PLACEHOLDER + ' ' + twcArcGcodeLine(ins.element, ins.isRFormat) + ' (' + noteText + ')' });
              });
            });
          });

          // Group only the "size" warnings, one per operation using the
          // tightest (smallest) safe limit found - a single operation
          // can hit this from several different features, and the user
          // just needs the one binding number (now computed as a stable,
          // whole-operation value up front, so it can't shift depending
          // on which specific offset was tried). "Other" warnings
          // (missing direction tag, collision, unsupported geometry,
          // ...) always show individually, every time - they're not
          // about a relaxable size limit, so grouping/collapsing them
          // would hide real, distinct problems.
          const sizeByOp = {};
          const opOrder = [];
          rawWarnings.forEach(function(w) {
            if (opOrder.indexOf(w.opNumber) === -1) opOrder.push(w.opNumber);
            if (w.kind === 'size') {
              if (!sizeByOp[w.opNumber] || w.maxSafe < sizeByOp[w.opNumber].maxSafe) {
                sizeByOp[w.opNumber] = { opName: w.opName, opIdx: w.opIdx, maxSafe: w.maxSafe };
              }
            }
          });

          const warnings = [];
          opOrder.forEach(function(opNumber) {
            if (sizeByOp[opNumber]) {
              const s = sizeByOp[opNumber];
              const bound = s.maxSafe.toFixed(2);
              warnings.push({
                heading: 'Operation #' + opNumber + ' (' + s.opName + '): Radial offset too large.',
                detail: 'Set offset within (-' + bound + ' and +' + bound + ') to apply an offset.',
                kind: 'size', opIdx: s.opIdx, maxSafe: s.maxSafe
              });
            }
            rawWarnings
              .filter(function(w) { return w.opNumber === opNumber && w.kind === 'other'; })
              .forEach(function(w) { warnings.push({ heading: w.heading, detail: w.detail, kind: 'other', opIdx: w.opIdx }); });
          });

          const lines = fileContent.split(/\\r?\\n/);
          const insertionsByLine = {};
          insertions.forEach(function(ins) {
            if (!insertionsByLine[ins.afterLineIndex]) insertionsByLine[ins.afterLineIndex] = [];
            insertionsByLine[ins.afterLineIndex].push(ins.text);
          });

          const outLines = [];
          for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            const isComment = /^\\s*[(;]/.test(line);

            const z = zShiftLines[i];
            let zChanged = false;
            if (z !== undefined && z !== 0 && !isComment) {
              const zRegex = rFormatArcLines[i]
                ? /(Z)(-?(?:[0-9]+[.]?[0-9]*|[.][0-9]+))/g
                : /([ZR])(-?(?:[0-9]+[.]?[0-9]*|[.][0-9]+))/g;
              line = line.replace(zRegex, function(match, letter, numStr) {
                zChanged = true;
                const num = parseFloat(numStr);
                const shifted = Math.round((num + z) * 10000) / 10000;
                return letter + shifted;
              });
            }

            const rw = rewrites[i];
            if (rw && !isComment) {
              if (rw.x !== undefined) {
                line = line.replace(/(^|\\s)X(-?(?:[0-9]+[.]?[0-9]*|[.][0-9]+))/, function(match, pre) {
                  return pre + 'X' + (Math.round(rw.x * 10000) / 10000);
                });
              }
              if (rw.y !== undefined) {
                line = line.replace(/(^|\\s)Y(-?(?:[0-9]+[.]?[0-9]*|[.][0-9]+))/, function(match, pre) {
                  return pre + 'Y' + (Math.round(rw.y * 10000) / 10000);
                });
              }
              if (rw.isRFormat && rw.rVal !== undefined) {
                line = line.replace(/(^|\\s)R(-?(?:[0-9]+[.]?[0-9]*|[.][0-9]+))/, function(match, pre) {
                  return pre + 'R' + (Math.round(rw.rVal * 10000) / 10000);
                });
              } else {
                if (rw.iVal !== undefined) {
                  line = line.replace(/(^|\\s)I(-?(?:[0-9]+[.]?[0-9]*|[.][0-9]+))/, function(match, pre) {
                    return pre + 'I' + (Math.round(rw.iVal * 10000) / 10000);
                  });
                }
                if (rw.jVal !== undefined) {
                  line = line.replace(/(^|\\s)J(-?(?:[0-9]+[.]?[0-9]*|[.][0-9]+))/, function(match, pre) {
                    return pre + 'J' + (Math.round(rw.jVal * 10000) / 10000);
                  });
                }
              }
              if (lineNotes[i]) {
                line = line + ' (' + lineNotes[i] + ')';
              }
            }
            if (zChanged && !isComment) {
              line = line + ' (TWC: [Z] ' + twcSignedFixed(z) + ')';
            }

            outLines.push(line);
            if (insertionsByLine[i]) {
              insertionsByLine[i].forEach(function(t) { outLines.push(t); });
            }
          }

          // Renumber the whole N-sequence in one final pass, so a newly
          // inserted line's number actually fits between its real
          // neighbors instead of just being unique-but-out-of-order.
          // Only lines that already start with an N-word (real original
          // lines, plus every inserted line via its placeholder) get
          // renumbered, continuing by 1 each time - matching this post
          // processor's own step size, confirmed consistent across
          // every sample file seen. The very first N-numbered line's own
          // original value seeds the count, so the file's starting
          // point is preserved; comment lines and any bare line that
          // never had an N to begin with are left alone and don't
          // consume a number. This does mean every real line's N-value
          // after the first insertion point differs from the original
          // file (shifted up by however many lines got inserted before
          // it) - an unavoidable consequence of making inserted lines
          // truly sequential rather than just collision-free.
          let nCounter = null;
          for (let k = 0; k < outLines.length; k++) {
            const nMatch = outLines[k].match(/^(\\s*)N\\d+(\\s.*)?$/);
            if (!nMatch) continue;
            if (nCounter === null) {
              const firstMatch = outLines[k].match(/^\\s*N(\\d+)/);
              nCounter = firstMatch ? parseInt(firstMatch[1], 10) : 1;
            } else {
              nCounter += 1;
            }
            outLines[k] = outLines[k].replace(/^(\\s*)N\\d+/, '$1N' + nCounter);
          }

          return { success: true, content: outLines.join('\\r\\n'), warnings: warnings };
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
              twcShowProcessingModal('Checking Your Offset(s)\\u2026', TWC_PROCESSING_TEXT);
              await twcYieldToRender();
              const twcResult = applyRadialAndZOffsets(fileContent, storedWearOffsets);
              twcHideModal();
              if (twcResult.warnings.length > 0) {
                const proceed = await twcShowWarningTable('Some Geometry Could Not Be Offset', twcResult.warnings, 'Everything else will still be applied. Continue?', true);
                if (!proceed) {
                  btn.disabled = false;
                  btn.innerHTML = '<span class="btn-life-icon">&#9889;</span> Bring This G-Code To Life!';
                  return;
                }
              }
              fileContent = twcResult.content;
            }

            // Strip any marker line left over from a previous round
            // before prepending a fresh one, so they don't accumulate on
            // every subsequent offset round.
            const cleanedContent = fileContent.split(/\\r?\\n/).filter(function(l) {
              return l.indexOf('${SW2026_MARKER_PREFIX}') === -1;
            }).join('\\r\\n');

            const transformed = '${SW2026_MARKER_PREFIX}' + Date.now() + '\\n' + cleanedContent;
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
            twcHideModal();
            btn.disabled = false;
            btn.innerHTML = '<span class="btn-life-icon">&#9889;</span> Bring This G-Code To Life!';
            await twcAlert('Failed to bring this G-code to life: ' + (err && err.message ? err.message : err));
          }
        });

        // Native target="_blank" anchor navigation was reportedly opening
        // a blank window inside the embedded dialog instead of handing
        // off to the OS's actual default browser - calling window.open()
        // explicitly from a click handler is a more reliable way to
        // trigger that hand-off in an embedded webview like this one.
        const releaseLink = document.getElementById('swReleaseLink');
        if (releaseLink) {
          releaseLink.addEventListener('click', function(e) {
            e.preventDefault();
            window.open(releaseLink.href, '_blank', 'noopener,noreferrer');
          });
        }

        // === Init ===
        renderTable();
        renderWearCompTable();
        document.querySelectorAll('#wcTableBody .wear-input').forEach(function(input) {
          updateWearInputColor(input);
        });
        updateApplySafetyBtnState();
        updateToolSectionStats();
        updateOpSectionStats();
        if (currentStatus().allReady) {
          setToolSectionState('ready');
        }
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

  const response = pluginContext.showDialog('SolidWorks G-Code Manager', html, { closable: false });

  if (response && response.action) {
    return response;
  }
  return { action: 'bypass' };
}
