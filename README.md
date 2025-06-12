# Malcontent GitHub Action

A GitHub Action that runs [malcontent](https://github.com/chainguard-dev/malcontent) on PR diffs to detect security changes between versions.

## Features

- 🔍 **Diff Analysis**: Compares malcontent findings between base and head commits
- 📊 **Risk Scoring**: Calculates risk scores and detects increases
- 💬 **PR Comments**: Automatically comments findings on pull requests
- 📝 **Workflow Summary**: Outputs to GitHub Actions summary for non-PR contexts
- 🎯 **Flexible Modes**: Supports both `diff` and `analyze` modes
- 📁 **Path Filtering**: Can analyze specific directories with `base-path`

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
      
      - uses: your-username/malcontent-action@v1
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
      
      - uses: your-username/malcontent-action@v1
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

## License

Apache-2.0