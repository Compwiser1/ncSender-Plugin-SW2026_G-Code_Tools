## v1.5.0

- Moved the slot carousel below the status message instead of side-by-side — the two-column layout from v1.4.0 made the carousel too cramped.
- G-Code Data column now shows one clean combined label instead of "flat (ENDMILL)" — e.g. "**Flat Endmill**" or "**Drill Center Drill**" — bold, with diameter and description in italics below it. Deduplicates when the mapped type and G-code type are the same word (e.g. "Drill" instead of "Drill Drill").
- "In Sync" status badge is now green instead of gray, matching "New."
- Narrowed the Tool # and Slot columns to just fit their content, giving that space back to the G-Code Data column.

## v1.4.0

- **Conflicts no longer require a choice.** Removed the "Use G-code" / "Keep Library" buttons — conflicts always resolve to the G-code's values automatically when "Add Tools & Auto-Assign Slots" runs. The table still shows the library-vs-G-code diff for transparency before that happens; there's just nothing to click anymore.
- **Redesigned the dialog to be wider and more compact.** Widened from ~820px to ~1180px, and restructured the layout so the status message and slot carousel sit side by side instead of stacked, with tighter padding and smaller row heights throughout. Goal: all 8 magazine slots visible at once without scrolling, on a typical desktop window.

## v1.3.0

- **Simplified the dialog to three buttons.** "Add New Tools to Library" and "Auto-Assign Slots" are now one button — **"Add Tools & Auto-Assign Slots"** — that runs both steps back to back: adds every new tool to the library, then fills every unassigned slot (evicting unused tools if the magazine's full, same confirmation as before).
- After that button runs, the table still reflects live state, so you can review and adjust anything — resolve a conflict, manually reassign a specific slot — before clicking **"Load"** (renamed from "Map Tools & Load") to translate the G-code and run the file.
- **"Bypass"** is unchanged — skips everything and loads the file as-is.
- No behavior change to the underlying add/assign/conflict/translation logic from v1.2.0 - this is a UI consolidation only.

## v1.2.0

- **New: Auto-Assign Slots.** A new button next to "Add New Tools to Library" fills every tool that's in the library but has no magazine slot yet, automatically.
  - Only tools already in the library are eligible — add new tools first if the button is grayed out.
  - If there aren't enough empty magazine slots, tools currently occupying a slot but **not used anywhere in this G-code file** are automatically evicted (their slot cleared, not deleted from the library) to make room. Tools this file actually needs are never evicted.
  - Before evicting anything, you're shown exactly which slots/tools will be cleared and asked to confirm.
  - If there still aren't enough slots even after evicting everything possible, you're told so and can finish the remaining assignments manually via the existing click-to-assign slot picker.
  - Manual slot assignment (clicking a tool's Slot badge) is still available and unchanged — Auto-Assign is a shortcut, not a replacement.

## v1.1.1

- Fix: `manifest.json`'s `repository` field pointed to a placeholder URL left over from adapting Dynamic Tool Slot Mapper's manifest, instead of this plugin's actual repo. This silently broke ncSender's in-app "Check for Update" button — every field (latest version, download URL, release notes) came back blank because it was querying a repo that doesn't exist. Now points to the correct repository.
- CI: every release now also publishes an unversioned `com.ncsender.sw2026-gcode-tools-latest.zip` asset alongside the versioned zip, so `.../releases/latest/download/com.ncsender.sw2026-gcode-tools-latest.zip` is a permanent install URL that never needs updating.

## v1.1.0

- **Fix: `manifest.json`'s `repository` field pointed to a placeholder URL** (`github.com/cotepat/ncsender-plugin-sw2026-gcode-tools`, left over from adapting Dynamic Tool Slot Mapper's manifest) instead of the actual repo. This silently broke ncSender's in-app "Check for Update" — it was querying a nonexistent repo and getting back nothing, so every field (latest version, download URL, release notes) came back blank. Now points to `github.com/Compwiser1/ncSender-Plugin-SW2026_G-Code_Tools`, so the Plugins screen's Update button will work correctly going forward.
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
