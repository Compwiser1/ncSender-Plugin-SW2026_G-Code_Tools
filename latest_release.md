## v1.0.1

- Fix: map SolidWorks tool types (ENDMILL, DRILL, CENTER DRILL, COUNTERSINK) to ncSender's tool type enum (flat, ball, v-bit, drill, chamfer, surfacing, probe, thread-mill) before syncing to the Tool Library. Previously the raw SolidWorks type strings were sent to `/api/tools` and rejected with a 400 error, so adding new tools and resolving conflicts with "Use G-code" silently failed. Unknown types fall back to `flat` so a new SolidWorks type never blocks the sync.

## v1.0.0

- Initial release of SW2026 G-Code Tools, replacing Dynamic Tool Slot Mapper.
- Tool Library Sync: on G-code load, parses the tool summary table written by the SolidWorks 2026 FrankenOKO post processor and reconciles it against the ncSender Tool Library.
  - New tools are added in one click.
  - Tools with mismatched type/diameter/description are flagged as conflicts for manual resolution (never auto-overwritten).
  - If everything already matches, no dialog opens.
- This plugin never rewrites G-code — it only maintains the Tool Library.
