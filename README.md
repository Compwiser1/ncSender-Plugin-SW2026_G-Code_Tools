# SW2026 G-Code Tools

**Version**: 1.16.0 (EXPERIMENTAL layout — see note below)
**Category**: Utility
**Requirements**: ncSender 2.0.37+ (OSS) or ncSender Pro 2.0.88+

An ncSender plugin for G-code produced by the **SolidWorks 2026 FrankenOKO post processor**. This plugin **replaces Dynamic Tool Slot Mapper** — only one of the two should be enabled at a time.

---

## 🧪 EXPERIMENTAL: new two-section layout

v1.13.0 is a first draft of a redesigned dialog and is being tested live — expect follow-up releases as feedback comes in. The single flat dialog is now split into two collapsible sections, both **collapsed by default** so the whole workflow is visible at a glance before you dive into either one:

- **🧰 Tool Manager** — the existing tool table + magazine slot carousel. Click **Organize My Tools** to add new tools to the library, auto-resolve conflicts, and auto-assign slots (section turns **✅ Ready to go!** and collapses), or click **I Don't Need This** to skip it (section turns **⏭️ Skipped**).
- **🛡️ Operation Manager** — the tool wear compensation table. Click **Apply Offset** to lock in your Z/X&Y values (section turns **✅ Ready to go!**), or click **Live On The Edge** to skip wear comp entirely (section turns **⏭️ Skipped**).

Both sections start at **⏳ In progress...** and can be reopened and changed at any time. Nothing is written to the G-code file until you click **⚡ Bring This G-Code To Life!** at the bottom — that button stays grayed out until *both* sections have been resolved (either organized/applied or explicitly skipped). It then applies whichever combination of slot translation and wear compensation each section locked in, in one combined rewrite, and reloads the file.

---

## 🎯 What it does

On G-code load, this plugin opens a single dialog with two sections:

### 1. Tool Manager — Tool Library Sync
Parses the tool summary table SolidWorks 2026 / FrankenOKO writes at the bottom of every file:

```
(  TOOL#     TOOL TYPE     DIAMETER   DESCRIPTION                     )
( -------  --------------  --------   ------------------------------  )
(   018       ENDMILL       008.00    8MM CRB 4FL 20 LOC  )
(   021     CENTER DRILL    008.00    8MM X 90DEG CRB SPOT DRILL  )
```

Reconciles it against the ncSender Tool Library:
- **🟢 New** — not in the library yet.
- **🔴 Conflict** — in the library but type/diameter/description differ from the G-code. Always auto-resolves to the G-code's values once you click **Organize My Tools** — nothing is ever overwritten silently before that.
- **⚪ In Sync** — already matches.

SolidWorks' tool-type vocabulary (`ENDMILL`, `CENTER DRILL`, `COUNTERSINK`, etc.) is automatically translated to ncSender's tool type enum (`flat`, `ball`, `v-bit`, `drill`, `chamfer`, `surfacing`, `probe`, `thread-mill`) before every add or update, since ncSender only accepts that fixed set.

Once a tool is in the library, click its **Slot** badge to open a picker and assign it to a physical ATC magazine slot. A visual carousel shows the whole magazine layout. If the target slot is already occupied by a different tool, selecting it overrides that slot - the tool that was there becomes unassigned rather than being swapped elsewhere.

**Organize My Tools** handles all of this at once: adds every new tool to the library, auto-resolves conflicts, and fills every unassigned slot. If the magazine doesn't have enough empty slots, tools occupying a slot but not used anywhere in this file are evicted (cleared from their slot, not deleted from the library) to make room — you'll see exactly what will be evicted and have to confirm before anything happens. Tools this file actually needs are never evicted.

### 2. Operation Manager — Tool Wear Compensation
Lists every **operation** in the file (not every tool), each with independent **Z Offset** and **X & Y Offset** values (-1.00 to 1.00). **Apply Offset** locks in whatever values you've entered; **Live On The Edge** skips wear comp entirely. G91 (incremental) mode lines are never touched, regardless.

**X & Y Offset actually reshapes real bores, bosses, and outer profiles.** Direction comes from the operation's `( Notes: ... )` comment - "internal" (a bore) or "external" (a boss/outer boundary); any numeric suffix like `TWC_Internal_3` is ignored. A **negative** value always means "remove more material" and a **positive** value always means "keep more material," regardless of internal/external:
- **Internal (bore):** negative → hole gets bigger; positive → hole gets smaller/tighter.
- **External (boss/outer profile):** negative → shrinks; positive → grows.

**Circular features** (v1.14.0) - a full 360° arc loop at one consistent center and radius - are detected independently of anything else nearby: a single operation can mix several separate circles (two holes, or a stepped/multi-diameter counterbore) with unrelated geometry, and each valid circle is offset on its own.

**Arbitrary profiles** (v1.15.0) - any other closed or open boundary made of lines and arcs, including a real outer part profile with separate lead-in/lead-out approach lines - are offset with true perpendicular-to-path geometry: every segment shifts along its own outward normal (direction determined from the path's winding), arcs grow or shrink depending on which way they curve, and corners are re-joined afterward (a direct intersection where the corner can simply extend or trim, or a small inserted fillet arc where growing outward opens a real gap). Open lead-in/lead-out chains have their two free ends translated but not force-closed, since they're real approach/depart moves, not part of the enclosed boundary.

Each distinct piece of geometry in an operation (each circle, each open or closed profile chain) is validated and applied **independently** - if one piece can't be safely offset, only that piece is left untouched and reported; everything else that succeeded is still applied. Two hard checks gate every piece:
- **Self-intersection** - if the requested offset would shrink a radius (or a tight corner's fillet) to zero or invert it, that piece is left untouched.
- **Cross-feature collision** - the new geometry is checked against every *other* operation's toolpath at the *same cutting depth* (Z-depth-aware, so a shallow facing pass across the whole top surface doesn't falsely block a much deeper feature below it); if it would cross another feature cut at an overlapping depth, that piece is left untouched. This only checks toolpaths actually present in the file - it can't see fixtures, vises, stock boundaries, or unmachined design intent, so visually verifying or dry-running the result before cutting real material is still recommended, especially for the first few parts.

If a non-zero value is entered on an operation whose Notes don't say "internal" or "external" at all, that operation is left untouched rather than guessed at. A value of exactly 0.00 leaves that operation completely untouched, as if the Notes field weren't there. Every G-code line that actually gets shifted (and any newly inserted corner-fillet line) gets its own trailing note, e.g. `N398 X157.0 Y37.0 I2.75 J0 (TWC: -0.10)` (or `(TWC: +0.10)` for a positive value) - lines that weren't touched (including a Z-only shift on a line with no XY change) stay clean.

### 3. Bring This G-Code To Life!
Once both sections are resolved, this rewrites `T##`/`H##` references to the assigned slot numbers (e.g. `T18 M06` → `T3 M06`, original tool number preserved in a comment) and/or shifts G-code coordinates per your wear comp values — whichever section(s) you organized rather than skipped — in one combined pass, then reloads the translated file so the ATC moves to the correct physical position. If any entered offset fails validation, nothing is written at all and every problem is reported together so you can go back and adjust.

---

## ⚠️ Behavior note

Unlike pure library maintenance, this dialog opens **every time** a file has tool changes — even if the library is already fully in sync — because slot translation has to run on every load for the ATC to work correctly. (v1.0.x used to skip the dialog when nothing needed updating; that's no longer possible once slot mapping is involved.)

---

## 📖 How to Use

1. Load a SolidWorks 2026 / FrankenOKO G-code file with a tool summary table.
2. The dialog opens automatically, showing every tool's sync status and slot assignment.
3. Click **Add Tools & Auto-Assign Slots** to prepare everything at once — or use the table to add/resolve/assign individual tools if you'd rather do it by hand.
4. Conflicts (if any) resolve automatically to the G-code's values as part of step 3 — no choice needed, the diff shown is just for your reference.
5. Adjust anything you'd like — click any tool's **Slot** badge to reassign it manually; if the target slot is occupied, you'll see which tool is there and that it will be unassigned.
6. Once the banner turns green and **Load** is enabled, click it to translate the G-code and load the mapped version.
7. Or click **Bypass** at any point to skip mapping and load the file unmapped.

---

## 🔧 Technical Details

### Parsing
Reads only the footer tool summary table, not the inline `T## M06` calls — the footer table is a clean, structured source that's far less error-prone to parse.

### Tool type mapping
`ENDMILL` → `flat` (or `ball` if "BALL"/"BULLNOSE" appears in the type or description); `DRILL`/`CENTER DRILL` → `drill`; `COUNTERSINK` → `chamfer`. Unrecognized types fall back to `flat` and log a warning.

### Library updates
- **Add**: `POST /api/tools` with `{ toolId, type, diameter, name, toolNumber: null }`.
- **Conflict resolution (Use G-code)**: `PUT /api/tools/{id}`, spread over the existing record so unrelated fields are preserved.
- **Slot assignment**: `PUT /api/tools/{id}` updating `toolNumber` (the magazine slot field). Assigning an occupied slot clears the previous occupant's `toolNumber` (unassigning it) before assigning the new tool to that slot - an override, not a swap.

### G-code translation
Runs in the browser (not the Jint plugin sandbox) to avoid its 50 MB memory cap on large files. Prepends a marker comment so the reload triggered by uploading the translated file doesn't re-fire this plugin in a loop. Retries the upload with backoff to handle a Windows file-lock race between the original file write and this plugin's write.

### Compatibility
- **ncSender (OSS)**: 2.0.37 or higher
- **ncSender Pro**: 2.0.88 or higher
- Runs in the `pro-v2` runtime (Jint sandbox). Requires `onGcodeProgramLoad`, `pluginContext.showDialog()`, and `pluginContext.getTools()`.

---

## 🚧 Planned

- Feedback-driven refinements to the new two-section EXPERIMENTAL layout
- Additional SolidWorks 2026 / FrankenOKO post-processor-aware tooling

---

## 📄 License

This plugin is provided as-is for use with ncSender.

