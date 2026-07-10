## v1.1.0

- **New: Slot Mapping + G-code Translation.** The Tool Library Sync dialog is now a single unified workflow:
  1. Add new tools to the library and resolve any conflicts (same as v1.0.x)
  2. Assign every tool to a physical ATC magazine slot via a visual slot carousel — click any tool's slot badge to open a picker, with automatic 3-step swapping if the target slot is already occupied by a different tool
  3. Click **"Map Tools & Load"** to rewrite the file's T##/H## references to the assigned slot numbers (e.g. `T18 M06` → `T3 M06`) and reload the translated file — the same mechanism Dynamic Tool Slot Mapper used, now built into this plugin
- **"Map Tools & Load" stays disabled** until every tool is added, every conflict is resolved, and every tool has a slot assigned — you can't accidentally run a file with unmapped tools.
- **"Bypass"** skips mapping entirely and loads the file as-is, same as DTSM had.
- **Behavior change from v1.0.x:** the dialog now opens every time a file has tool changes, even if the library is already fully in sync. This reverses v1.0.0's "no dialog if everything already matches" behavior — it has to, since slot translation must run on every load for the ATC to move to the correct physical position, not just when the library needs updating.
- Reuses the same SolidWorks-to-ncSender type mapping introduced in v1.0.1.

## v1.0.1

- Fix: "Add New Tools to Library" was failing for every tool with a 400 error (`Invalid tool type`). ncSender's Tool Library only accepts a fixed set of types (`flat`, `ball`, `v-bit`, `drill`, `chamfer`, `surfacing`, `probe`, `thread-mill`), but the plugin was sending SolidWorks' own tool-type wording (`ENDMILL`, `CENTER DRILL`, `COUNTERSINK`, etc.) straight through.
- Added a type-mapping layer that translates SolidWorks/FrankenOKO tool types to ncSender's enum before every add or conflict-resolution API call:
  - `ENDMILL` → `flat` (or `ball` if "BALL"/"BULLNOSE" appears in the type or description)
  - `DRILL`, `CENTER DRILL` → `drill`
  - `COUNTERSINK` → `chamfer`
  - Unrecognized types fall back to `flat` and log a warning in the ncSender log instead of failing.
- The dialog now shows both the mapped type and the original SolidWorks type side by side, e.g. "flat (ENDMILL)".
- Add/update failures now show the real server error message instead of a generic "failed" alert.

## v1.0.0

- Initial release of SW2026 G-Code Tools, replacing Dynamic Tool Slot Mapper.
- Tool Library Sync: on G-code load, parses the tool summary table written by the SolidWorks 2026 FrankenOKO post processor and reconciles it against the ncSender Tool Library.
  - New tools are added in one click.
  - Tools with mismatched type/diameter/description are flagged as conflicts for manual resolution (never auto-overwritten).
  - If everything already matches, no dialog opens.
- This plugin never rewrites G-code — it only maintains the Tool Library.
