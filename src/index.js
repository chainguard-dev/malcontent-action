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
    const mode = core.getInput('mode') || 'diff';

    const isPullRequest = !!github.context.payload.pull_request;

    let baseRefFinal = baseRef;
    let headRefFinal = headRef;

    if (!baseRefFinal || !headRefFinal) {
      if (mode === 'diff' && !isPullRequest) {
        // For non-PR contexts in diff mode, use HEAD and HEAD~1
        core.info('Not in a pull request context, using HEAD and HEAD~1 for diff');
        const headCommit = await exec.getExecOutput('git', ['rev-parse', 'HEAD']);
        const baseCommit = await exec.getExecOutput('git', ['rev-parse', 'HEAD~1']);
        headRefFinal = headCommit.stdout.trim();
        baseRefFinal = baseCommit.stdout.trim();
      } else {
        throw new Error('Unable to determine base and head refs. This action must be run in a pull request context or with explicit refs.');
      }
    }

    core.info(`Analyzing diff between ${baseRefFinal} and ${headRefFinal}`);

    // Install malcontent
    const malcontentPath = await installMalcontent(malcontentVersion);
    core.info(`Malcontent installed at: ${malcontentPath}`);

    // Create temp directory for analysis in workspace
    const workspaceTemp = '.malcontent-temp';
    await fs.mkdir(workspaceTemp, { recursive: true });
    const tempDir = await fs.mkdtemp(path.join(workspaceTemp, 'run-'));

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
      const diffOutput = await exec.getExecOutput('git', ['diff', '--name-status', `${baseRefFinal}...${headRefFinal}`]);
      files = diffOutput.stdout.trim().split('\n').filter(line => line).map(line => {
        const [status, ...filenameParts] = line.split('\t');
        const filename = filenameParts.join('\t');
        return {
          filename,
          status: status === 'A' ? 'added' : status === 'D' ? 'removed' : 'modified',
          sha: headRefFinal.substring(0, 7) // Short SHA for consistency
        };
      });
    }

    let diff;
    let diffSummary;

    if (mode === 'diff') {
      // Use diff mode
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
        core.info(`Running malcontent diff on ${baseFileCount} base files and ${headFileCount} head files...`);
        const diffOutput = await runMalcontentDiff(malcontentPath, baseDir, headDir, tempDir);

        // Parse diff results
        diff = parseDiffOutput(diffOutput);
        diffSummary = generateDiffSummary(diff);
      }

    } else if (mode === 'analyze') {
      // Use analyze mode - only analyze the head version
      core.info('Using malcontent analyze mode (head version only)...');

      // Checkout and analyze head version only
      core.info('Analyzing head version...');
      await exec.exec('git', ['checkout', headRefFinal]);
      const headResults = await runMalcontentAnalyze(malcontentPath, files, tempDir, 'head', basePath);

      // Create a simplified diff with only the new findings
      diff = {
        added: [],
        removed: [],
        changed: [],
        riskIncreased: false,
        totalRiskDelta: 0
      };

      // Add all analyzed files as "added" since we're only looking at head
      for (const [file, findings] of Object.entries(headResults)) {
        if (findings) {
          const riskScore = calculateRiskScore(findings);
          if (riskScore > 0) {
            diff.added.push({
              file,
              findings,
              riskScore
            });
            diff.totalRiskDelta += riskScore;
            diff.riskIncreased = true;
          }
        }
      }

      diffSummary = generateAnalyzeSummary(diff);

    } else {
      throw new Error(`Invalid mode: ${mode}. Must be 'diff' or 'analyze'`);
    }

    // Write detailed report
    const reportPath = path.join(tempDir, 'malcontent-diff-report.json');
    await fs.writeFile(reportPath, JSON.stringify(diff, null, 2));

    // Set outputs
    core.setOutput('diff-summary', diffSummary);
    core.setOutput('risk-increased', diff.riskIncreased);
    core.setOutput('report-file', reportPath);

    // Output results
    if (isPullRequest && commentOnPR) {
      // Comment on PR if enabled and in PR context
      await postPRComment(octokit, diffSummary, diff);
    } else if (!isPullRequest) {
      // Write to workflow summary for non-PR contexts
      await core.summary
        .addRaw(diffSummary)
        .addDetails('View detailed report', `\`\`\`json\n${JSON.stringify(diff, null, 2).substring(0, 60000)}\n\`\`\``)
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

  // Create a wrapper script to run malcontent via Docker
  // Mount temp directory and current directory
  const wrapperScript = `#!/bin/bash
docker run --rm \\
  -v "/tmp:/tmp" \\
  -v "$(pwd):$(pwd)" \\
  -w "$(pwd)" \\
  ${image} "$@"
`;

  const wrapperPath = '/tmp/malcontent';
  await fs.writeFile(wrapperPath, wrapperScript);
  await exec.exec('chmod', ['+x', wrapperPath]);

  // Verify installation
  await exec.exec(wrapperPath, ['--version']);

  return wrapperPath;
}

async function runMalcontentAnalyze(malcontentPath, files, tempDir, suffix, basePath) {
  const results = {};

  for (const file of files) {
    if (file.status === 'removed' && suffix === 'head') continue;
    if (file.status === 'added' && suffix === 'base') continue;

    const filePath = file.filename;

    // Skip files that are not within the base path
    if (basePath !== '.' && !filePath.startsWith(basePath + '/')) {
      continue;
    }

    const outputPath = path.join(tempDir, `${file.sha}-${suffix}.json`);

    let output = '';
    let error = '';

    try {
      await exec.exec(
        malcontentPath,
        ['--format', 'json', 'analyze', filePath],
        {
          ignoreReturnCode: true,
          cwd: basePath,
          listeners: {
            stdout: (data) => { output += data.toString(); },
            stderr: (data) => { error += data.toString(); }
          }
        }
      );

      if (error) {
        core.warning(`Malcontent analyze stderr for ${filePath}: ${error}`);
      }

      // Save output to file
      await fs.writeFile(outputPath, output);

      results[filePath] = JSON.parse(output);
    } catch (error) {
      core.warning(`Failed to analyze ${filePath}: ${error.message}`);
      results[filePath] = null;
    }
  }

  return results;
}

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
    const result = await exec.exec(
      malcontentPath,
      ['--format', 'json', 'diff', baseDir, headDir],
      {
        ignoreReturnCode: true,
        listeners: {
          stdout: (data) => { output += data.toString(); },
          stderr: (data) => { error += data.toString(); }
        }
      }
    );
    exitCode = result;

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

    // Process the diff output based on malcontent's diff format
    if (parsed.added) {
      for (const [file, data] of Object.entries(parsed.added)) {
        diff.added.push({
          file,
          findings: data,
          riskScore: calculateRiskScore(data)
        });
      }
    }

    if (parsed.removed) {
      for (const [file, data] of Object.entries(parsed.removed)) {
        diff.removed.push({
          file,
          findings: data,
          riskScore: calculateRiskScore(data)
        });
      }
    }

    if (parsed.modified) {
      for (const [file, data] of Object.entries(parsed.modified)) {
        const baseRisk = calculateRiskScore(data.previous);
        const headRisk = calculateRiskScore(data.current);
        const riskDelta = headRisk - baseRisk;

        diff.changed.push({
          file,
          baseFindings: data.previous,
          headFindings: data.current,
          riskDelta,
          baseRisk,
          headRisk
        });

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
      score += getRiskValue(finding.risk || finding.severity || 'low');
    }
  } else if (findings.behaviors) {
    for (const behavior of findings.behaviors) {
      score += getRiskValue(behavior.risk || 'low');
    }
  }

  return score;
}

function getRiskValue(risk) {
  switch (risk.toLowerCase()) {
    case 'critical': return 10;
    case 'high': return 5;
    case 'medium': return 3;
    case 'low': return 1;
    default: return 0;
  }
}


function generateAnalyzeSummary(diff) {
  const lines = ['## Malcontent Analysis Summary'];

  if (diff.added.length === 0) {
    lines.push('✅ No security-relevant findings detected in changed files');
    return lines.join('\\n');
  }

  const totalRisk = diff.added.reduce((sum, item) => sum + item.riskScore, 0);
  lines.push(`⚠️ **Total Risk Score: ${totalRisk}**`);

  lines.push(`\\n### Files with Security Findings (${diff.added.length})`);
  for (const item of diff.added.slice(0, 10)) {
    lines.push(`- ${item.file} (risk score: ${item.riskScore})`);
  }
  if (diff.added.length > 10) {
    lines.push(`- ... and ${diff.added.length - 10} more`);
  }

  return lines.join('\\n');
}

function generateDiffSummary(diff) {
  const lines = ['## Malcontent Analysis Summary'];

  if (diff.totalRiskDelta === 0 && diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) {
    lines.push('✅ No security-relevant changes detected');
    return lines.join('\\n');
  }

  if (diff.riskIncreased) {
    lines.push(`⚠️ **Risk Score Increased by ${diff.totalRiskDelta}**`);
  } else if (diff.totalRiskDelta < 0) {
    lines.push(`✅ Risk Score Decreased by ${Math.abs(diff.totalRiskDelta)}`);
  }

  if (diff.added.length > 0) {
    lines.push(`\\n### New Files with Findings (${diff.added.length})`);
    for (const item of diff.added.slice(0, 5)) {
      lines.push(`- ${item.file} (risk score: ${item.riskScore})`);
    }
    if (diff.added.length > 5) {
      lines.push(`- ... and ${diff.added.length - 5} more`);
    }
  }

  if (diff.removed.length > 0) {
    lines.push(`\\n### Removed Files with Findings (${diff.removed.length})`);
    for (const item of diff.removed.slice(0, 5)) {
      lines.push(`- ${item.file} (risk score: ${item.riskScore})`);
    }
    if (diff.removed.length > 5) {
      lines.push(`- ... and ${diff.removed.length - 5} more`);
    }
  }

  if (diff.changed.length > 0) {
    lines.push(`\\n### Files with Changed Findings (${diff.changed.length})`);
    for (const item of diff.changed.slice(0, 5)) {
      const delta = item.riskDelta > 0 ? `+${item.riskDelta}` : item.riskDelta;
      lines.push(`- ${item.file} (risk delta: ${delta})`);
    }
    if (diff.changed.length > 5) {
      lines.push(`- ... and ${diff.changed.length - 5} more`);
    }
  }

  return lines.join('\\n');
}

async function postPRComment(octokit, summary, diff) {
  const commentMarker = '<!-- malcontent-action-comment -->';

  // Find existing comment with our marker
  const { data: comments } = await octokit.rest.issues.listComments({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    issue_number: github.context.payload.pull_request.number
  });

  const existingComment = comments.find(comment => comment.body.includes(commentMarker));

  // Check if there are any findings
  const hasFindings = diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0;

  if (!hasFindings) {
    // No findings
    if (existingComment) {
      // Update existing comment to indicate issues were resolved
      const resolvedBody = commentMarker + '\n## Malcontent Analysis Summary\n\n' +
        '✅ Previously detected security issues have been resolved.\n\n' +
        '_Check the comment edit history for details about the previous findings._';

      await octokit.rest.issues.updateComment({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        comment_id: existingComment.id,
        body: resolvedBody
      });
      core.info(`Updated existing comment to indicate issues resolved: ${existingComment.html_url}`);
    }
    // If no existing comment and no findings, don't post anything
    return;
  }

  // There are findings - post or update comment
  const body = commentMarker + '\n' + summary + '\n\n<details><summary>View detailed report</summary>\n\n```json\n' +
    JSON.stringify(diff, null, 2).substring(0, 60000) + '\n```\n</details>';

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
