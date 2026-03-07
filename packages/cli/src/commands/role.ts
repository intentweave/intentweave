// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Role Command
 * 
 * Manage message role assignments for transcripts.
 * Supports manual overrides, listing, statistics, and auto-reassignment.
 */

import { Command } from 'commander';
import {
  loadRoleOverrides,
  saveRoleOverride,
  deleteRoleOverride,
  getRoleOverridesForSession,
  loadTranscript,
  getTranscriptPath,
  listTranscriptSessions,
  listTranscriptSources,
  scoreMessage,
  speakerToMessageRole,
  type MessageRole,
  type RoleOverride,
  type TranscriptMessage,
} from '@intentweave/core';

// =============================================================================
// Valid Roles
// =============================================================================

const VALID_ROLES: MessageRole[] = [
  'intent',
  'spec',
  'implementation',
  'runlog',
  'meta',
  'unknown',
];

// =============================================================================
// Helpers
// =============================================================================

interface SessionInfo {
  source: string;
  sessionId: string;
}

/**
 * List all transcript sessions across all sources.
 */
async function getAllSessions(workspaceRoot: string): Promise<SessionInfo[]> {
  const sources = await listTranscriptSources(workspaceRoot);
  const allSessions: SessionInfo[] = [];
  
  for (const source of sources) {
    const sessionIds = await listTranscriptSessions(workspaceRoot, source);
    for (const sessionId of sessionIds) {
      allSessions.push({ source, sessionId });
    }
  }
  
  return allSessions;
}

/**
 * Find a session by session ID (searches across all sources).
 * Supports prefix matching for convenience.
 */
async function findSession(workspaceRoot: string, sessionId: string): Promise<SessionInfo | null> {
  const sources = await listTranscriptSources(workspaceRoot);
  
  for (const source of sources) {
    const sessionIds = await listTranscriptSessions(workspaceRoot, source);
    
    // Exact match first
    if (sessionIds.includes(sessionId)) {
      return { source, sessionId };
    }
    
    // Prefix match (for convenience)
    const match = sessionIds.find(s => s.startsWith(sessionId));
    if (match) {
      return { source, sessionId: match };
    }
  }
  
  return null;
}

// =============================================================================
// Main Role Command
// =============================================================================

export const roleCommand = new Command('role')
  .description('Manage message role assignments for transcripts');

// =============================================================================
// role set <sourceKey> <role>
// =============================================================================

roleCommand
  .command('set <sourceKey> <role>')
  .description('Set a role override for a message')
  .option('-r, --reason <reason>', 'Reason for the override')
  .option('-w, --workspace <path>', 'Workspace root directory')
  .action(async (sourceKey: string, role: string, options) => {
    try {
      const workspaceRoot = options.workspace ?? process.cwd();
      
      // Validate role
      if (!VALID_ROLES.includes(role as MessageRole)) {
        console.error(`Invalid role: ${role}`);
        console.log(`Valid roles: ${VALID_ROLES.join(', ')}`);
        process.exit(1);
      }
      
      // Validate sourceKey format: <source>:<sessionId>:m:<seq>
      const keyParts = sourceKey.split(':');
      if (keyParts.length < 4 || keyParts[2] !== 'm') {
        console.error(`Invalid sourceKey format: ${sourceKey}`);
        console.log('Expected format: <source>:<sessionId>:m:<seq>');
        console.log('Example: specstory:abc123:m:5');
        process.exit(1);
      }
      
      // Create override
      const override: RoleOverride = {
        role: role as MessageRole,
        setAt: new Date().toISOString(),
        setBy: 'user',
        reason: options.reason,
      };
      
      await saveRoleOverride(workspaceRoot, sourceKey, override);
      
      console.log(`✓ Role override set: ${sourceKey} → ${role}`);
      if (options.reason) {
        console.log(`  Reason: ${options.reason}`);
      }
    } catch (error) {
      console.error('Failed to set role:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// =============================================================================
// role unset <sourceKey>
// =============================================================================

roleCommand
  .command('unset <sourceKey>')
  .description('Remove a role override for a message')
  .option('-w, --workspace <path>', 'Workspace root directory')
  .action(async (sourceKey: string, options) => {
    try {
      const workspaceRoot = options.workspace ?? process.cwd();
      
      const deleted = await deleteRoleOverride(workspaceRoot, sourceKey);
      
      if (deleted) {
        console.log(`✓ Role override removed: ${sourceKey}`);
      } else {
        console.log(`No override found for: ${sourceKey}`);
      }
    } catch (error) {
      console.error('Failed to unset role:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// =============================================================================
// role list [--session <id>]
// =============================================================================

roleCommand
  .command('list')
  .description('List role overrides')
  .option('-s, --session <id>', 'Filter by session ID')
  .option('-w, --workspace <path>', 'Workspace root directory')
  .option('-j, --json', 'Output as JSON')
  .action(async (options) => {
    try {
      const workspaceRoot = options.workspace ?? process.cwd();
      
      let overrides: Record<string, RoleOverride>;
      
      if (options.session) {
        overrides = await getRoleOverridesForSession(workspaceRoot, options.session);
      } else {
        overrides = await loadRoleOverrides(workspaceRoot);
      }
      
      const entries = Object.entries(overrides);
      
      if (entries.length === 0) {
        if (options.json) {
          console.log('{}');
        } else {
          console.log('No role overrides found.');
        }
        return;
      }
      
      if (options.json) {
        console.log(JSON.stringify(overrides, null, 2));
        return;
      }
      
      // Table output
      console.log(`Role Overrides (${entries.length}):\n`);
      console.log(`  ${'SOURCE KEY'.padEnd(50)} ${'ROLE'.padEnd(15)} ${'SET BY'.padEnd(8)} REASON`);
      console.log('  ' + '-'.repeat(90));
      
      for (const [key, override] of entries) {
        const truncatedKey = key.length > 48 ? key.slice(0, 45) + '...' : key;
        console.log(
          `  ${truncatedKey.padEnd(50)} ${override.role.padEnd(15)} ${override.setBy.padEnd(8)} ${override.reason || ''}`
        );
      }
    } catch (error) {
      console.error('Failed to list roles:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// =============================================================================
// role stats [--session <id>]
// =============================================================================

roleCommand
  .command('stats')
  .description('Show role distribution statistics')
  .option('-s, --session <id>', 'Filter by session ID')
  .option('-a, --all-sessions', 'Show stats for all sessions')
  .option('-w, --workspace <path>', 'Workspace root directory')
  .option('-j, --json', 'Output as JSON')
  .action(async (options) => {
    try {
      const workspaceRoot = options.workspace ?? process.cwd();
      
      // Get sessions to analyze
      let sessions: SessionInfo[] = [];
      
      if (options.session) {
        // Single session - need to find the source
        const found = await findSession(workspaceRoot, options.session);
        if (found) {
          sessions = [found];
        } else {
          console.error(`Session not found: ${options.session}`);
          process.exit(1);
        }
      } else if (options.allSessions) {
        sessions = await getAllSessions(workspaceRoot);
      } else {
        // Default: show all sessions
        sessions = await getAllSessions(workspaceRoot);
      }
      
      if (sessions.length === 0) {
        console.log('No transcript sessions found.');
        return;
      }
      
      // Load role overrides
      const overrides = await loadRoleOverrides(workspaceRoot);
      
      // Collect stats per session
      interface SessionStats {
        source: string;
        sessionId: string;
        total: number;
        byRole: Record<MessageRole, number>;
        byRoleSource: Record<string, number>;
      }
      
      const allStats: SessionStats[] = [];
      
      for (const session of sessions) {
        const transcriptPath = getTranscriptPath(workspaceRoot, session.source, session.sessionId);
        let messages: TranscriptMessage[] = [];
        
        try {
          messages = await loadTranscript(transcriptPath);
        } catch (err) {
          // Skip sessions without transcript files
          continue;
        }
        
        const stats: SessionStats = {
          source: session.source,
          sessionId: session.sessionId,
          total: messages.length,
          byRole: {
            intent: 0,
            spec: 0,
            implementation: 0,
            runlog: 0,
            meta: 0,
            unknown: 0,
          },
          byRoleSource: {
            override: 0,
            inline: 0,
            heuristic: 0,
            llm: 0,
          },
        };
        
        for (const msg of messages) {
          // Check for override
          const override = overrides[msg.sourceKey];
          const role = override ? override.role : msg.messageRole;
          const roleSource = override ? 'override' : msg.roleSource;
          
          stats.byRole[role] = (stats.byRole[role] || 0) + 1;
          stats.byRoleSource[roleSource] = (stats.byRoleSource[roleSource] || 0) + 1;
        }
        
        allStats.push(stats);
      }
      
      if (allStats.length === 0) {
        console.log('No transcript data found.');
        return;
      }
      
      if (options.json) {
        console.log(JSON.stringify(allStats, null, 2));
        return;
      }
      
      // Pretty print stats
      for (const stats of allStats) {
        console.log(`\n📊 Session: ${stats.source}:${stats.sessionId.slice(0, 8)}...`);
        console.log(`   Total messages: ${stats.total}\n`);
        
        console.log('   Roles:');
        for (const [role, count] of Object.entries(stats.byRole)) {
          if (count > 0) {
            const pct = ((count / stats.total) * 100).toFixed(1);
            const bar = '█'.repeat(Math.round(count / stats.total * 20));
            console.log(`     ${role.padEnd(15)} ${String(count).padStart(4)} (${pct.padStart(5)}%) ${bar}`);
          }
        }
        
        console.log('\n   Role Sources:');
        for (const [source, count] of Object.entries(stats.byRoleSource)) {
          if (count > 0) {
            const pct = ((count / stats.total) * 100).toFixed(1);
            console.log(`     ${source.padEnd(15)} ${String(count).padStart(4)} (${pct.padStart(5)}%)`);
          }
        }
      }
      
      // Summary if multiple sessions
      if (allStats.length > 1) {
        const totalMessages = allStats.reduce((sum, s) => sum + s.total, 0);
        const aggregateByRole: Record<string, number> = {};
        
        for (const stats of allStats) {
          for (const [role, count] of Object.entries(stats.byRole)) {
            aggregateByRole[role] = (aggregateByRole[role] || 0) + count;
          }
        }
        
        console.log(`\n📈 Aggregate (${allStats.length} sessions, ${totalMessages} messages):`);
        for (const [role, count] of Object.entries(aggregateByRole)) {
          if (count > 0) {
            const pct = ((count / totalMessages) * 100).toFixed(1);
            console.log(`     ${role.padEnd(15)} ${String(count).padStart(4)} (${pct.padStart(5)}%)`);
          }
        }
      }
    } catch (error) {
      console.error('Failed to get stats:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// =============================================================================
// role auto [--session <id>]
// =============================================================================

roleCommand
  .command('auto')
  .description('Rerun heuristics for role assignment')
  .option('-s, --session <id>', 'Filter by session ID')
  .option('-d, --dry-run', 'Show what would change without applying')
  .option('-f, --force', 'Overwrite existing overrides')
  .option('-w, --workspace <path>', 'Workspace root directory')
  .action(async (options) => {
    try {
      const workspaceRoot = options.workspace ?? process.cwd();
      
      // Get sessions to process
      let sessions: SessionInfo[] = [];
      
      if (options.session) {
        const found = await findSession(workspaceRoot, options.session);
        if (found) {
          sessions = [found];
        } else {
          console.error(`Session not found: ${options.session}`);
          process.exit(1);
        }
      } else {
        console.error('Please specify a session with --session <id>');
        console.log('Use "iw role stats" to see available sessions.');
        process.exit(1);
      }
      
      // Load existing overrides
      const existingOverrides = await loadRoleOverrides(workspaceRoot);
      
      let totalProcessed = 0;
      let totalChanged = 0;
      let totalSkipped = 0;
      
      for (const session of sessions) {
        const transcriptPath = getTranscriptPath(workspaceRoot, session.source, session.sessionId);
        let messages: TranscriptMessage[] = [];
        
        try {
          messages = await loadTranscript(transcriptPath);
        } catch (err) {
          console.log(`⚠ Could not load transcript for ${session.sessionId}`);
          continue;
        }
        
        console.log(`\n🔄 Processing session: ${session.source}:${session.sessionId.slice(0, 8)}...`);
        console.log(`   ${messages.length} messages\n`);
        
        for (const msg of messages) {
          totalProcessed++;
          
          // Skip if override exists and not forcing
          if (existingOverrides[msg.sourceKey] && !options.force) {
            totalSkipped++;
            continue;
          }
          
          // Run heuristics
          const result = scoreMessage(msg.text);
          const newRole = speakerToMessageRole(result.speaker);
          const currentRole = existingOverrides[msg.sourceKey]?.role ?? msg.messageRole;
          
          if (newRole !== currentRole) {
            totalChanged++;
            
            if (options.dryRun) {
              console.log(`   [DRY RUN] ${msg.sourceKey.slice(-20)}: ${currentRole} → ${newRole}`);
            } else {
              const override: RoleOverride = {
                role: newRole,
                setAt: new Date().toISOString(),
                setBy: 'auto',
                reason: `Heuristic score: ${result.score} (${result.signals.join(', ')})`,
                contentHash: msg.contentHash,
              };
              
              await saveRoleOverride(workspaceRoot, msg.sourceKey, override);
              console.log(`   ✓ ${msg.sourceKey.slice(-20)}: ${currentRole} → ${newRole}`);
            }
          }
        }
      }
      
      console.log(`\n📊 Summary:`);
      console.log(`   Processed: ${totalProcessed}`);
      console.log(`   Changed:   ${totalChanged}`);
      console.log(`   Skipped:   ${totalSkipped} (existing overrides)`);
      
      if (options.dryRun && totalChanged > 0) {
        console.log(`\n   Run without --dry-run to apply changes.`);
      }
    } catch (error) {
      console.error('Failed to run auto:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });
