/**
 * viz command - Generate visualizations from pipeline runs
 * 
 * Produces Mermaid diagrams for findings/entities without LLM calls.
 * Supports ASCII art output via beautiful-mermaid.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { IW_DIR } from '../constants.js';
import {
  buildSubgraph,
  renderMermaid,
  generateIssueLens,
  generateEntityLens,
  findingToIssue,
  renderAscii,
  renderDualOutput,
  type VizEntity,
  type VizStatement,
  type VizFinding,
} from '@intentweave/analyzer/viz';
import { findLatestRunId } from '@intentweave/core';

type VizFormat = 'mermaid' | 'md' | 'markdown' | 'ascii' | 'dual';

interface VizIssueOptions {
  run?: string;
  depth: string;
  maxNodes: string;
  format: VizFormat;
  direction: string;
  output?: string;
  ascii: boolean;
}

interface VizEntityOptions {
  run?: string;
  depth: string;
  maxNodes: string;
  format: VizFormat;
  direction: string;
  output?: string;
  ascii: boolean;
}

interface VizRbacOptions {
  run?: string;
  format: VizFormat;
  output?: string;
  ascii: boolean;
}

// =============================================================================
// Main viz command
// =============================================================================

export const vizCommand = new Command('viz')
  .description('Generate Mermaid visualizations from pipeline data');

// =============================================================================
// viz issue <id>
// =============================================================================

vizCommand
  .command('issue <issueId>')
  .description('Generate visualization for a specific issue')
  .option('--run <runId>', 'Use specific run (default: latest)')
  .option('--depth <n>', 'Neighbor expansion depth', '1')
  .option('--max-nodes <n>', 'Maximum nodes to include', '40')
  .option('--format <fmt>', 'Output format: mermaid, md, ascii, dual', 'md')
  .option('--direction <dir>', 'Flow direction: LR, TB, RL, BT', 'LR')
  .option('--ascii', 'Include ASCII art (shortcut for --format dual)', false)
  .option('-o, --output <file>', 'Write to file instead of stdout')
  .action(async (issueId: string, options: VizIssueOptions) => {
    try {
      const { entities, statements, findings } = await loadGraphData(options.run);
      
      // Find the finding
      const finding = findings.find(f => 
        f.id === issueId || 
        f.id.includes(issueId) ||
        (f as any).ruleId === issueId
      );
      
      if (!finding) {
        console.error(chalk.red(`Finding not found: ${issueId}`));
        console.error('');
        console.error('Available findings:');
        for (const f of findings.slice(0, 10)) {
          console.error(`  ${f.id}: ${f.message.substring(0, 60)}...`);
        }
        process.exit(1);
      }
      
      // Convert to issue and generate lens
      const issue = findingToIssue(finding, `workspace:unknown#${issueId}`, 1);
      const result = generateIssueLens(issue, entities, statements, {
        depth: parseInt(options.depth, 10),
        maxNodes: parseInt(options.maxNodes, 10),
        direction: options.direction as any,
        includeGhostEdges: true,
        includeDescription: true,
      });
      
      // Determine output format
      const format = options.ascii ? 'dual' : options.format;
      let output: string;
      
      switch (format) {
        case 'mermaid':
          output = result.diagram.mermaid;
          break;
        case 'ascii': {
          const asciiResult = renderAscii(result.diagram.mermaid);
          if (asciiResult.success) {
            output = result.description + '\n\n```\n' + asciiResult.ascii + '\n```';
          } else {
            console.error(chalk.yellow(`Warning: ASCII rendering failed: ${asciiResult.error}`));
            output = result.markdown;
          }
          break;
        }
        case 'dual':
          output = result.description + '\n\n' + renderDualOutput(result.diagram.mermaid);
          break;
        default:
          output = result.markdown;
      }
      
      if (options.output) {
        await fs.writeFile(options.output, output, 'utf-8');
        console.log(chalk.green(`✓ Visualization written to ${options.output}`));
      } else {
        console.log(output);
      }
      
    } catch (error) {
      console.error(chalk.red('Failed to generate visualization:'), error);
      process.exit(1);
    }
  });

// =============================================================================
// viz entity <cgId>
// =============================================================================

vizCommand
  .command('entity <cgId>')
  .description('Generate visualization for an entity and its neighbors')
  .option('--run <runId>', 'Use specific run (default: latest)')
  .option('--depth <n>', 'Neighbor expansion depth', '1')
  .option('--max-nodes <n>', 'Maximum nodes to include', '30')
  .option('--format <fmt>', 'Output format: mermaid, md, ascii, dual', 'md')
  .option('--direction <dir>', 'Flow direction: LR, TB, RL, BT', 'LR')
  .option('--ascii', 'Shorthand for --format dual (ASCII art with Mermaid in details)')
  .option('-o, --output <file>', 'Write to file instead of stdout')
  .action(async (cgId: string, options: VizEntityOptions & { ascii?: boolean }) => {
    try {
      const { entities, statements } = await loadGraphData(options.run);
      
      // Find entity (partial match)
      const entity = entities.find(e => 
        e.id === cgId || 
        e.id.includes(cgId) ||
        e.id.endsWith(`/${cgId}`)
      );
      
      if (!entity) {
        console.error(chalk.red(`Entity not found: ${cgId}`));
        console.error('');
        console.error('Searching for similar entities...');
        const matches = entities.filter(e => 
          e.id.toLowerCase().includes(cgId.toLowerCase())
        ).slice(0, 10);
        if (matches.length > 0) {
          console.error('Did you mean:');
          for (const m of matches) {
            console.error(`  ${m.id}`);
          }
        }
        process.exit(1);
      }
      
      const result = generateEntityLens(entity.id, entities, statements, {
        depth: parseInt(options.depth, 10),
        maxNodes: parseInt(options.maxNodes, 10),
        direction: options.direction as any,
      });
      
      // Determine format
      const format = options.ascii ? 'dual' : options.format;
      let output: string;
      
      switch (format) {
        case 'mermaid':
          output = result.diagram.mermaid;
          break;
        case 'ascii': {
          const asciiResult = renderAscii(result.diagram.mermaid);
          output = asciiResult.success
            ? result.description + '\n\n```\n' + asciiResult.ascii + '\n```'
            : result.markdown;
          break;
        }
        case 'dual':
          output = result.description + '\n\n' + renderDualOutput(result.diagram.mermaid);
          break;
        default:
          output = result.markdown;
      }
      
      if (options.output) {
        await fs.writeFile(options.output, output, 'utf-8');
        console.log(chalk.green(`✓ Visualization written to ${options.output}`));
      } else {
        console.log(output);
      }
      
    } catch (error) {
      console.error(chalk.red('Failed to generate visualization:'), error);
      process.exit(1);
    }
  });

// =============================================================================
// viz all - Generate all issue visualizations
// =============================================================================

vizCommand
  .command('all')
  .description('Generate visualizations for all issues')
  .option('--run <runId>', 'Use specific run (default: latest)')
  .option('--depth <n>', 'Neighbor expansion depth', '1')
  .option('--max-nodes <n>', 'Maximum nodes per diagram', '30')
  .option('--format <fmt>', 'Output format: mermaid, md, ascii, dual', 'md')
  .option('--ascii', 'Shorthand for --format dual (ASCII art with Mermaid in details)')
  .option('-o, --output <dir>', 'Output directory (default: .iw/viz)')
  .action(async (options: any) => {
    try {
      const { entities, statements, findings } = await loadGraphData(options.run);
      
      const outputDir = options.output || path.join(IW_DIR, 'viz');
      await fs.mkdir(outputDir, { recursive: true });
      
      let count = 0;
      for (let i = 0; i < findings.length; i++) {
        const finding = findings[i];
        if (finding.entities.length === 0) continue;
        
        const issue = findingToIssue(finding, `workspace:unknown#${finding.id}`, i + 1);
        const result = generateIssueLens(issue, entities, statements, {
          depth: parseInt(options.depth, 10),
          maxNodes: parseInt(options.maxNodes, 10),
          includeGhostEdges: true,
          includeDescription: true,
        });
        
        const filename = `${finding.id.replace(/[^a-z0-9-]/gi, '_')}_${i + 1}`;
        const format = options.ascii ? 'dual' : options.format;
        const ext = format === 'mermaid' ? '.mmd' : '.md';
        const filepath = path.join(outputDir, filename + ext);
        
        let output: string;
        switch (format) {
          case 'mermaid':
            output = result.diagram.mermaid;
            break;
          case 'ascii': {
            const asciiResult = renderAscii(result.diagram.mermaid);
            output = asciiResult.success 
              ? result.description + '\n\n```\n' + asciiResult.ascii + '\n```'
              : result.markdown;
            break;
          }
          case 'dual':
            output = result.description + '\n\n' + renderDualOutput(result.diagram.mermaid);
            break;
          default:
            output = result.markdown;
        }
        await fs.writeFile(filepath, output, 'utf-8');
        count++;
      }
      
      console.log(chalk.green(`✓ Generated ${count} visualizations in ${outputDir}`));
      
    } catch (error) {
      console.error(chalk.red('Failed to generate visualizations:'), error);
      process.exit(1);
    }
  });

// =============================================================================
// viz rbac - RBAC matrix visualization
// =============================================================================

vizCommand
  .command('rbac')
  .description('Generate RBAC matrix visualization')
  .option('--run <runId>', 'Use specific run (default: latest)')
  .option('--format <fmt>', 'Output format: mermaid, md, ascii, dual', 'md')
  .option('--ascii', 'Shorthand for --format dual (ASCII art with Mermaid in details)')
  .option('-o, --output <file>', 'Write to file instead of stdout')
  .action(async (options: VizRbacOptions & { ascii?: boolean }) => {
    try {
      const { entities, statements } = await loadGraphData(options.run);
      
      // Find roles and actions
      const roles = entities.filter(e => e.type === 'role');
      const actions = entities.filter(e => e.type === 'action');
      
      // Find authorization relationships
      const authStatements = statements.filter(s => 
        s.predicate === 'AUTHORIZED_FOR' || 
        s.predicate === 'CAN_PERFORM' ||
        s.predicate === 'PERFORMS'
      );
      
      // Build subgraph
      const allIds = [...roles.map(r => r.id), ...actions.map(a => a.id)];
      const subgraph = buildSubgraph(allIds, entities, authStatements, {
        depth: 0,
        maxNodes: 100,
        includeGhostEdges: false,
      });
      
      const diagram = renderMermaid(subgraph, {
        direction: 'LR',
        includeStyles: true,
        title: 'RBAC Matrix',
        wrapInCodeBlock: options.format !== 'mermaid',
      });
      
      // Determine format
      const format = options.ascii ? 'dual' : options.format;
      let output: string;
      
      switch (format) {
        case 'mermaid':
          output = diagram.mermaid;
          break;
        case 'ascii':
          output = renderAscii(diagram.mermaid).ascii;
          break;
        case 'dual':
          output = renderDualOutput(diagram.mermaid, 'RBAC Matrix');
          break;
        default:
          output = diagram.markdown;
      }
      
      if (options.output) {
        await fs.writeFile(options.output, output, 'utf-8');
        console.log(chalk.green(`✓ RBAC visualization written to ${options.output}`));
      } else {
        console.log(output);
      }
      
      // Summary
      console.error(chalk.dim(`\nRoles: ${roles.length}, Actions: ${actions.length}, Auth edges: ${authStatements.length}`));
      
    } catch (error) {
      console.error(chalk.red('Failed to generate RBAC visualization:'), error);
      process.exit(1);
    }
  });

// =============================================================================
// Helpers
// =============================================================================

interface GraphData {
  entities: VizEntity[];
  statements: VizStatement[];
  findings: VizFinding[];
  artifacts: Map<string, { id: string; path: string; role: string }>;
}

async function loadGraphData(runId?: string): Promise<GraphData> {
  const iwDir = path.resolve(IW_DIR);
  
  // Find run ID
  if (!runId) {
    runId = await findLatestRunId(iwDir) ?? undefined;
    if (!runId) {
      throw new Error('No runs found. Run the pipeline first with `iw run`.');
    }
  }
  
  const runDir = path.join(iwDir, 'runs', runId);
  
  // Load graph.json from bundle
  const graphPath = path.join(runDir, 'bundle', 'graph.json');
  let graphData: any;
  try {
    const graphContent = await fs.readFile(graphPath, 'utf-8');
    graphData = JSON.parse(graphContent);
  } catch {
    throw new Error(`Graph data not found at ${graphPath}. Run the pipeline first.`);
  }
  
  // Load findings from aggregate
  const findingsPath = path.join(runDir, 'aggregate', 'findings.json');
  let findingsData: any = { findings: [] };
  try {
    const findingsContent = await fs.readFile(findingsPath, 'utf-8');
    findingsData = JSON.parse(findingsContent);
  } catch {
    // Findings may not exist
  }
  
  // Build artifacts map
  const artifacts = new Map<string, { id: string; path: string; role: string }>();
  for (const a of graphData.artifacts || []) {
    artifacts.set(a.id, { id: a.id, path: a.path, role: a.role });
  }
  
  // Convert to viz types with artifact path lookup
  const entities: VizEntity[] = (graphData.entities || []).map((e: any) => {
    const artifact = artifacts.get(e.artifactId);
    return {
      id: e.cgId,
      type: e.type,
      label: e.name || e.cgId.split('/').pop(),
      artifact: e.artifactId,
      artifactPath: artifact?.path,
      props: e.props,
    };
  });
  
  const statements: VizStatement[] = (graphData.statements || []).map((s: any) => ({
    id: s.id,
    subject: s.subjectCgId,
    predicate: s.predicate,
    object: s.objectCgId,
    confidence: s.confidence,
    artifact: s.artifactId,
  }));
  
  const findings: VizFinding[] = (findingsData.findings || []).map((f: any) => ({
    id: f.id || f.ruleId,
    severity: f.severity || 'warning',
    category: f.category || 'unknown',
    message: f.message,
    entities: f.entities || [],
  }));
  
  return { entities, statements, findings, artifacts };
}
