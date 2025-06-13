# Malcontent GitHub Action

A GitHub Action that runs [malcontent](https://github.com/chainguard-dev/malcontent) on PR diffs to detect security changes between versions.

## Features

- 🔍 **Diff Analysis**: Compares malcontent findings between base and head commits
- 📊 **Risk Scoring**: Calculates risk scores and detects increases/decreases
- 💬 **Enhanced PR Comments**: Shows detailed behaviors, not just counts
- 📝 **Workflow Summary**: Outputs to GitHub Actions summary for non-PR contexts
- 🎯 **Flexible Modes**: Supports both `diff` and `analyze` modes
- 📁 **Path Filtering**: Can analyze specific directories with `base-path`
- 🚀 **Docker-based**: Uses malcontent Docker image for consistent results

## What's New

### Enhanced PR Comments
Instead of just showing behavior counts, the action now displays:
- Up to 10 specific behaviors per file
- Risk levels with emoji indicators (🔴 CRITICAL, 🟠 HIGH, 🟡 MEDIUM, 🔵 LOW)
- Example match strings for each behavior
- Clear risk score changes

Example output:
```
#### 📄 `suspicious-file.js`
**Risk Score: 35**

**Behaviors detected:**
- 🔴 **Potential backdoor** [CRITICAL]
  - Match: `eval(atob(`
- 🟠 **Obfuscated code** [HIGH]
  - Match: `String.fromCharCode(0x68,0x65,0x6c,0x6c,0x6f)`
- 🟡 **Network communication** [MEDIUM]
  - Match: `fetch("http://example.com")`
...and 7 more behaviors
```

## Usage

### Basic Usage (Pull Request)

```yaml
name: Security Analysis
on:
  pull_request:

jobs:
  malcontent:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      
      - uses: imjasonh/malcontent-action@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

### Push Events

```yaml
name: Security Analysis on Push
on:
  push:
    branches: [main]

jobs:
  malcontent:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 2  # Need HEAD and HEAD~1
      
      - uses: imjasonh/malcontent-action@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

## Inputs

| Input | Description | Default |
|-------|-------------|---------|
| `github-token` | GitHub token for API access | `${{ github.token }}` |
| `mode` | Analysis mode: `diff` or `analyze` | `diff` |
| `base-path` | Base directory to analyze | `.` |
| `malcontent-version` | Version of malcontent to use | `latest` |
| `fail-on-increase` | Fail if risk score increases | `true` |
| `comment-on-pr` | Comment results on PR | `true` |
| `base-ref` | Base ref to compare (auto-detected) | - |
| `head-ref` | Head ref to analyze (auto-detected) | - |

## Outputs

| Output | Description |
|--------|-------------|
| `diff-summary` | Summary of malcontent findings diff |
| `risk-increased` | Whether the risk score increased (`true`/`false`) |
| `risk-delta` | The change in risk score (positive for increase, negative for decrease) |
| `report-file` | Path to the full diff report JSON file |

### Example: Using outputs in workflow

```yaml
- uses: imjasonh/malcontent-action@v1
  id: malcontent
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    fail-on-increase: false  # Handle manually based on risk delta

- name: Check risk delta
  run: |
    echo "Risk changed by: ${{ steps.malcontent.outputs.risk-delta }} points"
    if [[ "${{ steps.malcontent.outputs.risk-increased }}" == "true" ]]; then
      echo "⚠️ Security risk increased!"
    fi

# Fail only on significant risk increase (>10 points)
- name: Evaluate risk threshold
  if: steps.malcontent.outputs.risk-delta > 10
  run: |
    echo "::error::Significant security risk increase detected!"
    exit 1
```

## Modes

### Diff Mode (Default)
Uses malcontent's native `diff` command to compare base and head versions. This is the most efficient method.

### Analyze Mode
Only analyzes the head version without comparison. Useful for:
- Initial security scans
- When there's no base version to compare
- Quick security checks

## Building

To build this action for development:

```bash
npm install
npm run build
```

This will compile the TypeScript/JavaScript code into `dist/index.js` using `@vercel/ncc`.

## Development

1. Clone the repository
2. Install dependencies: `npm install`
3. Make changes to `src/index.js`
4. Build: `npm run build`
5. Commit both source and dist files

## Requirements

- GitHub Actions runner with Docker support (Linux runners)
- For PR comments: `pull-requests: write` permission
- For PR diffs: `fetch-depth: 0` in checkout action

## License

Apache-2.0
