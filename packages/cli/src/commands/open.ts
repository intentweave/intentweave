// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * open command - View message content and context
 */

import { Command } from 'commander';
import chalk from 'chalk';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { 
  parseSourceKey,
  loadTranscript,
  getTranscriptPath,
  type TranscriptMessage,
} from '@intentweave/core';

interface OpenOptions {
  noContext: boolean;
  raw: boolean;
  context: string;
}

export const openCommand = new Command('open')
  .description('View message content and context')
  .argument('<sourceKey>', 'Message source key (e.g., specstory:90dd218c:m:42)')
  .option('--no-context', 'Show only the target message, no context window')
  .option('--raw', 'Open original source file (if available)')
  .option('-c, --context <n>', 'Number of context messages before/after', '3')
  .action(async (sourceKey: string, options: OpenOptions) => {
    // Use cwd as workspace root, getTranscriptPath adds .iw/transcripts/ internally
    const workspaceRoot = process.cwd();
    
    // Parse source key
    const parsed = parseSourceKey(sourceKey);
    if (!parsed) {
      console.error(chalk.red(`Invalid source key format: ${sourceKey}`));
      console.log('');
      console.log('Expected format: <source>:<sessionId>:m:<seq>');
      console.log('Example: specstory:90dd218c:m:42');
      process.exit(1);
    }
    
    const { source, sessionId, seq } = parsed;
    
    // Find transcript
    const transcriptPath = getTranscriptPath(workspaceRoot, source, sessionId);
    
    if (!existsSync(transcriptPath)) {
      console.error(chalk.red(`Transcript not found: ${transcriptPath}`));
      console.log('');
      console.log(`Run ${chalk.cyan('iw import')} to import transcripts first.`);
      process.exit(1);
    }
    
    try {
      // Load transcript
      const messages = await loadTranscript(transcriptPath);
      
      // Find target message (seq is 1-based in sourceKey but 0-based in array)
      const targetIndex = messages.findIndex(m => {
        const parsedKey = parseSourceKey(m.sourceKey);
        return parsedKey && parsedKey.seq === seq;
      });
      
      if (targetIndex === -1) {
        console.error(chalk.red(`Message not found: seq=${seq}`));
        console.log('');
        console.log(`Transcript has ${messages.length} messages.`);
        process.exit(1);
      }
      
      const target = messages[targetIndex];
      
      // Header
      console.log('');
      console.log(chalk.bold(`Message ${sourceKey}`));
      console.log('');
      
      // Metadata
      console.log(chalk.dim('Metadata'));
      console.log(`  Speaker:    ${target.speaker}`);
      console.log(`  Role:       ${target.messageRole ?? 'undefined'} (${target.roleSource})`);
      if (target.ts) {
        console.log(`  Timestamp:  ${target.ts}`);
      }
      console.log(`  Hash:       ${target.contentHash.substring(0, 16)}...`);
      console.log('');
      
      // Context window
      if (!options.noContext) {
        const contextSize = parseInt(options.context, 10) || 3;
        const startIdx = Math.max(0, targetIndex - contextSize);
        const endIdx = Math.min(messages.length - 1, targetIndex + contextSize);
        
        console.log(chalk.dim(`Context (m:${startIdx + 1}-${endIdx + 1})`));
        console.log(chalk.dim('─'.repeat(60)));
        
        for (let i = startIdx; i <= endIdx; i++) {
          const msg = messages[i];
          const isTarget = i === targetIndex;
          const prefix = isTarget ? chalk.yellow('→') : ' ';
          const seqNum = i + 1;
          const speakerColor = msg.speaker === 'user' ? chalk.blue : chalk.green;
          
          // Truncate long messages
          const text = truncateText(msg.text, 200);
          
          if (isTarget) {
            console.log(`${prefix} ${chalk.bold(`[${seqNum}]`)} ${speakerColor(msg.speaker)}: ${text}`);
          } else {
            console.log(`${prefix} [${seqNum}] ${speakerColor(msg.speaker)}: ${chalk.dim(text)}`);
          }
        }
        
        console.log(chalk.dim('─'.repeat(60)));
        console.log('');
      }
      
      // Full message content
      console.log(chalk.dim('Full Content'));
      console.log(chalk.dim('─'.repeat(60)));
      console.log(target.text);
      console.log(chalk.dim('─'.repeat(60)));
      console.log('');
      
      // Source location
      if (target.refs?.sourceLoc) {
        const loc = target.refs.sourceLoc;
        console.log(chalk.dim('Source Location'));
        console.log(`  File:       ${loc.file}`);
        console.log(`  Bytes:      ${loc.byteStart}-${loc.byteEnd}`);
        console.log('');
        
        if (options.raw && existsSync(loc.file)) {
          console.log(chalk.dim('Opening raw source...'));
          // Could open in editor here, for now just show path
          console.log(`  ${chalk.cyan(loc.file)}`);
        }
      }
      
      // Commands
      console.log(chalk.dim('Commands'));
      console.log(`  iw role set ${sourceKey} <role>  # Override role`);
      console.log(`  iw explain <issueId>             # If this message is evidence`);
      console.log('');
      
    } catch (error) {
      console.error(chalk.red('Failed to load transcript:'), error);
      process.exit(1);
    }
  });

function truncateText(text: string, maxLength: number): string {
  // Remove newlines for preview
  const oneLine = text.replace(/\n+/g, ' ').trim();
  if (oneLine.length <= maxLength) return oneLine;
  return oneLine.substring(0, maxLength - 3) + '...';
}
