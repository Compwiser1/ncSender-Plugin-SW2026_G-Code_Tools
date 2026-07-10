# SW2026 G-Code Tools

**Version**: 1.0.0
**Category**: Utility
**Requirements**: ncSender 2.0.37+ (OSS) or ncSender Pro 2.0.88+

An ncSender plugin for G-code produced by the **SolidWorks 2026 FrankenOKO post processor**. This is a new all-in-one plugin that **replaces Dynamic Tool Slot Mapper** — only one of the two should be enabled at a time.

---

## 🎯 v1.0.0: Tool Library Sync

SolidWorks 2026 / FrankenOKO writes a tool summary table at the bottom of every G-code file:

```
(  TOOL#     TOOL TYPE     DIAMETER   DESCRIPTION                     )
( -------  --------------  --------   ------------------------------  )
(   018       ENDMILL       008.00    8MM CRB 4FL 20 LOC  )
(   021     CENTER DRILL    008.00    8MM X 90DEG CRB SPOT DRILL  )
```

When a G-code file is loaded, this plugin parses that table and reconciles it against your ncSender Tool Library:

- **🟢 New** — tool isn't in the library yet. Add all new tools in one click via **"Add New Tools to Library"**.
- **🔴 Conflict** — tool exists in the library but its type, diameter, or description doesn't match what's in the G-code. Flagged for manual resolution — each conflict shows the library value and the G-code value side by side, with **"Use G-code"** / **"Keep Library"** buttons. Nothing is ever overwritten automatically.
- **⚪ In Sync** — tool already matches. If every tool in the file is already in sync, the dialog doesn't open at all.

This plugin **never rewrites the G-code file itself** — `onGcodeProgramLoad` always returns the original content unchanged. It only keeps the Tool Library accurate.

---

## 📖 How to Use

1. Load any SolidWorks 2026 / FrankenOKO G-code file with a tool summary table
2. If every tool already matches the library, nothing happens — the file loads normally
3. Otherwise, the **Tool Library Sync** dialog opens automatically:
   - New tools are listed with a green **New** badge
   - Conflicting tools are listed with a red **Conflict** badge and a diff (library value vs. G-code value)
4. Click **Add New Tools to Library** to add all new tools at once
5. For each conflict, click **Use G-code** to update the library with the G-code's values, or **Keep Library** to leave the library as-is and dismiss the flag
6. Click **Close** when done

---

## 🔧 Technical Details

### Parsing
- Reads only the footer tool summary table (`TOOL# / TOOL TYPE / DIAMETER / DESCRIPTION`), not the inline `T## M06` tool-change calls — the footer table is a clean, structured source that's far less error-prone to parse.
- Tool number, type, diameter (mm), and description are extracted per row.

### Comparison
- Type and description are compared case-insensitively.
- Diameter is compared with a small floating-point tolerance (0.005 mm).
- A tool with no library entry at all → **New**. A tool with a library entry that differs in any field → **Conflict**. Otherwise → **In Sync**.

### Library Updates
- **Add**: `POST /api/tools` with `{ toolId, type, diameter, name, toolNumber: null }` — new tools are added without a magazine slot assignment.
- **Resolve conflict (Use G-code)**: `PUT /api/tools/{id}`, spread over the tool's existing record so unrelated fields (like an assigned magazine slot) are preserved.
- **Resolve conflict (Keep Library)**: no API call — just clears the flag in the dialog for this session.

### Compatibility
- **ncSender (OSS)**: 2.0.37 or higher
- **ncSender Pro**: 2.0.88 or higher
- Runs in the `pro-v2` runtime (Jint sandbox). Requires `onGcodeProgramLoad`, `pluginContext.showDialog()`, and `pluginContext.getTools()`.

---

## 🚧 Planned

Future versions of SW2026 G-Code Tools are expected to add:
- Tool Wear Compensation
- Additional SolidWorks 2026 / FrankenOKO post-processor-aware tooling

---

## 📄 License

This plugin is provided as-is for use with ncSender.
