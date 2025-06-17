# Malcontent GitHub Action

A GitHub Action that runs [malcontent](https://github.com/chainguard-dev/malcontent) on PR diffs to detect security-relevant changes between code versions.

## Features

- 🔍 **Security Diff Analysis**: Compares malcontent findings between base and head commits
- 📊 **Risk Scoring**: Calculates risk scores and tracks increases/decreases
- 💬 **Detailed PR Comments**: Shows specific behaviors with risk levels and match examples
- 📝 **Workflow Summary**: Outputs findings to GitHub Actions summary for non-PR contexts
- 📁 **Path Filtering**: Analyze specific directories with `base-path`
- 🚀 **Docker-based**: Uses malcontent Docker image for consistent results
- 🎯 **Risk-based Actions**: Take different actions based on risk magnitude with `risk-delta` output

## PR Comment Example

The action provides detailed behavior analysis in PR comments:

```
## 🔴 Security Risk Increased (+15 points)

### Modified Files

#### 📄 `src/app.js`

**➕ Added behaviors:**
- 🔴 **Potential backdoor detected** [CRITICAL]
  - Match: `eval(atob(`
  - Rule: [backdoor/js/eval_base64](https://github.com/chainguard-dev/malcontent/blob/main/rules/...)
- 🟠 **Obfuscated code** [HIGH]
  - Match: `String.fromCharCode(0x68,0x65,0x6c,0x6c,0x6f)`

**➖ Removed behaviors:**
- 🟢 ~~Basic logging~~ [LOW]
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
      - uses: actions/checkout@...
        with:
          fetch-depth: 0
      
      - uses: chainguard-dev/malcontent-action...
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
      - uses: actions/checkout@...
        with:
          fetch-depth: 2  # Need HEAD and HEAD~1
      
      - uses: chainguard-dev/malcontent-action@...
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

## Inputs

| Input | Description | Default |
|-------|-------------|---------|
| `github-token` | GitHub token for API access | `${{ github.token }}` |
| `base-path` | Base directory to analyze | `.` |
| `malcontent-image` | Docker image for malcontent (use digest for reproducibility) | `cgr.dev/chainguard/malcontent:latest` |
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
| `sarif-file` | Path to the SARIF report file for upload to GitHub Advanced Security |

### Using the risk-delta output

The `risk-delta` output allows you to implement custom logic based on the magnitude of security changes:

```yaml
- uses: chainguard-dev/malcontent-action@...
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

# Or use different thresholds for different actions
- name: Request security review
  if: steps.malcontent.outputs.risk-delta > 5 && steps.malcontent.outputs.risk-delta <= 10
  uses: actions/github-script@...
  with:
    script: |
      github.rest.issues.addLabels({
        issue_number: context.issue.number,
        owner: context.repo.owner,
        repo: context.repo.repo,
        labels: ['security-review']
      })
```

### Uploading to GitHub Advanced Security

The action generates a SARIF (Static Analysis Results Interchange Format) report that can be uploaded to GitHub Advanced Security for integration with code scanning:

```yaml
- uses: chainguard-dev/malcontent-action@...
  id: malcontent
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}

- name: Upload SARIF
  uses: github/codeql-action/upload-sarif@...
  if: always() # Upload even if the malcontent check fails
  with:
    sarif_file: ${{ steps.malcontent.outputs.sarif-file }}
    category: malcontent
```

#### SARIF Report Details

The generated SARIF report:
- Uses SARIF version 2.1.0 format
- Maps malcontent risk levels to SARIF severity levels:
  - CRITICAL/HIGH → `error` (severity score: 9.0/7.0)
  - MEDIUM → `warning` (severity score: 5.0)
  - LOW → `note` (severity score: 3.0)
- Includes behavior descriptions, match strings, and rule links
- Only reports newly added behaviors (not removed ones) since these represent new risks
- Compatible with GitHub's code scanning and security features

This integration makes malcontent findings appear in:
- The Security tab of your repository
- Pull request security annotations inline with code
- Security alerts and vulnerability tracking
- Code scanning API results

### Using a Specific Image Version

For reproducible builds and security, we recommend using a specific image digest instead of a tag:

```yaml
- uses: chainguard-dev/malcontent-action@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    malcontent-image: cgr.dev/chainguard/malcontent@sha256:1234567890abcdef...
```

You can find the digest for a specific version by running:
```bash
docker pull cgr.dev/chainguard/malcontent:latest
docker inspect cgr.dev/chainguard/malcontent:latest --format='{{.RepoDigests}}'
```

## How It Works

This action uses malcontent's native `diff` command to compare security behaviors between base and head versions of your code. It:

1. Detects the base and head commits (from PR or push context)
2. Extracts changed files to temporary directories
3. Runs `malcontent diff` to compare behaviors
4. Reports findings via PR comments or workflow summaries
5. Can fail the build if risk increases

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

### Code Quality

This project uses Prettier for code formatting:

```bash
# Format code
npm run format

# Check formatting
npm run format:check
```

Pre-commit hooks are configured with Husky to automatically format code before commits.

## Requirements

- GitHub Actions runner with Docker support (Linux runners)
- For PR comments: `pull-requests: write` permission
- For PR diffs: `fetch-depth: 0` in checkout action

## License

Apache-2.0
