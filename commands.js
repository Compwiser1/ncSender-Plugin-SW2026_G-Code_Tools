/*
 * SW2026 G-Code Tools - ncSender v2 plugin
 *
 * Tools for G-code produced by the SolidWorks 2026 FrankenOKO post
 * processor. This first capability is Tool Library Sync: on G-code load,
 * the plugin parses the tool summary table the post processor writes at
 * the bottom of every file (TOOL# / TOOL TYPE / DIAMETER / DESCRIPTION)
 * and reconciles it against the ncSender Tool Library.
 *
 *   - Tools present in the G-code but missing from the library -> "New",
 *     added in one click via "Add New Tools to Library".
 *   - Tools present in both but with a different type/diameter/description
 *     -> "Conflict", flagged red and left for the user to resolve manually
 *     (never auto-overwritten).
 *   - Tools that already match -> "In Sync", no action, and if EVERY tool
 *     is already in sync the dialog doesn't even open.
 *
 * This plugin never rewrites the G-code itself - onGcodeProgramLoad always
 * returns the original content unchanged. It only maintains the Tool
 * Library so later steps (manual tool assignment, ATC slot mapping, tool
 * wear compensation, etc. - planned for future versions of this plugin)
 * have accurate data to work with.
 *
 * Runs in the v2 Jint sandbox via onGcodeProgramLoad. The host injects a
 * `pluginContext` global with: log(), getTools(), showDialog().
 *
 * This plugin replaces Dynamic Tool Slot Mapper. Only one of the two
 * should be enabled at a time to avoid duplicate dialogs on file load.
 */

// === Plugin settings (sanitize / defaults) ===
// No persisted user settings yet. Reserved for future SW2026 G-Code Tools
// features (tool wear compensation, etc.).
function buildInitialConfig(raw) {
  return {};
}

// === Entry point ===

function onGcodeProgramLoad(content, context, settings) {
  // Top-level try/catch is load-bearing: AOT-compiled hosts can crash hard
  // on unhandled JS exceptions. Always return original content on failure
  // (host sees a graceful fallback, user can still load the file as-is).
  try {
    safeLog('SW2026 G-Code Tools: scanning tool table (' + Math.round(content.length / 1024) + ' KB)...');

    const gcodeTools = parseToolTable(content);
    if (gcodeTools.length === 0) {
      safeLog('No tool summary table found in this file - nothing to sync');
      return content;
    }

    const toolLibrary = loadToolLibrary();
    const rows = buildComparisonRows(gcodeTools, toolLibrary);

    const hasConflicts = rows.some(function(r) { return r.action === 'conflict'; });
    const hasNew = rows.some(function(r) { return r.action === 'add'; });

    if (!hasConflicts && !hasNew) {
      safeLog('Tool Library already in sync with this file\'s tool table (' + rows.length + ' tool(s) checked)');
      return content;
    }

    const status = hasConflicts ? 'red' : 'yellow';
    safeLog((hasConflicts ? 'Conflicts' : 'New tools') + ' found - opening Tool Library Sync dialog');
    showSyncDialog(context && context.filename, rows, status, toolLibrary);

    // This plugin never modifies G-code content.
    return content;

  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    safeLog('[SW2026] onGcodeProgramLoad failed: ' + msg);
    return content;
  }
}

// safeLog never throws - even if pluginContext.log itself misbehaves we
// silently drop the message rather than crash the plugin. Prefix [SW2026]
// for easy grepping in the host log alongside other plugins.
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
    tools.push({
      toolNumber: toolNumber,
      type: m[2].trim(),
      diameter: diameter,
      description: m[4].trim()
    });
  }
  return tools;
}

// === Compare parsed tools against the library ===

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
        libDescription: null
      });
    }

    const libType = (libTool.type || '').trim();
    const libDiameterNum = (typeof libTool.diameter === 'number') ? libTool.diameter : parseFloat(libTool.diameter);
    const libDescription = (libTool.name || '').trim();

    const typeMatch = libType.toUpperCase() === gt.type.toUpperCase();
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
        libDescription: libDescription
      });
    }

    return Object.assign({}, gt, {
      action: 'conflict',
      statusClass: 'red',
      statusLabel: 'Conflict',
      libId: libTool.id,
      libType: libType,
      libDiameter: libDiameterNum,
      libDescription: libDescription
    });
  });
}

// === Sync dialog ===

function showSyncDialog(filename, rows, status, toolLibrary) {
  const statusConfig = {
    red: {
      color: '#dc3545',
      bgColor: 'rgba(220, 53, 69, 0.1)',
      icon: '🔴',
      title: 'Tool Library Conflicts Found',
      message: 'Some tools in this file don\'t match the ncSender Tool Library. Resolve each conflict below, then add any new tools.'
    },
    yellow: {
      color: '#ffc107',
      bgColor: 'rgba(255, 193, 7, 0.1)',
      icon: '🟡',
      title: 'New Tools Found',
      message: 'Some tools in this file aren\'t in your ncSender Tool Library yet. Click "Add New Tools to Library" to add them.'
    }
  };
  const config = statusConfig[status];

  // Normalize toolLibrary keyed by toolId for the dialog JS (needed so PUT
  // requests can spread over the full existing tool record rather than
  // clobbering fields this plugin doesn't know about, e.g. an assigned
  // magazine slot).
  const dialogToolLibrary = {};
  Object.keys(toolLibrary).forEach(function(key) {
    const tool = toolLibrary[key];
    const toolId = (tool.toolId !== undefined && tool.toolId !== null) ? tool.toolId : tool.id;
    dialogToolLibrary[toolId] = Object.assign({}, tool, { toolId: toolId });
  });

  const html = `
    <style>
      .sync-container {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
        color: var(--color-text-primary, #e0e0e0);
        padding: 20px;
        max-width: 760px;
        margin: 0 auto;
      }
      .sync-header { text-align: center; margin-bottom: 20px; }
      .sync-header h2 { margin: 0 0 8px 0; font-size: 1.3rem; }
      .sync-filename { color: var(--color-text-secondary); font-size: 0.9rem; word-break: break-all; }
      .sync-banner {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 12px 20px;
        border-radius: 8px;
        font-size: 1.1rem;
        font-weight: 600;
        margin: 16px 0;
        background: ${config.bgColor};
        border: 2px solid ${config.color};
        color: ${config.color};
      }
      .sync-message {
        background: var(--color-surface-muted, #1a1a1a);
        padding: 16px;
        border-radius: 8px;
        margin-bottom: 20px;
        line-height: 1.5;
      }
      .tools-table-container {
        max-height: 440px;
        overflow-y: auto;
        border: 1px solid var(--color-border, #444);
        border-radius: 8px;
        margin-bottom: 16px;
      }
      .tools-table { width: 100%; border-collapse: collapse; }
      .tools-table thead {
        position: sticky;
        top: 0;
        background: var(--color-surface-muted, #1a1a1a);
        z-index: 10;
      }
      .tools-table th {
        padding: 8px 12px;
        text-align: left;
        font-weight: 600;
        border-bottom: 2px solid var(--color-border, #444);
        font-size: 0.85rem;
      }
      .tools-table td {
        padding: 8px 12px;
        border-bottom: 1px solid var(--color-border, #333);
        vertical-align: top;
      }
      .tools-table tbody tr:hover { background: var(--color-border, #2a2a2a); }
      .row-status-badge {
        display: inline-block;
        padding: 4px 10px;
        border-radius: 4px;
        font-size: 0.75rem;
        font-weight: 600;
        text-transform: uppercase;
        border: 1px solid transparent;
        white-space: nowrap;
      }
      .row-status-badge--green { background: rgba(40, 167, 69, 0.2); color: #28a745; border-color: #28a745; }
      .row-status-badge--gray { background: rgba(153, 153, 153, 0.15); color: #999; border-color: #666; }
      .row-status-badge--red { background: rgba(220, 53, 69, 0.2); color: #dc3545; border-color: #dc3545; }
      .tool-num { font-weight: 700; font-size: 1rem; }
      .conflict-diff {
        margin-top: 6px;
        font-size: 0.78rem;
        line-height: 1.6;
      }
      .conflict-diff .lib-val { color: #f59e0b; }
      .conflict-diff .gcode-val { color: #1abc9c; }
      .conflict-actions {
        display: flex;
        gap: 6px;
        margin-top: 8px;
      }
      .btn {
        padding: 12px 24px;
        border: none;
        border-radius: 6px;
        font-size: 1rem;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.2s;
      }
      .btn:disabled { opacity: 0.5; cursor: default; }
      .btn-sm {
        padding: 6px 10px;
        font-size: 0.75rem;
        border-radius: 4px;
      }
      .btn-primary { background: var(--color-accent, #1abc9c); color: white; }
      .btn-primary:hover { opacity: 0.9; }
      .btn-secondary {
        background: var(--color-surface-muted, #2a2a2a);
        color: var(--color-text-primary);
        border: 1px solid var(--color-border, #444);
      }
      .btn-secondary:hover { background: var(--color-border, #444); }
      .btn-warning { background: #ffc107; color: #000; }
      .btn-outline-green {
        background: transparent;
        color: #1abc9c;
        border: 1px solid #1abc9c;
      }
      .btn-outline-amber {
        background: transparent;
        color: #f59e0b;
        border: 1px solid #f59e0b;
      }
      .resolved-tag {
        font-size: 0.75rem;
        font-style: italic;
        color: var(--color-text-secondary, #999);
      }
      .actions {
        display: flex;
        gap: 12px;
        justify-content: center;
        margin-top: 20px;
      }
    </style>

    <div class="sync-container">
      <div class="sync-header">
        <div class="sync-filename">${filename || 'G-Code File'}</div>
        <div class="sync-banner" id="syncBanner">
          <span id="syncIcon">${config.icon}</span>
          <span id="syncTitle">${config.title}</span>
        </div>
      </div>

      <div class="sync-message" id="syncMessage">${config.message}</div>

      <div class="tools-table-container">
        <table class="tools-table">
          <thead>
            <tr>
              <th>Tool #</th>
              <th>G-Code Data</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody id="toolsTableBody"></tbody>
        </table>
      </div>

      <div class="actions">
        <button id="addNewBtn" class="btn btn-primary">Add New Tools to Library</button>
        <button id="closeBtn" class="btn btn-secondary">Close</button>
      </div>
    </div>

    <script>
      (function() {
        const rows = ${JSON.stringify(rows)};
        const toolLibrary = ${JSON.stringify(dialogToolLibrary)};

        function escapeHtml(s) {
          return String(s === null || s === undefined ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }

        function renderTable() {
          const tbody = document.getElementById('toolsTableBody');
          tbody.innerHTML = rows.map(function(r, idx) {
            let gcodeCell = '<div><strong>' + escapeHtml(r.type) + '</strong> — ' +
              r.diameter.toFixed(2) + ' mm</div><div>' + escapeHtml(r.description) + '</div>';

            let statusCell = '<span class="row-status-badge row-status-badge--' + r.statusClass + '">' +
              escapeHtml(r.statusLabel) + '</span>';

            if (r.action === 'conflict') {
              statusCell += '<div class="conflict-diff">' +
                '<div class="lib-val">Library: ' + escapeHtml(r.libType) + ' — ' +
                  (r.libDiameter !== null ? r.libDiameter.toFixed(2) : '?') + ' mm — ' + escapeHtml(r.libDescription) + '</div>' +
                '<div class="gcode-val">G-code: ' + escapeHtml(r.type) + ' — ' + r.diameter.toFixed(2) + ' mm — ' + escapeHtml(r.description) + '</div>' +
              '</div>';

              if (r.resolved) {
                statusCell += '<div class="resolved-tag">Resolved: ' + (r.resolved === 'gcode' ? 'used G-code value' : 'kept library value') + '</div>';
              } else {
                statusCell += '<div class="conflict-actions">' +
                  '<button class="btn btn-sm btn-outline-green" data-action="use-gcode" data-idx="' + idx + '">Use G-code</button>' +
                  '<button class="btn btn-sm btn-outline-amber" data-action="keep-library" data-idx="' + idx + '">Keep Library</button>' +
                '</div>';
              }
            }

            return '<tr><td class="tool-num">' + r.toolNumber + '</td><td>' + gcodeCell + '</td><td>' + statusCell + '</td></tr>';
          }).join('');
        }

        function updateBanner() {
          const hasConflicts = rows.some(function(r) { return r.action === 'conflict' && !r.resolved; });
          const hasNew = rows.some(function(r) { return r.action === 'add'; });

          const cfg = hasConflicts
            ? { color: '#dc3545', bg: 'rgba(220, 53, 69, 0.1)', icon: '🔴', title: 'Tool Library Conflicts Found', msg: 'Some tools in this file don\\'t match the ncSender Tool Library. Resolve each conflict below, then add any new tools.' }
            : hasNew
              ? { color: '#ffc107', bg: 'rgba(255, 193, 7, 0.1)', icon: '🟡', title: 'New Tools Found', msg: 'Some tools in this file aren\\'t in your ncSender Tool Library yet. Click "Add New Tools to Library" to add them.' }
              : { color: '#28a745', bg: 'rgba(40, 167, 69, 0.1)', icon: '🟢', title: 'Tool Library In Sync', msg: 'All tools in this file now match the ncSender Tool Library.' };

          const banner = document.getElementById('syncBanner');
          banner.style.background = cfg.bg;
          banner.style.borderColor = cfg.color;
          banner.style.color = cfg.color;
          document.getElementById('syncIcon').textContent = cfg.icon;
          document.getElementById('syncTitle').textContent = cfg.title;
          document.getElementById('syncMessage').textContent = cfg.msg;

          const addBtn = document.getElementById('addNewBtn');
          addBtn.disabled = !hasNew;
        }

        document.getElementById('toolsTableBody').addEventListener('click', async function(e) {
          const btn = e.target.closest('button[data-action]');
          if (!btn) return;

          const idx = parseInt(btn.getAttribute('data-idx'), 10);
          const row = rows[idx];
          if (!row) return;

          const action = btn.getAttribute('data-action');
          btn.disabled = true;

          try {
            if (action === 'use-gcode') {
              const rawLibTool = toolLibrary[row.toolNumber] || {};
              await fetch('/api/tools/' + row.libId, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(Object.assign({}, rawLibTool, {
                  type: row.type,
                  diameter: row.diameter,
                  name: row.description
                }))
              });
              row.resolved = 'gcode';
            } else if (action === 'keep-library') {
              row.resolved = 'library';
            }
          } catch (err) {
            alert('Failed to resolve tool #' + row.toolNumber + ': ' + (err && err.message ? err.message : err));
          } finally {
            renderTable();
            updateBanner();
          }
        });

        document.getElementById('addNewBtn').addEventListener('click', async function() {
          const addBtn = document.getElementById('addNewBtn');
          addBtn.disabled = true;
          addBtn.textContent = 'Adding…';

          const newRows = rows.filter(function(r) { return r.action === 'add'; });
          let failures = 0;

          for (const row of newRows) {
            try {
              const res = await fetch('/api/tools', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  toolId: row.toolNumber,
                  type: row.type,
                  diameter: row.diameter,
                  name: row.description,
                  toolNumber: null
                })
              });
              if (res.ok) {
                row.action = 'match';
                row.statusClass = 'gray';
                row.statusLabel = 'Added';
              } else {
                failures++;
              }
            } catch (err) {
              failures++;
            }
          }

          addBtn.textContent = 'Add New Tools to Library';
          renderTable();
          updateBanner();

          if (failures > 0) {
            alert(failures + ' tool(s) failed to add. Check the ncSender log for details.');
          }
        });

        document.getElementById('closeBtn').addEventListener('click', function() {
          window.parent.postMessage({
            type: 'close-plugin-dialog',
            data: { action: 'close' }
          }, '*');
        });

        renderTable();
        updateBanner();
      })();
    <\/script>
  `;

  if (typeof pluginContext.showDialog !== 'function') {
    throw new Error('pluginContext.showDialog is not available — host needs ncSender 2.0.37+ (OSS) or 2.0.88+ (Pro)');
  }

  const response = pluginContext.showDialog('SW2026 G-Code Tools (Tool Library Sync)', html, { closable: true });

  if (response && response.action) {
    return response;
  }
  return { action: 'close' };
}
