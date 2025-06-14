const core = require('@actions/core');
const github = require('@actions/github');
const exec = require('@actions/exec');
const tc = require('@actions/tool-cache');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

async function run() {
  try {
    const token = core.getInput('github-token', { required: true });
    const baseRef = core.getInput('base-ref') || github.context.payload.pull_request?.base?.sha;
    const headRef = core.getInput('head-ref') || github.context.payload.pull_request?.head?.sha;
    const malcontentVersion = core.getInput('malcontent-version');
    const failOnIncrease = core.getBooleanInput('fail-on-increase');
    const commentOnPR = core.getBooleanInput('comment-on-pr');
    const basePath = core.getInput('base-path') || '.';

    const isPullRequest = !!github.context.payload.pull_request;

    let baseRefFinal = baseRef;
    let headRefFinal = headRef;

    if (!baseRefFinal || !headRefFinal) {
      if (!isPullRequest) {
        // For non-PR contexts, use HEAD and HEAD~1
        core.info('Not in a pull request context, using HEAD and HEAD~1 for diff');
        const headCommit = await exec.getExecOutput('git', ['rev-parse', 'HEAD']);
        const baseCommit = await exec.getExecOutput('git', ['rev-parse', 'HEAD~1']);
        headRefFinal = headCommit.stdout.trim();
        baseRefFinal = baseCommit.stdout.trim();
      } else {
        throw new Error(
          'Unable to determine base and head refs. This action must be run in a pull request context or with explicit refs.'
        );
      }
    }

    core.info(`Analyzing diff between ${baseRefFinal} and ${headRefFinal}`);

    // Log what triggered this run
    if (isPullRequest) {
      core.info(`Running on pull request #${github.context.payload.pull_request.number}`);
    } else {
      core.info(`Running on push event for commit ${headRefFinal}`);
    }

    // Install malcontent
    const malcontentPath = await installMalcontent(malcontentVersion);
    core.info(`Malcontent installed at: ${malcontentPath}`);

    // Create temp directory for analysis
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'malcontent-'));

    // Get list of changed files
    const octokit = github.getOctokit(token);
    let files = [];

    if (isPullRequest) {
      const response = await octokit.rest.pulls.listFiles({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        pull_number: github.context.payload.pull_request.number
      });
      files = response.data;
    } else {
      // For non-PR contexts, get changed files from git diff
      // Use two dots (..) to get direct diff, not three dots (...) which includes all commits in between
      const diffOutput = await exec.getExecOutput('git', [
        'diff',
        '--name-status',
        `${baseRefFinal}..${headRefFinal}`
      ]);
      files = diffOutput.stdout
        .trim()
        .split('\n')
        .filter((line) => line)
        .map((line) => {
          const [status, ...filenameParts] = line.split('\t');
          const filename = filenameParts.join('\t');
          return {
            filename,
            status: status === 'A' ? 'added' : status === 'D' ? 'removed' : 'modified',
            sha: headRefFinal.substring(0, 7) // Short SHA for consistency
          };
        });

      // Log the files we're going to analyze
      core.info(`Found ${files.length} changed files between commits:`);
      for (const file of files) {
        core.info(`  ${file.status}: ${file.filename}`);
      }
    }

    let diff;
    let diffSummary;

    // Always use diff mode
    core.info('Using malcontent diff mode...');

    const baseDir = path.join(tempDir, 'base');
    const headDir = path.join(tempDir, 'head');
    await fs.mkdir(baseDir, { recursive: true });
    await fs.mkdir(headDir, { recursive: true });

    // Checkout base version
    core.info('Checking out base version...');
    await exec.exec('git', ['checkout', baseRefFinal]);

    // Copy changed files to base directory
    let baseFileCount = 0;
    for (const file of files) {
      if (file.status !== 'added') {
        const srcPath = path.join(basePath, file.filename);
        const destPath = path.join(baseDir, file.filename);
        try {
          await fs.mkdir(path.dirname(destPath), { recursive: true });
          await fs.copyFile(srcPath, destPath);
          baseFileCount++;
        } catch (error) {
          // File might not exist in base version
        }
      }
    }

    // Checkout head version
    core.info('Checking out head version...');
    await exec.exec('git', ['checkout', headRefFinal]);

    // Copy changed files to head directory
    let headFileCount = 0;
    for (const file of files) {
      if (file.status !== 'removed') {
        const srcPath = path.join(basePath, file.filename);
        const destPath = path.join(headDir, file.filename);
        try {
          await fs.mkdir(path.dirname(destPath), { recursive: true });
          await fs.copyFile(srcPath, destPath);
          headFileCount++;
        } catch (error) {
          core.warning(`Failed to copy ${file.filename}: ${error.message}`);
        }
      }
    }

    // Check if we have any files to analyze
    if (baseFileCount === 0 && headFileCount === 0) {
      core.info('No files to analyze, skipping diff');
      diff = {
        added: [],
        removed: [],
        changed: [],
        riskIncreased: false,
        totalRiskDelta: 0,
        raw: {}
      };
      diffSummary = generateDiffSummary(diff);
    } else {
      // Run malcontent diff
      core.info(
        `Running malcontent diff on ${baseFileCount} base files and ${headFileCount} head files...`
      );

      // List files in each directory for debugging
      const baseDirFiles = await fs.readdir(baseDir, { recursive: true });
      const headDirFiles = await fs.readdir(headDir, { recursive: true });
      core.info(`Base directory contains: ${baseDirFiles.join(', ')}`);
      core.info(`Head directory contains: ${headDirFiles.join(', ')}`);

      const diffOutput = await runMalcontentDiff(malcontentPath, baseDir, headDir, tempDir);

      // Parse diff results
      diff = parseDiffOutput(diffOutput);
      diffSummary = generateDiffSummary(diff);
    }

    // Write detailed report
    const reportPath = path.join(tempDir, 'malcontent-diff-report.json');
    await fs.writeFile(reportPath, JSON.stringify(diff, null, 2));

    // Generate SARIF report
    const sarifReport = generateSarifReport(diff, baseRefFinal, headRefFinal);
    const sarifPath = path.join(tempDir, 'malcontent-diff.sarif');
    await fs.writeFile(sarifPath, JSON.stringify(sarifReport, null, 2));

    // Set outputs
    core.setOutput('diff-summary', diffSummary);
    core.setOutput('risk-increased', diff.riskIncreased);
    core.setOutput('risk-delta', diff.totalRiskDelta || 0);
    core.setOutput('report-file', reportPath);
    core.setOutput('sarif-file', sarifPath);

    // Output results
    if (isPullRequest && commentOnPR) {
      // Comment on PR if enabled and in PR context
      await postPRComment(octokit, diffSummary, diff);
    } else if (!isPullRequest) {
      // Write to workflow summary for non-PR contexts
      await core.summary
        .addRaw(diffSummary)
        .addHeading('Detailed Report', 3)
        .addCodeBlock(JSON.stringify(diff, null, 2).substring(0, 60000), 'json')
        .write();
      core.info('Malcontent findings written to workflow summary');
    }

    // Fail if risk increased and configured to do so
    if (failOnIncrease && diff.riskIncreased) {
      core.setFailed('Malcontent analysis detected increased risk in this PR');
    }

    // Clean up temp directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      core.warning(`Failed to clean up temp directory: ${error.message}`);
    }
  } catch (error) {
    core.setFailed(error.message);
  }
}

async function installMalcontent(version) {
  // First check if malcontent is already installed
  try {
    const { exitCode } = await exec.exec('malcontent', ['--version'], {
      ignoreReturnCode: true,
      silent: true
    });
    if (exitCode === 0) {
      core.info('Using existing malcontent installation');
      return 'malcontent';
    }
  } catch (error) {
    // Not installed, continue with installation
  }

  // Use Docker to run malcontent
  core.info('Setting up malcontent using Docker...');

  // Pull the malcontent image
  const imageTag = version && version !== 'latest' ? version : 'latest';
  const image = `cgr.dev/chainguard/malcontent:${imageTag}`;

  await exec.exec('docker', ['pull', image]);

  // Store the image name for later use
  malcontentDockerImage = image;

  // Return a special marker to indicate Docker mode
  return 'docker:malcontent';
}

// Global variable to store Docker image
let malcontentDockerImage = null;

async function runMalcontentDiff(malcontentPath, baseDir, headDir, tempDir) {
  const outputPath = path.join(tempDir, 'diff-output.json');

  // Check if directories exist and have files
  try {
    const baseFiles = await fs.readdir(baseDir);
    const headFiles = await fs.readdir(headDir);

    if (baseFiles.length === 0 && headFiles.length === 0) {
      core.info('No files to analyze in either directory');
      return JSON.stringify({
        added: {},
        removed: {},
        modified: {}
      });
    }
  } catch (error) {
    core.error(`Error checking directories: ${error.message}`);
    throw error;
  }

  let output = '';
  let error = '';
  let exitCode = 0;

  try {
    if (malcontentPath === 'docker:malcontent') {
      // Run malcontent in Docker with proper volume mounts
      const result = await exec.exec(
        'docker',
        [
          'run',
          '--rm',
          '-v',
          `${baseDir}:/base:ro`,
          '-v',
          `${headDir}:/head:ro`,
          malcontentDockerImage,
          '--format',
          'json',
          'diff',
          '--file-risk-change',
          '/base',
          '/head'
        ],
        {
          ignoreReturnCode: true,
          listeners: {
            stdout: (data) => {
              output += data.toString();
            },
            stderr: (data) => {
              error += data.toString();
            }
          }
        }
      );
      exitCode = result;
    } else {
      const result = await exec.exec(
        malcontentPath,
        ['--format', 'json', 'diff', '--file-risk-change', baseDir, headDir],
        {
          ignoreReturnCode: true,
          listeners: {
            stdout: (data) => {
              output += data.toString();
            },
            stderr: (data) => {
              error += data.toString();
            }
          }
        }
      );
      exitCode = result;
    }

    if (error && exitCode !== 0) {
      // Check if it's a real error or just no differences
      if (error.includes('no such file or directory') || error.includes('stat')) {
        throw new Error(`Malcontent diff failed: ${error}`);
      }
      core.warning(`Malcontent diff stderr: ${error}`);
    }

    // Save output to file for debugging
    if (output) {
      await fs.writeFile(outputPath, output);
    }

    return output || JSON.stringify({ added: {}, removed: {}, modified: {} });
  } catch (error) {
    core.error(`Failed to run malcontent diff: ${error.message}`);
    throw error;
  }
}

function parseDiffOutput(diffOutput) {
  const diff = {
    added: [],
    removed: [],
    changed: [],
    riskIncreased: false,
    totalRiskDelta: 0,
    raw: null
  };

  try {
    const parsed = JSON.parse(diffOutput);
    diff.raw = parsed;

    // Handle the new format with uppercase Diff field
    const diffData = parsed.Diff || parsed.diff || parsed;

    // Process added files
    if (diffData.Added) {
      for (const [file, data] of Object.entries(diffData.Added)) {
        const riskScore = calculateRiskScore(data);
        diff.added.push({
          file: data.Path || file,
          findings: data,
          behaviors: data.Behaviors || [],
          riskScore: riskScore
        });
        // Added files increase total risk
        diff.totalRiskDelta += riskScore;
        if (riskScore > 0) {
          diff.riskIncreased = true;
        }
      }
    }

    // Process removed files
    if (diffData.Removed) {
      for (const [file, data] of Object.entries(diffData.Removed)) {
        const riskScore = calculateRiskScore(data);
        diff.removed.push({
          file: data.Path || file,
          findings: data,
          behaviors: data.Behaviors || [],
          riskScore: riskScore
        });
        // Removed files decrease total risk
        diff.totalRiskDelta -= riskScore;
      }
    }

    // Process modified files
    if (diffData.Modified) {
      for (const [key, data] of Object.entries(diffData.Modified)) {
        const behaviors = data.Behaviors || [];
        const addedBehaviors = behaviors.filter((b) => !b.DiffRemoved);
        const removedBehaviors = behaviors.filter((b) => b.DiffRemoved);

        diff.changed.push({
          file: data.Path || key,
          path: data.Path,
          behaviors,
          addedBehaviors,
          removedBehaviors,
          riskDelta:
            addedBehaviors.reduce((sum, b) => sum + (b.RiskScore || 0), 0) -
            removedBehaviors.reduce((sum, b) => sum + (b.RiskScore || 0), 0)
        });

        const riskDelta =
          addedBehaviors.reduce((sum, b) => sum + (b.RiskScore || 0), 0) -
          removedBehaviors.reduce((sum, b) => sum + (b.RiskScore || 0), 0);
        diff.totalRiskDelta += riskDelta;
        if (riskDelta > 0) {
          diff.riskIncreased = true;
        }
      }
    }
  } catch (error) {
    core.warning(`Failed to parse malcontent diff output: ${error.message}`);
    // Try to parse as line-based output if JSON parsing fails
    diff.raw = diffOutput;
  }

  return diff;
}

function calculateRiskScore(findings) {
  if (!findings) return 0;

  let score = 0;

  // Handle different formats of findings
  if (Array.isArray(findings)) {
    for (const finding of findings) {
      score +=
        finding.RiskScore ||
        getRiskValue(finding.RiskLevel || finding.risk || finding.severity || 'low');
    }
  } else if (findings.Behaviors) {
    // New format with uppercase Behaviors
    for (const behavior of findings.Behaviors) {
      score += behavior.RiskScore || getRiskValue(behavior.RiskLevel || 'low');
    }
  } else if (findings.behaviors) {
    // Old format with lowercase behaviors
    for (const behavior of findings.behaviors) {
      score += behavior.RiskScore || getRiskValue(behavior.risk || 'low');
    }
  }

  return score;
}

function getRiskValue(risk) {
  switch (risk.toLowerCase()) {
    case 'critical':
      return 10;
    case 'high':
      return 5;
    case 'medium':
      return 3;
    case 'low':
      return 1;
    default:
      return 0;
  }
}

function generateDiffSummary(diff) {
  const lines = [];

  if (
    diff.totalRiskDelta === 0 &&
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.changed.length === 0
  ) {
    return '## 🟢 No security-relevant changes detected\n\nAll files passed malcontent analysis without any behavioral differences.';
  }

  // Title based on overall risk change
  if (diff.riskIncreased) {
    lines.push(`## 🔴 Security Risk Increased (+${diff.totalRiskDelta} points)`);
  } else if (diff.totalRiskDelta < 0) {
    lines.push(`## 🟢 Security Risk Decreased (${diff.totalRiskDelta} points)`);
  } else {
    lines.push('## 🟡 Security Behaviors Changed (no net risk change)');
  }

  lines.push('');

  // Modified files with behavior changes
  if (diff.changed.length > 0) {
    lines.push('### Modified Files');
    lines.push('');

    // Sort files by risk delta (highest risk increase first)
    const sortedChanged = [...diff.changed].sort((a, b) => b.riskDelta - a.riskDelta);

    for (const item of sortedChanged) {
      const fileName = item.file.replace(/^\/[^/]+\//, ''); // Remove /base/ or /head/ prefix
      lines.push(`#### 📄 \`${fileName}\``);

      if (item.addedBehaviors.length > 0) {
        lines.push('');
        lines.push('**➕ Added behaviors:**');

        // Sort behaviors by risk score (highest first)
        const sortedAdded = [...item.addedBehaviors].sort((a, b) => {
          return (b.RiskScore || 0) - (a.RiskScore || 0);
        });

        for (const behavior of sortedAdded) {
          const riskEmoji = getRiskEmoji(behavior.RiskLevel);
          lines.push(`- ${riskEmoji} **${behavior.Description}** [${behavior.RiskLevel}]`);
          if (behavior.MatchStrings && behavior.MatchStrings.length > 0) {
            lines.push(`  - Match: \`${behavior.MatchStrings[0]}\``);
          }
          if (behavior.RuleURL) {
            const ruleName = behavior.RuleName || behavior.ID;
            lines.push(`  - Rule: [${ruleName}](${behavior.RuleURL})`);
          }
        }
      }

      if (item.removedBehaviors.length > 0) {
        lines.push('');
        lines.push('**➖ Removed behaviors:**');

        // Sort behaviors by risk score (highest first)
        const sortedRemoved = [...item.removedBehaviors].sort((a, b) => {
          return (b.RiskScore || 0) - (a.RiskScore || 0);
        });

        for (const behavior of sortedRemoved) {
          const riskEmoji = getRiskEmoji(behavior.RiskLevel);
          lines.push(`- ${riskEmoji} ~~${behavior.Description}~~ [${behavior.RiskLevel}]`);
          if (behavior.MatchStrings && behavior.MatchStrings.length > 0) {
            lines.push(`  - Match: \`${behavior.MatchStrings[0]}\``);
          }
        }
      }

      lines.push('');
    }
  }

  // New files with findings
  if (diff.added.length > 0) {
    lines.push('### New Files with Security Findings');
    lines.push('');

    // Sort by risk score (highest first)
    const sortedAdded = [...diff.added].sort((a, b) => b.riskScore - a.riskScore);

    for (const item of sortedAdded) {
      const fileName = item.file.replace(/^\/[^/]+\//, '');
      lines.push(`#### 📄 \`${fileName}\``);
      lines.push(`**Risk Score: ${item.riskScore}**`);
      lines.push('');
      lines.push('**Behaviors detected:**');

      // Sort behaviors by risk score (highest first)
      const sortedBehaviors = [...item.behaviors].sort((a, b) => {
        return (b.RiskScore || 0) - (a.RiskScore || 0);
      });

      // Show top 10 behaviors for new files
      for (const behavior of sortedBehaviors.slice(0, 10)) {
        const riskEmoji = getRiskEmoji(behavior.RiskLevel);
        lines.push(`- ${riskEmoji} **${behavior.Description}** [${behavior.RiskLevel}]`);
        if (behavior.MatchStrings && behavior.MatchStrings.length > 0) {
          lines.push(`  - Match: \`${behavior.MatchStrings[0]}\``);
        }
      }

      if (sortedBehaviors.length > 10) {
        lines.push(`- ... and ${sortedBehaviors.length - 10} more behaviors`);
      }

      lines.push('');
    }
    lines.push('');
  }

  // Removed files
  if (diff.removed.length > 0) {
    lines.push('### Removed Files');
    lines.push('');

    // Sort by risk score (highest first)
    const sortedRemoved = [...diff.removed].sort((a, b) => b.riskScore - a.riskScore);

    for (const item of sortedRemoved) {
      const fileName = item.file.replace(/^\/[^/]+\//, '');
      lines.push(`#### ~~${fileName}~~`);
      lines.push(`**Previous Risk Score: ${item.riskScore}**`);
      lines.push('');
      lines.push('**Behaviors removed:**');

      // Sort behaviors by risk score (highest first)
      const sortedBehaviors = [...item.behaviors].sort((a, b) => {
        return (b.RiskScore || 0) - (a.RiskScore || 0);
      });

      // Show top 10 behaviors that were removed
      for (const behavior of sortedBehaviors.slice(0, 10)) {
        const riskEmoji = getRiskEmoji(behavior.RiskLevel);
        lines.push(`- ${riskEmoji} ~~${behavior.Description}~~ [${behavior.RiskLevel}]`);
      }

      if (sortedBehaviors.length > 10) {
        lines.push(`- ... and ${sortedBehaviors.length - 10} more behaviors removed`);
      }

      lines.push('');
    }
    lines.push('');
  }

  return lines.join('\n');
}

function getRiskEmoji(riskLevel) {
  if (!riskLevel) return '⚪';
  switch (riskLevel.toUpperCase()) {
    case 'CRITICAL':
      return '🔴';
    case 'HIGH':
      return '🟠';
    case 'MEDIUM':
      return '🟡';
    case 'LOW':
      return '🟢';
    default:
      return '⚪';
  }
}

function generateSarifReport(diff, baseRef, headRef) {
  const sarif = {
    version: '2.1.0',
    $schema:
      'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
    runs: [
      {
        tool: {
          driver: {
            name: 'malcontent',
            informationUri: 'https://github.com/chainguard-dev/malcontent',
            version: '1.0.0', // We don't have the actual version, so using a placeholder
            rules: []
          }
        },
        results: [],
        versionControlProvenance: [
          {
            revisionId: headRef,
            repositoryUri: github.context.payload.repository?.html_url || ''
          }
        ]
      }
    ]
  };

  const run = sarif.runs[0];
  const rulesMap = new Map();

  // Helper function to convert risk level to SARIF level
  function getSarifLevel(riskLevel) {
    if (!riskLevel) return 'note';
    switch (riskLevel.toUpperCase()) {
      case 'CRITICAL':
      case 'HIGH':
        return 'error';
      case 'MEDIUM':
        return 'warning';
      case 'LOW':
        return 'note';
      default:
        return 'note';
    }
  }

  // Helper function to get numeric severity score (matching Python implementation)
  function getSeverityScore(riskLevel) {
    if (!riskLevel) return 5.0;
    switch (riskLevel.toUpperCase()) {
      case 'CRITICAL':
        return 9.0;
      case 'HIGH':
        return 7.0;
      case 'MEDIUM':
        return 5.0;
      case 'LOW':
        return 3.0;
      default:
        return 5.0;
    }
  }

  // Process added files
  for (const item of diff.added) {
    for (const behavior of item.behaviors || []) {
      // Create rule if not exists
      const ruleId =
        behavior.RuleName ||
        `malcontent-${behavior.Description?.replace(/\s+/g, '-').toLowerCase()}`;
      if (!rulesMap.has(ruleId)) {
        rulesMap.set(ruleId, {
          id: ruleId,
          name: behavior.Description || 'Unknown behavior',
          shortDescription: {
            text: behavior.Description || 'Unknown behavior'
          },
          fullDescription: {
            text: `Malcontent detected: ${behavior.Description || 'Unknown behavior'}`
          },
          help: {
            text: behavior.RuleLink || 'https://github.com/chainguard-dev/malcontent',
            markdown: behavior.RuleLink
              ? `[View rule](${behavior.RuleLink})`
              : '[Malcontent](https://github.com/chainguard-dev/malcontent)'
          },
          properties: {
            'security-severity': getSeverityScore(behavior.RiskLevel).toString()
          }
        });
      }

      // Create result
      const result = {
        ruleId: ruleId,
        level: getSarifLevel(behavior.RiskLevel),
        message: {
          text: behavior.Description || 'Security behavior detected'
        },
        locations: [
          {
            physicalLocation: {
              artifactLocation: {
                uri: item.file.replace(/^\/[^/]+\//, ''), // Remove temp directory prefix
                uriBaseId: 'ROOTPATH'
              }
            }
          }
        ]
      };

      // Add match strings as tags if available
      if (behavior.MatchStrings && behavior.MatchStrings.length > 0) {
        result.properties = {
          tags: behavior.MatchStrings
        };
        result.message.text += `: ${behavior.MatchStrings[0]}`;
      }

      run.results.push(result);
    }
  }

  // Process modified files (only added behaviors)
  for (const item of diff.changed) {
    for (const behavior of item.addedBehaviors || []) {
      // Create rule if not exists
      const ruleId =
        behavior.RuleName ||
        `malcontent-${behavior.Description?.replace(/\s+/g, '-').toLowerCase()}`;
      if (!rulesMap.has(ruleId)) {
        rulesMap.set(ruleId, {
          id: ruleId,
          name: behavior.Description || 'Unknown behavior',
          shortDescription: {
            text: behavior.Description || 'Unknown behavior'
          },
          fullDescription: {
            text: `Malcontent detected: ${behavior.Description || 'Unknown behavior'}`
          },
          help: {
            text: behavior.RuleLink || 'https://github.com/chainguard-dev/malcontent',
            markdown: behavior.RuleLink
              ? `[View rule](${behavior.RuleLink})`
              : '[Malcontent](https://github.com/chainguard-dev/malcontent)'
          },
          properties: {
            'security-severity': getSeverityScore(behavior.RiskLevel).toString()
          }
        });
      }

      // Create result
      const result = {
        ruleId: ruleId,
        level: getSarifLevel(behavior.RiskLevel),
        message: {
          text: behavior.Description || 'Security behavior detected'
        },
        locations: [
          {
            physicalLocation: {
              artifactLocation: {
                uri: item.path || item.file.replace(/^\/[^/]+\//, ''), // Remove temp directory prefix
                uriBaseId: 'ROOTPATH'
              }
            }
          }
        ]
      };

      // Add match strings as tags if available
      if (behavior.MatchStrings && behavior.MatchStrings.length > 0) {
        result.properties = {
          tags: behavior.MatchStrings
        };
        result.message.text += `: ${behavior.MatchStrings[0]}`;
      }

      run.results.push(result);
    }
  }

  // Convert rules map to array
  run.tool.driver.rules = Array.from(rulesMap.values());

  return sarif;
}

async function postPRComment(octokit, summary, diff) {
  const commentMarker = '<!-- malcontent-action-comment -->';

  // Find existing comment with our marker
  const { data: comments } = await octokit.rest.issues.listComments({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    issue_number: github.context.payload.pull_request.number
  });

  const existingComment = comments.find((comment) => comment.body.includes(commentMarker));

  // Check if there are any findings
  const hasFindings = diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0;

  if (!hasFindings) {
    // No findings
    if (existingComment) {
      // Update existing comment to indicate issues were resolved
      const resolvedBody =
        commentMarker +
        '\n## Malcontent Analysis Summary\n\n' +
        '✅ Previously detected security issues have been resolved.\n\n' +
        '_Check the comment edit history for details about the previous findings._';

      await octokit.rest.issues.updateComment({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        comment_id: existingComment.id,
        body: resolvedBody
      });
      core.info(
        `Updated existing comment to indicate issues resolved: ${existingComment.html_url}`
      );
    }
    // If no existing comment and no findings, don't post anything
    return;
  }

  // There are findings - post or update comment
  let body = commentMarker + '\n' + summary;

  // Add a summary table if there are multiple files
  if (diff.changed.length + diff.added.length + diff.removed.length > 1) {
    body += '\n\n<details><summary>📊 Summary Table</summary>\n\n';
    body += '| File | Status | Risk Change | Behaviors |\n';
    body += '|------|--------|-------------|----------|\n';

    // Create a combined array for sorting
    const allItems = [];

    for (const item of diff.changed) {
      allItems.push({
        ...item,
        status: 'Modified',
        riskChange: item.riskDelta,
        behaviorCount: `+${item.addedBehaviors.length}/-${item.removedBehaviors.length}`
      });
    }

    for (const item of diff.added) {
      allItems.push({
        ...item,
        status: 'Added',
        riskChange: item.riskScore,
        behaviorCount: item.behaviors.length
      });
    }

    for (const item of diff.removed) {
      allItems.push({
        ...item,
        status: 'Removed',
        riskChange: -item.riskScore,
        behaviorCount: item.behaviors.length
      });
    }

    // Sort by risk change (highest risk increase first)
    allItems.sort((a, b) => b.riskChange - a.riskChange);

    for (const item of allItems) {
      const fileName = item.file.replace(/^\/[^/]+\//, '');
      const riskChangeStr =
        item.riskChange > 0 ? `+${item.riskChange}` : item.riskChange.toString();
      body += `| \`${fileName}\` | ${item.status} | ${riskChangeStr} | ${item.behaviorCount} |\n`;
    }

    body += '\n</details>';
  }

  // Add raw JSON for debugging
  body +=
    '\n\n<details><summary>🔍 Raw JSON Report</summary>\n\n```json\n' +
    JSON.stringify(diff.raw || diff, null, 2).substring(0, 50000) +
    '\n```\n</details>';

  if (existingComment) {
    // Update existing comment
    await octokit.rest.issues.updateComment({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      comment_id: existingComment.id,
      body: body
    });
    core.info(`Updated existing comment: ${existingComment.html_url}`);
  } else {
    // Create new comment
    const { data: newComment } = await octokit.rest.issues.createComment({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      issue_number: github.context.payload.pull_request.number,
      body: body
    });
    core.info(`Created new comment: ${newComment.html_url}`);
  }
}

run();
