## v1.22.4 (EXPERIMENTAL — transparent animation background; external link is likely a host-level limitation)

**Removed the animation strip's own dark background gradient**, so it blends transparently into the modal's own surface color instead of showing as a distinct darker rectangle.

**On the release link opening in an embedded window instead of the real default browser**: confirmed via a real screenshot that the previous `window.open()` fix did solve the actual bug that was reported (a blank, content-less window) - the page now loads its real content correctly. It's just opening inside what looks like an ncSender-hosted window frame rather than the OS's actual default browser app. Both the standard approaches a plugin can try (native `target="_blank"` and explicit `window.open()`) land in the same place, which strongly suggests this is the host application intercepting external navigation and opening its own window for it, rather than something happening in this plugin's own code - genuinely not something a plugin's HTML/JS can override from its side. Properly routing external links to the system's real default browser needs `shell.openExternal()` called from ncSender's own Electron main process, which is outside what this plugin can reach. Worth raising directly with the ncSender project if a real external-browser hand-off matters.

## v1.22.3 (EXPERIMENTAL — fixed a confirmed scaling regression and a background-position weak point)

**Fixed a real, confirmed regression from v1.22.2: the animation was rendering at full 1920px size and getting clipped**, instead of scaled down to fit the popup. Root cause: the exact same ordering bug that was already fixed once in the earlier JS-driven version got reintroduced when the animation was rewritten as pure CSS - the scale transform was being set on the container *before* `twcBuildEndmillAnim` ran, and that function overwrites the container's entire style string as its first action, silently wiping the transform out. Fixed the same way as before: apply the scale after building, not before. Verified directly against the generated code this time, not just checked for thrown errors.

**Also fixed a weaker spot in the same fix**: the spinning-flute effect was animating `background-position`, which - unlike `transform` and `opacity` - isn't guaranteed to run on the compositor thread in all browsers and can require main-thread repaint, meaning it could have stalled during the exact same kind of main-thread blocking this whole rebuild was meant to survive. Converted it to an oversized element sliding via `transform: translateX()` instead (clipped by its container, so it reads identically but is now guaranteed compositor-safe like the rest of the animation).

## v1.22.2 (EXPERIMENTAL — critical fix: animation was frozen the whole time it mattered; caption restored; link fix attempt)

**The v1.22.0 animation never actually appeared to move, and the chips weren't visible - root cause found and fixed.** It was built as a `requestAnimationFrame` loop with JavaScript updating element styles every frame - but `applyRadialAndZOffsets` (the actual work happening underneath the popup) is a heavy, fully synchronous computation, and JavaScript is single-threaded. The moment that computation starts, it blocks the main thread completely, and a JS-driven animation can't update *at all* until the computation finishes - which is nearly the entire time the popup is visible. The animation wasn't broken, it was just permanently paused for the one period it needed to run.

**Fixed by rebuilding the whole thing as a pure CSS `@keyframes` animation** (only animating `transform` and `opacity`, which run on the browser's compositor thread, independent of whatever JavaScript is doing on the main thread) instead of JS-driven per-frame style updates. This keeps it animating smoothly no matter how long the offset check takes. Verified directly: the new build makes zero `requestAnimationFrame` calls at all - there's no longer a JS animation loop to freeze in the first place.

This did mean simplifying a couple of details from the original scene that specifically depended on per-frame JavaScript (the reveal-as-you-go machined/raw stock split, and the finished-part-slides-out/fresh-blank-slides-in swap) - the core identity (endmill traveling and cutting, spinning flutes, LED, a continuous stream of tumbling chips) is preserved and confirmed structurally correct: 14 chip particles building with individual trajectory data, and the endmill's travel/chip-visibility/flute-spin/LED-pulse all driven by their own `@keyframes` rules, present and verified in the generated dialog.

**Also restored the "Processing..." caption**, which was dropped entirely in the first port - it now shows with a flashing opacity animation in the corner of the strip, matching what was in the original design.

**Attempted fix for the GitHub link opening a blank window**: switched from relying on the anchor's native `target="_blank"` handling to an explicit `window.open()` call from a click handler, which is a more reliable way to trigger a hand-off to the OS's actual default browser in an embedded webview like this dialog. This is a reasonable, commonly-suggested fix for this class of issue, but whether it fully resolves it depends on specifics of how ncSender's embedded dialog handles external navigation that can't be verified from here - please confirm it actually opens your real browser now, and if not, right-click → copy link as a reliable fallback in the meantime.

## v1.22.1 (EXPERIMENTAL — post processor compatibility notice)

**The dialog now shows a notice right at the top on every open**, letting the user know this plugin only works with G-code from the SW2026 FrankenOKO post processor, with a link to get it. The link uses GitHub's `/releases/latest` URL (`https://github.com/Compwiser1/ncSender-Plugin-SW2026_G-Code_Tools/releases/latest`), which always redirects to whatever release is currently marked "Latest" on the repo - it never needs updating as new versions ship, unlike linking to a specific tagged release.

## v1.22.0 (EXPERIMENTAL — animated endmill replaces the plain spinner)

**The loading popup's plain CSS spinner is replaced with the animated endmill design provided via Claude Design** - a flat endmill face-mills a bar of aluminum across a strip at the top of the popup, throwing chips, on a seamless 8-second loop (feed pass, retract, rapid return while the finished part slides out and a fresh blank slides in).

The supplied file was a full React scene built for Claude Design's own "omelette" authoring framework (a `Stage`/`Sprite` timeline engine with video export, playback scrubber, etc.) - none of which exists in this dialog, which is plain HTML/JS with no React. Ported the actual scene logic (gradients, the spindle/collet/shank/flute assembly, the 32-particle chip system with real projectile-motion physics, the stock swap) into vanilla JS driven by a plain `requestAnimationFrame` loop, at the exact same coordinate system, timing, and easing curves as the original - scaled down to fit the popup via a CSS transform rather than hand-recomputing every position at a smaller size, so nothing needed re-tuning.

Verified directly, not just "no errors thrown": ran the actual embedded code (extracted from the real generated dialog, not a hand-copy) through a full cycle and confirmed 31-32 of 32 chips are correctly active with realistic physics during the cutting phase, the endmill's tracked position matches the feed pass, and the stock correctly slides out/in during the swap phase. Caught and fixed one real bug in the process: the scale-to-fit transform was being silently wiped out because the animation's own setup code overwrites the container's full style string as its first action - fixed by applying the transform after that setup runs instead of before.

## v1.21.0 (EXPERIMENTAL — long-press to reset, loading popup while checking offsets)

**Long press (~0.6s) on any Z Offset or X & Y Offset field resets just that field to 0.00** - a quick way to clear one value without selecting and retyping. Shows a brief orange fill building up while held, and a quick green flash confirming the reset when it triggers; releasing early (a normal click, to type a value) cancels it with no change. Release is tracked at the document level, not just the input, so moving the mouse or finger off before releasing still correctly cancels it.

**Both "Apply Offset" and "Bring This G-Code To Life!" now show a loading popup while checking offsets**, since this can take a real, noticeable amount of time on a large file with many operations and depth passes (every line gets analyzed individually). The popup shows a spinner plus a short, genuinely accurate overview of what the check is actually doing (circular vs. general-profile handling, cross-operation collision checking) - something to read while waiting, not filler text. A small delay is inserted between showing the popup and starting the actual check, specifically so the browser gets a chance to paint the popup before the heavy computation blocks the UI thread - otherwise the popup could be added to the page but never actually become visible before the work finishes.

## v1.20.0 (EXPERIMENTAL — inserted lines are now truly in sequence, not just unique)

**v1.19.9's fix wasn't enough - a collision-free N-number still isn't the same as an in-sequence one.** An inserted fillet between N9 and N10 showing up as, say, N2344 is unique but visually out of order. Properly fitting a new line *between* two existing sequential numbers requires shifting every subsequent N-number to make room - there's no way around it. Implemented that: after the whole file is assembled (with corner-fillet lines correctly positioned), one final pass renumbers every N-numbered line - both original lines and inserted ones - into one true continuous sequence, starting from the file's own first N-number. A file with two genuine fillet insertions now shows perfectly continuous N-numbers before, through, and after both insertion points, confirmed directly against real file content.

**Important, honest tradeoff**: this means every line's N-number *after* the first insertion point will differ from the original file (shifted up by however many lines got inserted before it) - not just the inserted lines themselves. This is an unavoidable consequence of making inserted lines genuinely sequential rather than merely unique. Verified this doesn't happen when nothing gets inserted (N-numbers stay byte-for-byte identical to the original in that case) and that a genuinely inserted case produces a perfectly continuous run.

Also fixed the exact same regex-escaping bug as v1.19.9 one more time in the course of building this (`\d+` silently collapsing to `d+` in the generated code) - caught immediately this time by testing the actual generated client script's regex output directly before trusting any test result built on top of it.

## v1.19.9 (EXPERIMENTAL — inserted lines now get a real N-number)

**Newly inserted corner-fillet lines now get a real N-number**, instead of being left blank. Computed from the highest N found anywhere in the whole file, plus a counter - guaranteed unique without needing to renumber every subsequent line to make room for a "properly sequential" number (which would mean touching potentially thousands of lines for one inserted fillet). It won't look sequential with its neighbors (e.g. `N61` appearing between `N60` and what continues as `N70` elsewhere), but it's a real, valid, collision-free label - GRBL doesn't require N-numbers to be sequential or meaningful for execution.

Hit and fixed the exact same class of bug this project has run into before while building this: the regex used to find the file's highest N-number (`\d+`) got silently collapsed to `d+` by the outer server-side template literal that generates the dialog's client-side script, matching nothing and always falling back to `N1`. Caught by extracting and testing the actual generated client-side code directly (not just the source), the same verification method that's caught this exact class of escaping bug before. Fixed by properly double-escaping the backslash.

## v1.19.8 (EXPERIMENTAL — inserted fillets could wrongly use I/J in an R-format file; notes now labeled by axis)

**Fixed a real bug found from a reported file: newly inserted corner-fillet arcs (from offsetting a general profile) could come out in I/J format even in a file that otherwise uses R-format exclusively.** The giveaway was an inserted line with no N-number reading `G03 X157.61 Y39.7078 I0 J-0.99` in the middle of an all-R-format profile. Root cause: the format decision was based on whichever element happened to immediately precede that specific corner - but a straight line has no arc format at all, so whenever a line preceded a corner needing a fillet, the check silently fell through to I/J regardless of the file's actual convention. Fixed by determining the file's R-format usage once, file-wide, and using that consistently for every inserted fillet instead of inferring it per-corner. Verified directly: the exact same inputs that previously produced `undefined` (and fell back to I/J) now correctly produce R-format output.

**Notes now say which offset caused each change**, since a line touched by both a Z Offset and an X & Y Offset previously showed two identical-looking `(TWC: +0.20)` notes with no way to tell which was which. Now reads `(TWC: [Z] +0.20)` and `(TWC: [X/Y] -0.10)` respectively - a line touched by both gets both, clearly labeled.

## v1.19.7 (EXPERIMENTAL — Live On The Edge now resets to 0.00, zero values never show a sign)

- **"Live On The Edge" now resets the Z/X&Y input fields to the literal text `0.00`** instead of leaving them blank.
- **A value of exactly zero never shows a `+` or `-` sign anywhere** - previously the stepper arrows and manual-typing finalization could produce `+0.00`, which doesn't make sense for a genuine zero. Found and fixed a real duplicate-definition bug along the way: two separate copies of the sign-formatting function existed in the same scope, so fixing only one had no effect until the second (unfixed) copy - which silently wins when two functions share a name in the same scope - was removed. Verified directly that a value of 0 now formats as plain `0.00` while nonzero values still correctly show `+` or `-`, and that real G-code notes for actual nonzero offsets are unaffected.

## v1.19.6 (EXPERIMENTAL — Live On The Edge now clears saved offset values)

**"Live On The Edge" now zeroes out previously saved offset values instead of leaving them sitting around.** Skipping Operation Manager is an explicit "don't apply anything" decision, but the Z/X&Y input fields and the persisted browser storage (added in v1.18.1) previously kept whatever was last entered - meaning a later reopen would restore those stale values as if they should still be applied. Clicking "Live On The Edge" now clears the visible input fields, resets the in-memory offsets, and wipes the persisted browser storage together, so a later reopen starts genuinely fresh. Verified directly: values present before the click are gone from both the inputs and storage immediately after.

## v1.19.5 (EXPERIMENTAL — tooltip positioning, opacity, and border fixes)

Three fixes to the "X & Y Offset" info tooltip introduced in v1.19.3, found from a real screenshot:
- **No longer gets cut off by the right edge of the window** - it was centered under the icon, extending equally left and right; since the icon sits in the last column (near the right edge of the dialog), the right half was pushed past the visible window. Now anchored to grow leftward from the icon's right edge instead, so it always stays within bounds.
- **Solid, opaque background** - switched from a theme CSS variable (which may carry transparency depending on the app's actual token values) to an explicit solid dark color, so it can never look washed-out or see-through regardless of what's behind it.
- **Glowing orange border** added around the tooltip (and its pointer arrow) to make it stand out clearly against the dialog.

## v1.19.4 (EXPERIMENTAL — plugin API surface confirmed final, probe removed)

**Ran the v1.19.3 diagnostic probe in the real app - result is now definitive.** `pluginContext` exposes exactly `log`, `showDialog`, and `getTools` - nothing else. Combined with `registerToolMenu` already confirmed non-functional (v1.11.x), this settles the question: there is no plugin API in this host for registering a menu entry, panel, or any other on-demand trigger. Reloading the G-code file (via the timestamped marker from v1.18.0, with values persisted via browser storage from v1.18.1) is the best this plugin can do to let you reopen the dialog and adjust values - not a workaround settled for, but the actual ceiling of what's possible with this host's current plugin API. A genuinely better experience would require ncSender itself adding a new plugin API for this.

Removed the diagnostic probe code now that it's served its purpose - it was never meant to ship long-term, and dead code doesn't stay around once it's answered its question.

## v1.19.3 (EXPERIMENTAL — themed tooltip, diagnostic probe for other plugin trigger options)

- **Replaced the native browser tooltip on the "X & Y Offset" info icon with a custom-styled one matching the plugin's own dark theme** - the previous version used the HTML `title` attribute, which renders as a plain, unstylable OS tooltip (confirmed via a real screenshot showing it clash badly with the app's colors). The new tooltip is a small themed card with a pointer arrow, opening *downward* from the icon rather than upward - the header row sits at the very top of a container with `overflow: hidden`, so an upward tooltip risked being clipped by the section's own edge.
- **Added a one-time, read-only diagnostic probe** that logs the real property/method names actually exposed on `pluginContext` and on the `context` object passed into `onGcodeProgramLoad`, every time a file loads. This is purely informational (cannot affect the machine, file, or tool library) - the goal is to see directly from the running app whether this host offers any other event/registration hook beyond what's already confirmed (`log`/`getTools`/`showDialog`, and the previously-confirmed-nonfunctional `registerToolMenu`) that could let the dialog be reopened on demand instead of only via a G-code file (re)load. Check the ncSender log after loading a file for lines starting with `[SW2026] [PROBE]`.

## v1.19.2 (EXPERIMENTAL — radius-vs-diameter clarification)

**Added a small "ⓘ" info icon next to the "X & Y Offset" column header** - hovering shows a tooltip clarifying that the value is a radius offset, not diameter: "entering 0.10 changes the diameter by 0.20mm, not 0.10mm." No persistent visual clutter - it's a native browser tooltip that only appears on hover, placed directly on the column where the confusion would happen. Deliberately kept direction-neutral (doesn't say "bigger" or "smaller") since internal/external and sign already determine that elsewhere - this tooltip is only about the radius/diameter factor of 2.

## v1.19.1 (EXPERIMENTAL — Z Offset was incorrectly shifting rapid moves)

**Fixed: Z Offset was being applied to G00 rapid moves, not just actual cutting moves.** The Z-shift logic marked every line in an operation's range for shifting regardless of motion type, so a rapid retract or reposition height (like the clearance move between depth passes) got shifted right along with the real G01/G02/G03 feed moves doing the actual cutting - not meaningful compensation, since rapids aren't cutting anything. Fixed by only marking lines that are genuine feed moves, using the same modal-motion tracking already relied on elsewhere - a bare coordinate line continuing in rapid mode (no G-word restated) is correctly still excluded, and a line continuing in feed mode is correctly still included. Verified directly: a G00 retract/reposition line no longer receives a Z shift or a TWC note anywhere in either a circular-feature or general-profile operation, with or without an X & Y Offset also applied in the same round.

## v1.19.0 (EXPERIMENTAL — critical fix: Z Offset was corrupting arc radii; input formatting/color fixes)

**Critical fix: applying both a Z Offset and an X & Y Offset to the same operation was silently corrupting arc radii**, found from a real reported example showing an arc with two conflicting notes on the same line (`(TWC: -0.05) (TWC: +0.20)`). Root cause: the Z-shift logic was written before this post processor existed, when "R" only ever meant a canned-cycle retract-plane height (which legitimately should shift along with Z) - now that "R" also means arc radius, the same regex was matching and shifting both, silently adding the Z value onto every R-format arc's radius in the same operation. Fixed by tracking which lines are genuine R-format arcs and excluding "R" from the Z-shift on those specific lines only - canned-cycle retract planes (which don't use G02/G03) are completely unaffected and still shift correctly. Verified by confirming an arc's radius is now byte-identical whether or not a Z Offset is also applied in the same round, for both circular features and general profile geometry.

**Two input-field fixes, both confirmed via direct testing:**
- Values restored from browser storage on reopen (added in v1.18.1) weren't getting their green/positive or red/negative color applied - fixed by running the same color check used for manual edits right after the initial render.
- Positive values now show an explicit `+` in the Operation Manager input fields themselves (e.g. `+0.20`), matching the `-` already shown for negative values - applied when values are restored on reopen, when using the stepper arrows, and once you're done manually typing (checked on blur, not on every keystroke, so it doesn't fight with someone still entering digits).

## v1.18.1 (EXPERIMENTAL — value persistence actually works now, fixed via real user testing)

**v1.18.0's file-embedded value persistence was tested live and confirmed not to work** - reloading the file showed the dialog again (that part was fine), but Z/X&Y Offset fields came back blank instead of restoring last-used values. Root cause: `load-temp` only ever produces an in-memory/cached version of the translated file for machining - it never writes the marker or any embedded values back to the actual file on disk, so reloading the file always reads the pristine original with nothing to restore from.

**Fixed by moving value persistence out of the G-code file entirely and into the browser's own storage**, keyed by the file's path - this lives in ncSender's UI process itself, so it works regardless of what does or doesn't get written to disk. Values save automatically as you type or use the stepper arrows (not just when clicking Apply Offset), so whatever you last had entered is what you'll see next time this same file's dialog opens - verified by simulating two fully separate dialog sessions sharing the same underlying browser storage and confirming session 2 correctly loads exactly what session 1 saved and rendered those values into the actual input fields.

The marker itself (the timestamp-based one from v1.18.0, used only to suppress the plugin's own immediate internal re-trigger after Bring To Life) is unchanged and still in place - only the file-embedded *values* piece was removed, since that's the part confirmed broken.

## v1.18.0 (EXPERIMENTAL — reopen the dialog to adjust values, values persist across sessions)

**A quick way to reopen the plugin and adjust Operation Manager values, with those values remembered.**

- **The dialog can now reopen on a later reload of the same file.** Previously, once a file had been processed once, its marker permanently blocked the dialog from ever appearing again on that file. The marker now includes a timestamp: only an occurrence within 5 seconds of "now" is treated as this plugin's own immediate internal re-trigger (from uploading the translated file) and suppressed; an older marker means a genuine later reload, and the dialog opens normally.
- **Z Offset and X & Y Offset values are now written into the file alongside the marker** (as a dedicated comment, ignored by the controller) and read back and pre-filled into the Operation Manager inputs the next time the dialog opens for that file - "where you left off," not a blank 0.00 every time. Old marker/value comments from a previous round are stripped before writing fresh ones, so they don't accumulate release after release.
- **Important, honest caveat**: a past attempt at reopening via a marker caused a real bug - two dialogs firing at once, because reloading a file can read the fresh, never-marked file straight from disk while ncSender's own cached "current" version still has the marker, depending on exactly how ncSender's reload path works internally. The time-based approach here is designed to avoid that, but this interaction hasn't been verified against the real app yet - please test reloading carefully (a few seconds after Bring To Life, and again much later) and watch specifically for two dialogs appearing at once before relying on this for real work.

## v1.17.0 (EXPERIMENTAL — new post processor format support: R-format arcs, semicolon comments)

**Updated the whole plugin to work with the post processor's current output (2026.07.12-C), which changed significantly from earlier versions:**

- **Arcs now use `R` (radius) instead of `I`/`J` (center offset)** - the accuracy issue behind this switch is fully handled: `R`-format arcs are converted to the equivalent center internally using the exact formula GRBL itself uses to interpret radius-mode arcs (matching this post's own target controller), verified against several real arcs in the new sample file by confirming the computed center is equidistant from both the arc's start and end points to within floating-point precision, and that positive-R arcs correctly resolve to the shorter (≤180°) sweep as GRBL's convention requires.
- **Comments changed from `( ... )` to `;` throughout**, and the tool table format changed to match. Both the original and current formats are now auto-detected and supported side by side - existing files with the old format still work exactly as before.
- **Operation headers no longer include an explicit number** - replaced by a 3-line `; Operation Summary` / `; - Description: Name` / `; - Notes: ...` block. Operations are now numbered sequentially in the order they appear in the file (1, 2, 3, ...) instead of relying on a number the post processor no longer writes.
- **TWC offset output is written back in whichever format the original arc used** - an `R`-format file's arcs get a recalculated `R` value; an `I`/`J`-format file's arcs still get recalculated `I`/`J` values. Newly inserted corner-fillet arcs (Stage 2) also match the surrounding file's format.
- Verified end-to-end against the new sample file (tool table parsing, operation/Notes parsing with auto-numbering, a circular feature offset with correct `R` output, a general-profile offset with correct `R` output on both grown and shrunk arcs including a large ~23mm transition, and the size-limit warning/max-safe calculation) - and re-verified the previous (`I`/`J`, parenthesized-comment) sample files still work identically to confirm nothing broke for existing files.

## v1.16.1 (EXPERIMENTAL — stable max-safe value + one-click Fix)

**Fixed a real bug: the reported max-safe offset could change depending on which value you tried.** Outside Profile's tiny corner fillet has 6 depth passes, and this post processor's coordinate rounding gives each pass's "identical" fillet a slightly different computed radius. The reported limit was only ever computed from whichever passes currently failed at the specific value being tested - trying a large offset failed one subset and reported one number, trying a smaller offset failed a different subset and reported a tighter number. Now the tightest limit across *all* geometry in that operation is computed once, up front, so the reported number is a fixed property of the geometry and can't shift between attempts. Verified: 0.99 and 0.62 (previously reported as the limit) both now correctly report the same stable 0.59.

**Added a one-click "Fix" button to each size-related error row.** Clicking it reads the operation's current entered value, clamps its magnitude to the max-safe limit while preserving its sign (e.g. -0.99 → -0.59, +0.99 → +0.59), writes it directly into the X & Y Offset input, and marks itself "Fixed." Only size-related rows get a Fix button - other problem types (missing tag, collision, unsupported geometry) don't have a numeric value to clamp to, so no button appears for those.

## v1.16.0 (EXPERIMENTAL — grouped, table-based error display)

**Errors from applying an offset are now grouped and shown as a compact table** instead of a wall of repeated text.

- **Size-related failures (a feature too small to take the requested offset) are grouped to one line per operation**, using the tightest (smallest) safe limit found across everything that failed in that operation - a stepped counterbore hitting this on 6 depth passes now shows one line, not six. Message simplified to: *"Operation #4 (Outside Profile): Radial offset too large."* with an italic detail line below: *"Set offset within (-0.62 and +0.62) to apply an offset."*
- **Every other kind of problem (missing internal/external tag, toolpath collision, unsupported geometry) always shows individually, every time** - these aren't a relaxable size limit, so they're never grouped or collapsed, even if that means more rows.
- **New table layout**: each row is labeled "Error #1," "Error #2," etc., with the operation number/name in bold and the explanation in smaller italic text indented below it - built to fit in one or two lines per row instead of wrapping across many. A header line states the total count ("5 Errors Found"). The dialog widens specifically for this table (960px) so it has room to stay compact.
- Verified against the real reported scenario (6 depth-pass warnings on Outside Profile collapsing to exactly 1), a mixed multi-operation case (one missing-tag operation + one size-limited operation, both shown correctly), and a full DOM simulation of the table rendering itself (stats line, row structure, heading/detail text, Error # labeling).

## v1.15.6 (EXPERIMENTAL — better error messages + custom in-app dialog)

- **Self-intersection warnings now state the max safe offset for that specific geometry** - e.g. "geometry at line 941 (radius 0.64mm) would invert - max safe offset for this geometry is about 0.62mm" instead of just "would invert." Applies to both circular features and general profile geometry.
- **Replaced every native browser `alert()`/`confirm()` popup with a custom in-app dialog** matching the plugin's own dark theme - rounded card, warning icon, proper paragraph spacing for multi-part messages, and styled OK/Cancel buttons - instead of the plain unstyled OS popup. Covers every warning and confirmation in the plugin: slot assignment failures, Organize My Tools results, Apply Offset validation, and Bring This G-Code To Life's TWC warnings/confirmation.
- Caught and fixed a real escaping bug during testing (a single- vs double-backslash mistake in the new modal code that would have broken the message-splitting logic) before shipping - verified the fix by extracting and syntax-checking the actual generated client-side script, then simulating full open/close cycles for both the alert and confirm variants.

## v1.15.5 (EXPERIMENTAL — explicit + sign on positive note values)

**Positive TWC note values now show an explicit `+`** to match the negative sign already shown, e.g. `(TWC: +0.10)` instead of `(TWC: 0.10)`. Applies to both X & Y and Z Offset notes.

## v1.15.4 (EXPERIMENTAL — Z-axis notes were missing)

**Fixed: lines that only got a Z Offset shift (no X & Y change) never got a `(TWC: ...)` note at all** - note-appending was only ever wired into the X/Y/I/J rewrite path, so a Z-only change on a line silently went unnoted. Z-shifted lines now get their own `(TWC: 0.20)`-style note using the Z Offset value, independent of whether that same line also got an X & Y note (a line with both gets both, each reflecting its own value).

## v1.15.3 (EXPERIMENTAL — slot override instead of swap)

**Selecting an occupied slot now overrides it instead of swapping.** Previously, assigning a tool to a slot that already held a different tool would perform a 3-step swap (clear occupant → assign target → move occupant into the tool's old slot). Now it's a straightforward override: the previous occupant is simply unassigned (cleared to no slot), and the tool you're reassigning takes the slot - two API calls instead of three. The slot picker's label also updated to say which tool is currently there and that it will be unassigned, instead of "Swap with #XX."

## v1.15.2 (EXPERIMENTAL — shorter per-line notes)

**Per-line notes shortened** from `(TWC Applied - Internal -0.10)` to `(TWC: -0.10)`.

## v1.15.1 (EXPERIMENTAL — per-line notes)

**Switched from one summary note per operation back to a note on every changed line** (the original request from before Stage 1/2 were scoped) - each G-code line that actually gets shifted, and any newly inserted corner-fillet line, now gets its own trailing `(TWC Applied - Internal -0.10)`-style comment appended directly on that line. Lines that weren't touched by the X & Y offset (including a Z-only shift with no XY change on that same line) stay clean with no note. Verified against both Bearing Bore (simple circle) and Outside Profile (general contour with an inserted fillet), confirming the note appears correctly on every rewritten and inserted line.

## v1.15.0 (EXPERIMENTAL — TWC Stage 2: arbitrary profiles + per-feature partial success)

**Arbitrary (non-circular) profiles are now supported** - a real outer part boundary mixing lines and arcs of varying radii, including lead-in/lead-out approach geometry that doesn't close on itself, can now be offset correctly.

- **True perpendicular-to-path contour offsetting**: every line segment shifts along its own outward normal (determined from the path's winding direction), every arc grows or shrinks depending on which way it curves, and corners are re-joined afterward - either a direct intersection (extending or trimming to meet cleanly) or, where growing outward opens a real gap, a small inserted fillet arc of radius equal to the offset amount. Verified against the real "Outside Profile" operation, including its small ~0.6mm corner fillets and its ~23mm large radius transitions, both directions.
- **Open (lead-in/lead-out) chains are handled correctly** - discovered that this post processor's outer-boundary passes approach and depart via separate tangent lines that don't meet at the same point (confirmed by tracing the actual coordinates), so the engine treats a chain's two free ends as simple translations rather than forcing an artificial closure.
- **Multi-diameter / mixed-geometry operations now succeed instead of being rejected wholesale** - a stepped counterbore (three diameters at one center, connected by short radial travel lines) mixed with an entirely separate D-shaped slotted mounting feature, all in one operation, previously caused the *whole operation* to be rejected the moment any non-circular geometry was found anywhere in it. Circles are now extracted first regardless of what they're mixed with, and only the genuine leftover boundary (never isolated radial connector fragments between different diameters) goes through the general engine.
- **Partial success, per piece of geometry, not per operation.** If one circle or one profile chain in an operation can't be safely offset, only that piece is left untouched and named in a warning - everything else that succeeded (in the same operation or elsewhere in the file) is still applied and the file still gets written. "Apply Offset" and "Bring This G-Code To Life!" both now show these as warnings you can choose to proceed past, not a hard block.
- **Collision checking is now Z-depth aware** - discovered during testing that a shallow facing pass covering the whole top surface will always be geometrically close in X/Y to almost any feature below it, causing false "collision" rejections against an operation that never actually interferes since it's cut at a completely different depth. The check now only flags a collision when the two features' actual Z ranges overlap.
- Verified end-to-end against real files: Bearing Bore (simple circle, regression-checked), Counter Bores (multi-diameter circles + separate slot, previously rejected, now fully applied), Outside Profile (complex real contour, previously rejected, now fully applied) - plus a synthetic two-feature test confirming collision detection still fires on genuine collisions and doesn't false-positive on safe offsets.

**This has not been run on a real machine.** This release adds substantially more geometry math than v1.14.0 - please dry-run or visually verify the output before cutting real material, especially for the first several parts on profiles with lead-in/lead-out geometry or inserted fillets.

## v1.14.0 (EXPERIMENTAL — TWC internal/external offset engine, Stage 1: circles)

**The X & Y Offset value now actually reshapes real circular bores and bosses**, replacing the old naive "add the same number to every X and Y" transform, which could never correctly grow or shrink a diameter.

- **Direction comes from the operation's Notes** - "internal" (bore) or "external" (boss), case-insensitive substring match; any numeric suffix (`TWC_Internal_3`, `TWC_External_2`, ...) is ignored entirely.
- **Sign convention is always physical, never geometric**: negative = remove more material, positive = keep more material, regardless of internal/external. Internally this means `newRadius = oldRadius - value` for bores and `newRadius = oldRadius + value` for bosses - opposite math producing the same physical meaning.
- **True modal G-code parser** built from scratch for this - tracks X/Y/Z carryover line-by-line across the whole file (confirmed necessary after finding this post processor doesn't always restate coordinates on every `G02`/`G03` line, contrary to the assumption it always would).
- **Circle detection via real arc geometry** - computes each arc's true center and radius from its `I`/`J` values (not the coordinates alone), clusters arcs into distinct circular features by real proximity (not string-rounding, which the post processor's 1-decimal-place coordinate rounding vs 2-decimal `I`/`J` values would otherwise split apart - caught and fixed during testing against the real sample file), and verifies each candidate actually closes a full 360° loop before treating it as a valid feature. A single operation can contain multiple separate circles (two holes, or a stepped counterbore with two diameters at one center) - each gets offset independently by the same value.
- **Arbitrary (non-circular) profiles are explicitly unsupported in this stage** - an operation tagged internal/external whose geometry isn't a clean circle (verified against the real "Outside Profile" operation, and also against "Counter Bores For Mounting Screws," which turned out to mix real counterbore circles with a separate D-shaped/slotted mounting feature) is left completely untouched and reported as unsupported, rather than guessed at. Full line/arc contour offsetting is planned as a follow-up stage.
- **Two hard safety checks, either one blocks the change with nothing written**: the new radius must stay positive (rejects self-intersecting/inverted results), and the new circle must not cross any other operation's toolpath anywhere else in the file (a real geometric proximity check against the whole file's other geometry, not just a warning).
- **Every entered offset across the whole file is validated before anything is written** - if any operation fails, nothing is written for any operation, and every problem is reported together. "Apply Offset" also runs this same validation immediately (fetching the file and dry-running the check) so problems surface right away instead of waiting until "Bring This G-Code To Life!"
- **One summary note per operation**, e.g. `( TWC Applied - Internal -0.10 )`, added directly under that operation's `( Notes: ... )` line - not per-line, per your direction.
- Verified against Test_16.txt's real Bearing Bore (single circle, succeeded with hand-checked math), Counter Bores and Outside Profile operations (both correctly rejected as non-circular, confirmed by inspecting their actual G-code), a missing-direction case, a self-intersection case, a zero-value no-op case, and a synthetic two-feature collision case (confirmed the check both fires on a genuine collision and doesn't false-positive on safe offsets).

**This has not been run on a real machine.** Please visually verify or dry-run the output before cutting real material, especially for the first several parts - this is new geometry math handling real toolpaths.

## v1.13.14 (EXPERIMENTAL — offset terminology + hazard icon)

- **Operation Manager's ready badge renamed** from "Safety Net Applied" to "Offsets Applied", matching the "Apply Offset" button and offset terminology introduced in v1.13.13.
- **"I Didn't Need This" (Tool Manager's skipped state) now shows a hazard/warning icon (⚠️)** instead of the generic skip icon.

## v1.13.13 (EXPERIMENTAL — bigger/aligned icons, offset terminology)

- **All icons throughout the plugin are larger and vertically centered against their text**: section icons (🧰/🛡️), status badge icons, the stat-summary bullet dots, and the lightning bolt on "Bring This G-Code To Life!" (now its own aligned element instead of plain inline text).
- **Operation Manager table headers renamed**: "Operation" → "Operation Description", "Z Comp" → "Z Offset", "X&Y Comp" → "X & Y Offset".
- **"Apply My Safety Net" renamed to "Apply Offset"** to match the new offset terminology. (The section's "Safety Net Applied" status badge wording is unchanged, since that wasn't part of this request.)

## v1.13.12 (EXPERIMENTAL — button gating, stat sizing/alignment/bold totals)

- **"Organize My Tools" now grays out once Tool Manager's status reads "Tools Organized"**, so the button visibly reflects that the action already ran. It re-enables automatically if the section returns to "In progress...".
- **Both header stat summaries are larger again** (0.92rem → 1.02rem).
- **Both stat summaries now align to the same horizontal position** - the title area and status badge area on both headers now reserve the same fixed width regardless of text length ("Tool Manager" vs the longer "Operation Manager", and each badge's varying label length), so the centered stats line up between the two sections instead of drifting based on how long each header's title/badge text happens to be.
- **The total count in each stat summary is now bold** - "**15 tools**" in Tool Manager, "**24 operations**" in Operation Manager - so the headline number stands out from the rest of the breakdown.

## v1.13.11 (EXPERIMENTAL — stat sizing, unified header format, caution icon, shorter carousel)

- **Tool Manager header stats are larger** (0.78rem → 0.92rem), easier to read at a glance.
- **Operation Manager's header now uses the same format as Tool Manager's**: stats sit on the same line as the title, centered between the title and the status badge, instead of on their own line below the title.
- **"Living On The Edge" now shows a caution/warning icon (⚠️)** instead of the mountain/cliff icon from v1.13.8.
- **The magazine carousel image is about 5% shorter overall** (592px → 557px for an 8-slot magazine, as tested) - only the vertical spacing between slots, cap height, and top/bottom padding were reduced; circle radii and the image's width are untouched, so nothing gets visually squished. This is explicitly a "let's try it" experiment per your request and easy to revert if it doesn't look right in person.

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
