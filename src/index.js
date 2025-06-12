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

    if (!baseRef || !headRef) {
      throw new Error('Unable to determine base and head refs. This action must be run in a pull request context or with explicit refs.');
    }

    core.info(`Analyzing diff between ${baseRef} and ${headRef}`);

    // Install malcontent
    const malcontentPath = await installMalcontent(malcontentVersion);
    core.info(`Malcontent installed at: ${malcontentPath}`);

    // Create temp directory for analysis
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'malcontent-'));
    
    // Get list of changed files
    const octokit = github.getOctokit(token);
    const { data: files } = await octokit.rest.pulls.listFiles({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      pull_number: github.context.payload.pull_request.number
    });

    // Checkout and analyze base version
    core.info('Analyzing base version...');
    await exec.exec('git', ['checkout', baseRef]);
    const baseResults = await runMalcontentOnFiles(malcontentPath, files, tempDir, 'base', basePath);

    // Checkout and analyze head version
    core.info('Analyzing head version...');
    await exec.exec('git', ['checkout', headRef]);
    const headResults = await runMalcontentOnFiles(malcontentPath, files, tempDir, 'head', basePath);

    // Compare results
    const diff = compareResults(baseResults, headResults);
    const diffSummary = generateDiffSummary(diff);
    
    // Write detailed report
    const reportPath = path.join(tempDir, 'malcontent-diff-report.json');
    await fs.writeFile(reportPath, JSON.stringify(diff, null, 2));

    // Set outputs
    core.setOutput('diff-summary', diffSummary);
    core.setOutput('risk-increased', diff.riskIncreased);
    core.setOutput('report-file', reportPath);

    // Comment on PR if enabled
    if (commentOnPR && github.context.payload.pull_request) {
      await postPRComment(octokit, diffSummary, diff);
    }

    // Fail if risk increased and configured to do so
    if (failOnIncrease && diff.riskIncreased) {
      core.setFailed('Malcontent analysis detected increased risk in this PR');
    }

  } catch (error) {
    core.setFailed(error.message);
  }
}

async function installMalcontent(version) {
  const platform = os.platform();
  const arch = os.arch();
  
  let platformStr;
  if (platform === 'darwin') platformStr = 'Darwin';
  else if (platform === 'linux') platformStr = 'Linux';
  else throw new Error(`Unsupported platform: ${platform}`);
  
  let archStr;
  if (arch === 'x64') archStr = 'x86_64';
  else if (arch === 'arm64') archStr = 'arm64';
  else throw new Error(`Unsupported architecture: ${arch}`);

  // Get latest release if version not specified
  if (!version || version === 'latest') {
    const response = await fetch('https://api.github.com/repos/chainguard-dev/malcontent/releases/latest');
    const release = await response.json();
    version = release.tag_name;
  }

  const downloadUrl = `https://github.com/chainguard-dev/malcontent/releases/download/${version}/malcontent_${version.replace('v', '')}_${platformStr}_${archStr}.tar.gz`;
  
  core.info(`Downloading malcontent from: ${downloadUrl}`);
  const downloadPath = await tc.downloadTool(downloadUrl);
  const extractPath = await tc.extractTar(downloadPath);
  
  const malcontentPath = path.join(extractPath, 'malcontent');
  await exec.exec('chmod', ['+x', malcontentPath]);
  
  return malcontentPath;
}

async function runMalcontentOnFiles(malcontentPath, files, tempDir, suffix, basePath) {
  const results = {};
  
  for (const file of files) {
    if (file.status === 'removed') continue;
    
    const filePath = file.filename;
    
    // Skip files that are not within the base path
    if (basePath !== '.' && !filePath.startsWith(basePath + '/')) {
      continue;
    }
    
    const outputPath = path.join(tempDir, `${file.sha}-${suffix}.json`);
    
    try {
      await exec.exec(malcontentPath, ['analyze', '--format', 'json', '--output', outputPath, filePath], {
        ignoreReturnCode: true,
        cwd: basePath
      });
      
      const output = await fs.readFile(outputPath, 'utf8');
      results[filePath] = JSON.parse(output);
    } catch (error) {
      core.warning(`Failed to analyze ${filePath}: ${error.message}`);
      results[filePath] = null;
    }
  }
  
  return results;
}

function compareResults(baseResults, headResults) {
  const diff = {
    added: [],
    removed: [],
    changed: [],
    riskIncreased: false,
    totalRiskDelta: 0
  };
  
  const allFiles = new Set([...Object.keys(baseResults), ...Object.keys(headResults)]);
  
  for (const file of allFiles) {
    const baseResult = baseResults[file];
    const headResult = headResults[file];
    
    if (!baseResult && headResult) {
      diff.added.push({
        file,
        findings: headResult
      });
    } else if (baseResult && !headResult) {
      diff.removed.push({
        file,
        findings: baseResult
      });
    } else if (baseResult && headResult) {
      const baseRisk = calculateRiskScore(baseResult);
      const headRisk = calculateRiskScore(headResult);
      
      if (baseRisk !== headRisk || JSON.stringify(baseResult) !== JSON.stringify(headResult)) {
        diff.changed.push({
          file,
          baseFindings: baseResult,
          headFindings: headResult,
          riskDelta: headRisk - baseRisk
        });
        
        diff.totalRiskDelta += (headRisk - baseRisk);
        if (headRisk > baseRisk) {
          diff.riskIncreased = true;
        }
      }
    }
  }
  
  return diff;
}

function calculateRiskScore(findings) {
  if (!findings || !findings.findings) return 0;
  
  let score = 0;
  for (const finding of findings.findings) {
    switch (finding.severity) {
      case 'critical': score += 10; break;
      case 'high': score += 5; break;
      case 'medium': score += 3; break;
      case 'low': score += 1; break;
    }
  }
  return score;
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
      const riskScore = calculateRiskScore(item.findings);
      lines.push(`- ${item.file} (risk score: ${riskScore})`);
    }
    if (diff.added.length > 5) {
      lines.push(`- ... and ${diff.added.length - 5} more`);
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