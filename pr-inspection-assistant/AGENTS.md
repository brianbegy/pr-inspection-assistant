# AGENTS.md

## How to Bump Versions Together

When updating the version of the PR Inspection Assistant extension, you must bump the version in all of the following files to keep them in sync:

1. `src/package.json`
2. `src/task.json` (fields: Major, Minor, Patch)
3. `vss-extension.json`

### Step-by-Step Instructions

1. **Decide the new version number** (e.g., 2.2.13).
2. **Update `src/package.json`:**
   - Change the `version` field to the new version.
3. **Update `src/task.json`:**
   - Change the `Major`, `Minor`, and `Patch` fields under the `version` object to match the new version.
4. **Update `vss-extension.json`:**
   - Change the `version` field to the new version.
5. **Commit your changes** with a message like `Bump version to 2.2.13`.
6. **Test and package** the extension as usual.

### Example
If you want to bump from 2.2.12 to 2.2.13:
- In `src/package.json`: `"version": "2.2.13"`
- In `src/task.json`:
  ```json
  "version": {
    "Major": 2,
    "Minor": 2,
    "Patch": 13
  }
  ```
- In `vss-extension.json`: `"version": "2.2.13"`

**All three files must have the same version number!**

---

For more information, see the project README or contact the maintainers.
