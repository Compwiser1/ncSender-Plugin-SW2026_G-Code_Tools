## v1.13.10 (EXPERIMENTAL — reverted row height, removed program name, inline stats)

- **Reverted v1.13.9's row-height reduction** - the tools table already scrolls independently, so shrinking rows didn't address the real constraint, which is the magazine carousel image driving the section's overall visible height, not the table. Rows are back to 64px.
- **Removed the "Program Name" header entirely** from the top of the dialog.
- **Tool Manager's stats moved onto the same line as the header text**, centered in the space between the section title and the status badge, instead of sitting on their own line underneath. Operation Manager's stats are unchanged (still on their own line below the title).

## v1.13.9 (EXPERIMENTAL — real fix for "more visible without scrolling")

- **Tool Manager's table rows are now 44px tall instead of 64px.** The 64px height was leftover from when each row had its own wear-comp stepper control (which needed the extra vertical room) - that column moved to Operation Manager back in v1.13.0, but the row height was never reduced afterward. With rows this much shorter, roughly 4-5 more tools are visible before the table needs to scroll internally, for a typical 8-slot magazine.
- **Removed the two previous height-fix attempts** (v1.13.6's container padding, v1.13.7's spacer element) since neither had any visible effect - that was a signal the dialog's outer size isn't driven by page content at all, so padding/spacer tricks were the wrong lever. This release fixes the actual "more visible without scrolling" complaint a different way: by making better use of the space Tool Manager already has, rather than trying to grow the outer dialog frame.
- Conflict rows (which show an extra library-vs-G-code diff underneath the status badge) still grow taller than 44px automatically to fit that content - only simple rows got shorter.

## v1.13.8 (EXPERIMENTAL — icon fix, height fix still under investigation)

- **"Living On The Edge" (Operation Manager's skipped state) now shows a mountain/cliff icon (⛰️)** instead of the generic skip icon - a better fit for the wording. Tool Manager's "I Didn't Need This" state keeps its original icon, unchanged.
- **The dialog height issue is still unresolved.** Two different content-based approaches (v1.13.6's extra padding, v1.13.7's real spacer element) both had zero visible effect, which strongly suggests the dialog's rendered size isn't driven by our HTML content at all - more likely the host sets a fixed size via `pluginContext.showDialog()`'s options argument (currently only `{ closable: false }`), or via its own fixed dialog dimensions, and our page content simply scrolls or gets clipped inside that fixed frame regardless of how much content height we add. No CSS change was made this round for this issue - see the note in the response for what's needed to actually fix it.

## v1.13.7 (EXPERIMENTAL — badge wording + real height spacer)

- **Badge wording updated per your latest preference**: Tool Manager now reads "Tools Organized" / "I Didn't Need This" (was "Organize My Tools" / "I Don't Need This"); Operation Manager now reads "Safety Net Applied" / "Living On The Edge" (was "Apply My Safety Net" / "Live On The Edge").
- **Retried the extra dialog height fix differently**: v1.13.6's approach (extra `padding-bottom` on the container) had no visible effect, so this version replaces it with a real block-level spacer element after the "Bring This G-Code To Life!" button instead - padding alone may not be picked up by whatever method ncSender uses to measure content height, while an actual element with height is far more likely to be. Still first-draft/untested in the real app - let us know if this one doesn't show up either, since at that point the fix probably needs to happen on ncSender's sizing logic rather than ours.

## v1.13.6 (EXPERIMENTAL — badge/button alignment + height fix)

- **Both section headers now always show the exact button text that was clicked**, instead of generic "Ready to go!"/"Skipped" wording: Tool Manager reads "Organize My Tools" or "I Don't Need This"; Operation Manager reads "Apply My Safety Net" or "Live On The Edge". Header and button can no longer drift out of sync with each other since the badge text is driven directly from the same label.
- **Reserved extra vertical space in the dialog equal to Tool Manager's action-button row height**, so the button row has consistent room regardless of which section happens to be expanded or collapsed.

## v1.13.5 (EXPERIMENTAL — badge wording + header alignment)

- **Operation Manager's skipped badge now reads "Live On The Edge"** instead of "Skipped", matching the button that produces that state. Tool Manager's skipped badge is unchanged and still reads "Skipped".
- **All Operation Manager table column headers are now center-aligned** (Operation and Tool Description were previously left-aligned; the body cell content itself still wraps naturally, only the header labels changed).

## v1.13.4 (EXPERIMENTAL — header summary stats)

- **TOOL MANAGER header now shows a stats line**: total tool count plus a color-coded status breakdown - 🟢 In Sync, 🟠 New, 🔴 Conflict - using the same colors as each row's status badge, so you can tell whether Organize My Tools has real work to do without expanding the section.
- **OPERATION MANAGER header now shows a stats line**: total operation count, how many currently have a non-zero compensation value set ("N of M set"), and how many distinct tools are used across all operations. The coverage count updates live as you type or use the stepper arrows.
- Both stats lines sit under the section title, update automatically after any tool-library change (Organize My Tools, manual slot assignment, conflict resolution), and don't require expanding the section to see.

## v1.13.3 (EXPERIMENTAL — naming + operation notes)

- **Dialog title changed** from "SolidWorks 2026 G-Code Tools" to **"SolidWorks G-Code Manager"**.
- **Section headers renamed and now render in uppercase**: "Tool management" → **TOOL MANAGER**, "Operation management" → **OPERATION MANAGER**.
- **"Living On The Edge" renamed to "Live On The Edge"** (grammar fix).
- **Operation management's Operation column now shows the operation's Notes comment**, not just its name - the post processor always writes a `( Notes: ... )` line directly under each `( Operation #N: Name )` header, and that's now parsed and displayed. Operation name is bold, notes render smaller and italic underneath, matching the Tool Description column's visual style (name bold, detail italic) - unlike Tool Description, this text wraps rather than truncating.

## v1.13.2 (EXPERIMENTAL — layout tweaks continued)

- **"Skipped" badge is now red** instead of gray, matching the red glow on the "I Don't Need This" / "Living On The Edge" buttons that produce that state.
- **Operation management's Operation column now shows the operation's comment text in italic**, matching the Tool Description column's style - unlike Tool Description, this text is allowed to wrap rather than being truncated with an ellipsis, since operation names/comments can run long.
- **Tool management and Operation management now always render at the same width** (Tool management's, the wider of the two, since it also has to fit the tool table + magazine carousel side by side). Previously the dialog could size itself to whichever section happened to be expanded, so Operation management alone looked narrower - the container now holds a fixed width regardless of which section is open or closed.

## v1.13.1 (EXPERIMENTAL — layout tweaks from first live test)

Follow-up fixes to the v1.13.0 two-section layout based on initial feedback:

- **"I Don't Need This" and "Living On The Edge"** now match "Apply My Safety Net"'s solid glow styling, just red instead of green - consistent visual weight for the skip choice, not an outlined/quiet look.
- **"Skipped" badge is now the same size** as "Ready to go!" and "In progress..." - it was rendering smaller before since the gray badge variant was missing the font-size/padding the other two had.
- **"Apply My Safety Net" starts grayed out** and only lights up green once at least one Z Comp or X&Y Comp value anywhere in the section is non-zero - it re-grays if you zero everything back out.
- **New "Tool Description" column in Operation management**, placed right after Tool #, showing the same tool-type/diameter/description text as Tool management's column for that tool number - both sections now describe a tool identically.
- **Renamed "Program Tool Information" to "Tool Description"** in Tool management for consistency with the new Operation management column.
- **Section expand/collapse arrows are now touch-friendly** - enlarged to the same glyph size and tap-target padding as the Z/X&Y Comp stepper arrows, instead of a small fixed-size caret.
- **Tool management now auto-marks itself "Ready to go!"** on load if every tool is already In Sync and every slot is already assigned - no need to click Organize My Tools just to confirm nothing needs doing.

## v1.13.0 (EXPERIMENTAL — layout redesign, not final)

**Dialog restructured into two collapsible sections** — a first draft being tested live, expect follow-up tweaks.

- **🧰 Tool management** and **🛡️ Operation management** replace the old flat single-dialog layout. Both start **collapsed** so the whole workflow is visible before diving into either one; either can be reopened and re-edited at any time.
- Each section shows its own status badge with an icon: **⏳ In progress...** (default) → **✅ Ready to go!** or **⏭️ Skipped**.
- **Tool management** buttons: **Organize My Tools** (adds new tools to the library, auto-resolves conflicts, auto-assigns slots — same underlying logic as the old "Add & Assign", now section-scoped) and **I Don't Need This** (skips tool sync/slot translation for this file).
- **Operation management** buttons: **Apply My Safety Net** (locks in the entered Z/X&Y wear comp values) and **Living On The Edge** (skips wear comp entirely).
- **New bottom button: ⚡ Bring This G-Code To Life!** — replaces the old separate "Apply"/"Load" and "Apply Wear Comp" buttons. Stays disabled until *both* sections are resolved (organized/applied or explicitly skipped), then runs whichever combination of slot translation and wear compensation was locked in as a single combined G-code rewrite and reloads the file once.
- **Removed a dead/unused UI element**: the old tools table had a "Tool Wear Compensation" column with per-tool stepper inputs that were never actually wired to any Apply logic (the real, functional wear comp UI was always the separate per-operation table). That column is gone; the polished stepper control design (small glyph, large invisible touch target) that had been built for it was moved onto the real per-operation Z Comp / X&Y Comp inputs instead, which previously had no stepper at all.
- Tool wear compensation and slot translation are now computed in memory and sent as a single combined write when "Bring This G-Code To Life!" is clicked, instead of two separate `load-temp` calls at different points in the flow.
- Verified against both the tool-translation regex and the wear-compensation G90/G91-aware transform using the real `Test_15.txt` sample file (including the `G91 G28 Z0` tool-change retract safety case) before release.

## v1.12.1

**Fix: two dialogs opening at once.** v1.12.0's "reload the file to reopen Wear Compensation" design was broken: clicking a file in ncSender's file browser reads fresh from disk, which never had our marker written to it (the marker only ever existed in a temporary in-memory version created by `load-temp`). So reloading actually fired `onGcodeProgramLoad` from two separate sources at once - the on-disk original (no marker, opened the normal sync/slot dialog) and whatever ncSender still had cached as "current" (marker present, opened Wear Compensation) - both dialogs stacking on screen simultaneously.

**Redesigned to avoid this entirely:** Tool Wear Compensation is now a toggleable section *within* the same main dialog (a "Tool Wear Compensation" button shows/hides it), rather than a separate dialog triggered by a fragile reload-detection heuristic. Only one dialog ever exists.

**Also found and fixed two escaping bugs** while re-verifying the transform logic against the real sample file after this rebuild - both caused by using single backslashes (`\r`, `\n`, `\s`, `\(`) in code that lives inside a template literal one level too deep, causing premature conversion to raw control characters instead of surviving as literal escape-sequence text for the browser to interpret. Caught via the same "extract the actual generated code and test it directly" process used throughout this feature's development, not by inspection alone.

## v1.12.0

**Tool Wear Compensation - real feature, not experimental.**

Since `pluginContext.registerToolMenu()` was confirmed unavailable in this runtime (tested in v1.11.1/v1.11.2 - no menu item ever appeared, and no "Tools tab" could even be found in the app), this reuses the one mechanism proven to work throughout this whole plugin: `onGcodeProgramLoad`. **Reopen it by reloading the same already-processed file** - the plugin recognizes its own marker and opens Tool Wear Compensation instead of re-running the tool sync/slot workflow.

- Lists every **operation** in the file (e.g. "Operation #5: Center Drill1"), not every tool - a tool used across several operations gets a separate row and separate compensation values for each one.
- Two independent values per operation: **Z Comp** and **X&Y Comp**, each a signed `#.##` value from -1.00 to 1.00.
- Applying rewrites the G-code: every absolute-mode (G90) X/Y coordinate in that operation's lines shifts by the X&Y value, every absolute-mode Z or R (canned-cycle retract plane) coordinate shifts by the Z value.
- **G91 (incremental) mode is never touched.** This was a real, verified risk during development: a standard `G91 G28 Z0` tool-change retract command technically fell inside an operation's calculated line range in a real sample file, and a naive coordinate-shift would have corrupted the tool-change retract distance - a genuine collision risk. The transform tracks G90/G91 modal state through the whole file and only ever shifts absolute-mode coordinates.
- Values do **not** persist between dialog sessions - every reopen starts fresh at 0.00, by design.
- Verified against the actual shipped code (not a standalone approximation) with the real sample G-code file before release, including the G91 safety case above.

## v1.11.2 (EXPERIMENTAL - not a feature release)

- **Round 2 of testing Tools-menu registration.** v1.11.1's test never ran at all (no [SW2026 TEST] log lines appeared) - meaning this runtime doesn't execute top-level script code, only the specific named function (`onGcodeProgramLoad`) it looks for. This version moves the exact same probe to the very first line inside `onGcodeProgramLoad`, which we know for certain executes. Load any G-code file and check the plugin log for `[SW2026 TEST]` lines, and check the Tools tab for a "SW2026 Test Menu Item" entry.

## v1.11.1 (EXPERIMENTAL - not a feature release)

- **Testing whether Tools-menu registration is possible in this runtime**, ahead of building the Tool Wear Compensation reopen-anytime feature. Adds a throwaway "SW2026 Test Menu Item" entry to the Tools tab (if `pluginContext.registerToolMenu` exists here) that just opens a "It works!" dialog. Check the plugin log for `[SW2026 TEST]` lines either way - they'll say whether the API exists and whether the call succeeded. Also worth checking: load two or three different files and see if the Tools tab shows one "SW2026 Test Menu Item" entry or several duplicates, since this whole script re-runs on every file load.
- This version has no other changes and isn't meant to be a real release - once we know the answer, this test code gets removed regardless of outcome.

## v1.11.0

- **Fix: Tool Wear Compensation arrows were spread too far apart vertically.** The v1.10.4 glyph enlargement combined with the existing padding pushed the two arrows' combined natural height well past their container, forcing them apart. Reduced vertical padding sharply (kept horizontal padding, so touch width is unaffected) so they sit close together proportionally.
- **Fix: "TLS" text crowded/overlapped the casing geometry.** Actually measured the numbers this time: "TLS" at the digit labels' font size and position would have extended well past the casing's left edge (a 3-character word is much wider than a single digit). Gave TLS its own smaller font size sized to fit the same gap a single digit uses, with real verified clearance before the casing.
- **Tool Wear Compensation values show gray when 0.00** (matching the "Empty" circle gray), both for the placeholder and for an explicitly-entered/stepped zero.
- **All button text is now uppercase.**
- **Increased the gap between the bottom action buttons**, still centered as a group.

## v1.10.4

- **Clarification fix: Tool Wear Compensation arrow glyphs enlarged, touch target left unchanged.** The previous version grew the invisible tap area again, which wasn't what was wanted - the actual touch target size from v1.10.2/3 was correct, it just looked disproportionate because the visible arrow glyph was tiny inside it. Font size increased from 0.85rem to 1.5rem so the arrow visually fills the same-sized touch target instead of floating small inside it.

## v1.10.3

- **Fix: action buttons only showed their color on hover, not by default.** Same root cause as the wear-arrow bug from v1.10.1 - ncSender appears to apply its own global button styling that our default-state CSS rules weren't specific enough to beat, while the `:hover` rules happened to be specific enough to win. Added `!important` to the color-critical properties on all three button styles so they display correctly in their normal state, not just on hover.
- **"Add & Assign" changed from green to orange**, matching the "New" status color it acts on.
- **Tool Wear Compensation stepper touch targets enlarged again** - wider and taller padding around the same small arrow glyphs.
- **Fix: "TLS" label was clipped on the left.** It's 3 characters wide, but was center-anchored at the same narrow point used for the single-digit slot numbers - fine for "1"-"8", but "TLS" is wide enough that centering it there pushed its left edge past the canvas boundary. Switched to left-anchored text at a small fixed margin, the same technique that fixed an earlier header-clipping bug.

## v1.10.2

- **Tool Wear Compensation stepper made touch-friendly.** The span-based fix in v1.10.1 got the visual size right, but the actual clickable area was still tiny (matching the small glyph exactly). Added generous invisible padding around each arrow (~30px tap target instead of ~14px) plus `touch-action: manipulation` to remove tap delay on touchscreens - the arrow glyphs themselves stay the same small size, only the tappable area grew.
- **Slot number labels and "TLS" text shifted left** to stop crowding the magazine casing.
- **"No Tool" replaced with "Empty"** on empty slot circles - a single word instead of two stacked lines, which also simplified centering it correctly. Circle shade darkened slightly.

## v1.10.1

- **Fix: Tool Wear Compensation stepper still showed as large bordered buttons despite the CSS change in v1.10.0.** Found the actual cause: they were `<button>` elements, and ncSender apparently applies its own global styling to all buttons that our single-class CSS rule wasn't specific enough to override. Switched them from `<button>` to plain `<span>` elements (matching how the Slot dropdown's chevron is also just plain text, not a button) — this sidesteps any global button styling entirely, since spans aren't targeted by it. Added explicit keyboard support (Enter/Space) since spans don't get that automatically like buttons do.
- **"No Tool" text enlarged again and properly recentered** — recalculated the two-line vertical position using the same font-metric-based approach that fixed an earlier header-clipping issue, rather than a guessed offset.
- **Fixed the magazine graphic's right-edge clipping.** Found the actual cause: the casing's right edge was calculated to land at *exactly* the SVG canvas width with zero margin, so the outline filter's dilation had nowhere to go but past the edge, getting clipped. Shifted the graphic slightly left and derived the canvas width from the actual geometry plus a real margin, instead of an independent fixed number that happened to leave no room.

## v1.10.0

- **Slot dropdown popup enlarged** so all 8 (or however many) options are visible without scrolling.
- **"New" status is now orange, not green** — distinguishes an unadded tool from a confirmed "In Sync" one, which stays green.
- **Tool Wear Compensation stepper redesigned as plain minimal arrows** (no button box, no border/background) instead of two large bordered buttons — matches the slot dropdown's lightweight chevron aesthetic.
- **Magazine outline darkened** from light gray to a darker, more subdued gray.
- **"No Tool" circles are now light gray with black text**, sized slightly larger.
- **"Add & Assign" restyled to match the Status badge look** (semi-transparent background, same glow) rather than the solid-color button style — worth watching closely, since this reintroduces the same style of background that caused a color-compositing issue with buttons in v1.9.1; if it looks off again in the real dialog, that's the likely cause.
- **Tool Wear Compensation range changed to -1.00 through 1.00** (was 0.00-9.99). Values now color themselves live: green for positive, red for negative, default for zero - both via the stepper and when typed manually.

## v1.9.2

- **Casing/empty-slot colors swapped** — the casing is now black, empty slot circles are gray (previously reversed).
- **Added a light gray outline around the magazine's outer silhouette only** — traces just the true external boundary of the whole scalloped shape, not each individual circle (which is what caused the crescent artifacts fixed in v1.9.1). Built with an SVG `feMorphology` dilate + XOR technique operating on the group as a whole, rather than per-circle strokes.
- **Empty slots now show "No Tool"** (two lines: "No" / "Tool") instead of a dash.
- **Tool Wear Compensation stepper now sized identically to the Slot dropdown** — both given the same explicit 32px height so they match exactly regardless of content.
- **"Add & Assign" glow no longer disappears when disabled** — it dims along with the rest of the button instead of losing its glow entirely.

## v1.9.1

- **Fix: crescent-shaped light gray artifacts at every slot overlap.** The visible edge stroke added in v1.9.0 (to fix casing edge visibility against the background) had an unintended side effect: since the casing is built from overlapping circles, each circle's own stroke crossed through its neighbor's fill at the overlap boundary, creating lens-shaped crescent lines exactly where two slots meet. Removed the stroke entirely - the solid `#2c2e30` fill already has enough contrast against the app's background on its own, so no stroke is needed.
- **Fix: Tool Wear Compensation stepper arrows still oversized.** Previous sizing used relative `em`/`rem` units that scaled unpredictably against their parent context. Rebuilt with explicit fixed pixel dimensions (18×14px per arrow) sized to match the Slot dropdown's visual footprint, independent of any inherited font-size.
- **Fix: button colors rendering incorrectly.** "Add & Assign," "Apply," and "Bypass" used low-opacity (20%) color overlays that composited unpredictably against the real dialog's background, showing up as a generic teal/gray rather than clearly green or red. Switched to solid, explicit background colors for both the green and red button variants.

## v1.9.0

**Fixes found from real ncSender screenshots, not previews** — the standalone HTML previews used during v1.8.0's design phase didn't reliably represent how this actually rendered in the live app, so this version was built and verified against real screenshots instead.

- **Removed the bezel ring entirely.** Every slot previously had a light gray ring (between the dark casing and the tool circle) that was meant to look like a bezel but actually just read as an unwanted visible internal line running through the whole magazine graphic. Gone now — casing sits directly behind the tool circle with nothing in between.
- **Casing is now a single solid dark gray** (`#2c2e30`) with a thin visible edge stroke, replacing the earlier left-to-right gradient. The gradient's dark end was nearly invisible against the app's dark background, making the casing's right edge disappear.
- **Tool Wear Compensation stepper arrows reduced back to their original size** — an earlier "double the size" request made them disproportionately large once seen in the real dialog.

## v1.8.0

**Dialog redesign — magazine graphic, table layout, and Tool Wear Compensation.**

Graphic:
- Removed the collapsible instructions panel from v1.7.0 entirely; the status banner alone now carries the message.
- Enlarged the magazine graphic to use the reclaimed space (`SCALE` increased from 0.65 → 0.82 over several passes).
- No header label above the slot numbers in the final version (a "Slot #" label and later an "ATC" label were both tried and removed).
- Tool circles and their matching left-side slot number now **glow** in their status color (green for In Sync, amber for Conflict) via SVG filters — plain circles/numbers for empty slots stay ungloved.
- "TLS" base-mount label size now matches the slot number label size exactly.

Table:
- "G-Code Data" renamed to **"Program Tool Information"**, halved in width to make room for a new **Tool Wear Compensation** column.
- New Tool Wear Compensation column: a `#.##`-formatted text input per tool (native pattern validation, 0.00–9.99) with up/down stepper arrows that increment/decrement by 0.01, clamped at the format's bounds. UI only for now — no backend logic reads these values yet.
- "Sync" renamed to **"Status"**; all headers centered (fixed a CSS specificity bug where `.tools-table th` was silently beating the centering rules); header text enlarged.
- Tool # column narrowed and its text enlarged; Slot column text significantly enlarged and restyled to look like an actual dropdown (bordered box, large chevron) instead of plain clickable text.
- Added subtle vertical dividers between columns, shortened top/bottom so they never touch the horizontal row dividers.
- Status badges: "In Sync" and "New" enlarged (both share the same green style); "Conflict" kept its original size. All three badge colors now have a matching glow.
- Conflict rows get a rounded, glowing red border around the whole Status cell, sized to match the true cell dimensions — implemented on an inner wrapper `<div>` rather than the `<td>` itself, since `border-radius` has no effect on table cells under `border-collapse: collapse`.
- Slot-picker dropdown popup's list-item text size now matches the size shown after a slot is actually selected (was previously smaller and inconsistent).

Header & buttons:
- "Program Name" moved to the far left of the header as a single line: bold **Program Name:** label followed by the filename.
- Dialog title renamed to **"SolidWorks 2026 G-Code Tools"**.
- "Add Tools & Auto-Assign Slots" renamed to **"Add & Assign"**; "Load" renamed to **"Apply"** — both now share a glowing green style matching the status badges.
- "Bypass" restyled to a matching glowing red style.

## v1.7.1

- **Fix: table headers weren't actually centered.** Found the real cause: `.tools-table th` (class + element selector) had higher CSS specificity than `.col-toolnum`/`.col-status`/`.col-slot` (single-class selectors) alone, so the header's default left-alignment always won regardless of source order. Data cells were never affected by this (no competing rule), which is why only the headers looked wrong. Fixed by adding a more specific selector for the header cells.
- **Slot values now look like an actual dropdown** — bordered box with a ▾ chevron, background highlight on hover — instead of plain clickable text that didn't visually signal it was interactive.
- **Dialog title renamed** to "SolidWorks 2026 G-Code Tools" (was "SW2026 G-Code Tools (Tool Library & Slot Mapping)").

## v1.7.0

- **Confirmed (no code change needed):** slot reassignment already works at any time, including after "Add Tools & Auto-Assign Slots" completes or once the file shows "All Tools Ready" - click any tool's Slot value in the table to reassign it.
- **Confirmed (no code change needed):** table headers were already centered (Tool #, Status, Slot) except "Program Tool Information," which stays left-aligned to match its content.
- **Instructions rewritten and made collapsible.** Each status (conflicts / needs attention / ready) now has a short one-line summary shown by default, plus a "Show details ▾" toggle that expands a fuller paragraph explaining what the status means, why it happens, and exactly what each button does - without permanently using up vertical space in the dialog.
- **Added a "Program Name" label** above the G-code filename in the header. The filename is now centered and one size larger than before.

## v1.6.1

- **Fix: table rows had no explicit height in the real plugin.** The mockups I used to design v1.6.0 had row heights baked in, but that detail didn't make it into the actual `renderTable()` code — rows were rendering at nearly zero height, making the table look broken with real data. Rows are now a fixed 64px tall.
- **Fix: the magazine graphic was too tall for ncSender's actual dialog window**, pushing the action buttons off-screen and forcing the whole dialog to scroll as one unit instead of just the table. Scaled the entire graphic down 35% (from ~712px to ~462px for an 8-slot magazine). All the graphic's proportions (pitch, circle sizes, fonts, cap) now derive from a single `SCALE` constant in `renderCarousel()`, so further size tuning is a one-line change instead of a full rewrite.

## v1.6.0

- **Redesigned the slot graphic to match a real RapidChange ATC magazine strip.** Scalloped casing (overlapping-circle technique, calibrated against an actual reference photo), gray bezel rings, slot numbers 1-N labeled down the left side, and a "TLS" base mount with mounting knob at the bottom — all generated dynamically from your actual magazine size, not hardcoded to 8.
- Occupied slots show a two-line "Tool #" / tool-number label, colored by sync status: **green** for In Sync, **orange** for Conflict. **Only In Sync and Conflict tools ever occupy a slot in the graphic — "New" (not-yet-added) tools never appear there**, since they can't really be in a magazine slot yet.
- The left-side slot number (1-N) is colored to match its occupant's status too (green/orange), staying neutral white when the slot is empty or holds an unresolved "New" tool.
- **Table redesigned to sit directly beside the graphic**, separated by a divider border, with its height locked exactly to the graphic's height (no independent sizing, no drift between the two). Extra rows scroll inside that fixed region instead of growing the dialog.
- Table columns renamed/restyled: "G-Code Data" → **"Program Tool Information"**, "Sync" → **"Status"**. Tool # and Slot columns centered and narrowed; Program Tool Information widened to use the freed space. Header text enlarged and set to bright white for contrast.
- Program Tool Information's second line drops the leading dash and truncates with an ellipsis instead of overflowing if it's ever too long.

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
