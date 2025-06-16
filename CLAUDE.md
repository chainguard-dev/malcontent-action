# CLAUDE.md - Context for AI Agents

This document provides context for AI agents (like Claude) working on the malcontent-action codebase.

## Project Overview

This is a GitHub Action that runs [malcontent](https://github.com/chainguard-dev/malcontent) security scanner on pull request diffs. The action compares security behaviors between base and head commits to detect potentially malicious changes.

## Key Technical Decisions

### Architecture
- **Docker-based execution**: We use the malcontent Docker image (`cgr.dev/chainguard/malcontent`) for consistent results across environments
- **Diff-only mode**: The action exclusively uses `malcontent diff` command (not `analyze`)
- **Temporary directories**: Files are extracted to temp directories for analysis, then cleaned up

### Important Implementation Details

1. **Git Operations**:
   - Use two-dot notation (`..`) for diffs, not three-dot (`...`)
   - Always use `fetch-depth: 0` in checkout for PR workflows to ensure full history

2. **Risk Calculation**:
   - Added files increase total risk (positive delta)
   - Removed files decrease total risk (negative delta)
   - Modified files calculate delta based on added vs removed behaviors

3. **PR Comments**:
   - Comments are updated in-place using a marker: `<!-- malcontent-action-comment -->`
   - Shows specific behaviors with risk levels, not just counts
   - Includes match strings and rule links when available

## Code Organization

- `src/index.js`: Main action logic (single file)
- `dist/index.js`: Compiled output (built with @vercel/ncc)
- `action.yml`: Action metadata and inputs/outputs definition

## Development Workflow

1. **Building**: Run `npm run build` to compile source to dist
2. **Formatting**: Code is formatted with Prettier (config in `.prettierrc.json`)
3. **Pre-commit hooks**: Husky runs Prettier on staged files automatically
4. **Testing**: Create test branches with malicious files from [malcontent-samples](https://github.com/chainguard-dev/malcontent-samples)

## Common Tasks

### Adding a new input parameter
1. Add to `action.yml` inputs section
2. Add `core.getInput()` call in `src/index.js`
3. Update README.md documentation
4. Run `npm run build` and commit both src and dist

### Modifying PR comment format
1. Edit `generateDiffSummary()` function in `src/index.js`
2. Update `postPRComment()` if structural changes needed
3. Test with a PR containing known malicious files

### Debugging malcontent execution
1. Check Docker volume mounts in `runMalcontentDiff()`
2. Verify temp directory structure with debug logs
3. Ensure `--file-risk-change` flag is before path arguments

## Testing Approach

We test by creating PRs with files from malcontent-samples repo:
```bash
# Example: Add a malicious file
wget https://raw.githubusercontent.com/chainguard-dev/malcontent-samples/main/linux/2024.xzutils/liblzma.so.5.4.5
git add liblzma.so.5.4.5
git commit -m "Test malicious file detection"
```

## Key Files to Review

When making changes, these files are most important:
1. `src/index.js` - All action logic
2. `action.yml` - Input/output definitions
3. `.github/workflows/build.yml` - CI that verifies dist is up-to-date
4. `.github/workflows/format-check.yml` - Enforces code formatting

## Gotchas and Known Issues

1. **ESLint**: Currently using ESLint v9 which requires new config format. Linting is disabled in CI.
2. **Build workflow**: Cannot push to fork PRs due to permissions. Only checks for uncommitted changes.
3. **Docker mode**: Always uses Docker, never installs malcontent binary directly.

## Future Improvements to Consider

- Add caching for malcontent Docker image pulls
- Support for custom malcontent rules
- Integration tests using GitHub Actions test frameworks
- Proper ESLint v9 configuration