/**
 * Heuristics for Role Assignment
 * 
 * Score-based system for determining message roles (human vs assistant).
 * Supports multi-language patterns (EN + DE).
 */

import type { Speaker, MessageRole, HeuristicsResult } from './types.js';
import { HEURISTICS_VERSION } from './types.js';

// =============================================================================
// Score Configuration
// =============================================================================

/**
 * Weights for different heuristic signals.
 * Positive = human, Negative = assistant.
 */
const WEIGHTS = {
  // Strong human signals
  question: 3,
  imperative: 3,
  politeness: 2,
  firstPerson: 1,
  shortLength: 1,
  
  // Strong assistant signals
  codeBlock: -3,
  explanation: -2,
  structuredList: -2,
  longLength: -1,
  technicalDetail: -2,
} as const;

/**
 * Threshold for role assignment.
 * score > 0: human
 * score < 0: assistant
 * score === 0: fallback to structural position
 */
const NEUTRAL_THRESHOLD = 0;

// =============================================================================
// Pattern Definitions (Multi-language)
// =============================================================================

/**
 * Patterns for detecting questions.
 * Matches question marks and question words.
 */
const QUESTION_PATTERNS = [
  // English
  /\?$/m,
  /^(what|how|why|when|where|who|which|can you|could you|would you|will you|do you|did you|is there|are there|is it|was it)\b/im,
  
  // German
  /^(was|wie|warum|wann|wo|wer|welche[rs]?|kannst du|könntest du|würdest du|wirst du|machst du|hast du|gibt es|ist es|war es)\b/im,
];

/**
 * Patterns for detecting imperatives/commands.
 */
const IMPERATIVE_PATTERNS = [
  // English
  /^(please|pls|create|make|add|remove|delete|update|change|fix|implement|write|show|tell|explain|help|build|generate|find|search|check|run|test)\b/im,
  
  // German
  /^(bitte|erstelle|mache?|füge? hinzu|entferne?|lösche?|aktualisiere?|ändere?|fixe?|implementiere?|schreibe?|zeige?|erkläre?|hilf|baue?|generiere?|finde?|suche?|prüfe?|führe? aus|teste?)\b/im,
];

/**
 * Patterns for politeness markers (human signal).
 */
const POLITENESS_PATTERNS = [
  // English
  /\b(please|thanks|thank you|appreciate|sorry|excuse me)\b/i,
  
  // German
  /\b(bitte|danke|vielen dank|entschuldigung|verzeihung)\b/i,
];

/**
 * Patterns for assistant explanations.
 */
const EXPLANATION_PATTERNS = [
  // English
  /^(here'?s?|this is|i'?ll|i will|i can|let me|sure|certainly|of course|absolutely|i'?ve|i have|the|this)\b/im,
  /\b(as shown|as you can see|note that|remember that|keep in mind)\b/i,
  
  // German
  /^(hier ist|das ist|ich werde|ich kann|lass mich|sicher|natürlich|selbstverständlich|ich habe|der|die|das|dies)\b/im,
  /\b(wie gezeigt|wie du siehst|beachte dass|denke daran)\b/i,
];

/**
 * Patterns for code blocks.
 */
const CODE_BLOCK_PATTERN = /```[\s\S]*?```/g;

/**
 * Patterns for structured lists (assistant signal).
 */
const STRUCTURED_LIST_PATTERNS = [
  /^[\s]*[-*]\s/m,  // Bullet lists
  /^[\s]*\d+\.\s/m, // Numbered lists
  /^[\s]*#{1,6}\s/m, // Markdown headers
];

/**
 * Inline tags to strip before analysis.
 * These are SpecStory-specific markers.
 */
const INLINE_TAG_PATTERN = /<(user_message|assistant_response|timestamp|info_added_to_conversation_history|environment_details|system|potentially_relevant_details|feedback_history|auto_mode_status|tool_response|tool_name|tool_status|parameter|execute_command|read_file|write_to_file|search_files|browser_action|mcp_server|thinking)[^>]*>[\s\S]*?<\/\1>/gi;

/**
 * IntentWeave role override patterns to strip.
 */
const IW_ROLE_PATTERN = /@iw\s+role=\w+\s*/gi;
const IW_COMMENT_ROLE_PATTERN = /<!--\s*iw:role=\w+\s*-->/gi;

// =============================================================================
// Core Heuristics
// =============================================================================

/**
 * Score a message to determine its role.
 * Returns score, predicted role, and confidence.
 * 
 * @param text - Raw message text (will be stripped of inline tags)
 * @returns Heuristics result with score and role prediction
 */
export function scoreMessage(text: string): HeuristicsResult {
  // Strip inline tags first
  const cleanText = stripInlineTags(text);
  
  let score = 0;
  const signals: string[] = [];
  
  // Check for questions
  if (QUESTION_PATTERNS.some(p => p.test(cleanText))) {
    score += WEIGHTS.question;
    signals.push('question');
  }
  
  // Check for imperatives
  if (IMPERATIVE_PATTERNS.some(p => p.test(cleanText))) {
    score += WEIGHTS.imperative;
    signals.push('imperative');
  }
  
  // Check for politeness
  if (POLITENESS_PATTERNS.some(p => p.test(cleanText))) {
    score += WEIGHTS.politeness;
    signals.push('politeness');
  }
  
  // Check for code blocks (strong assistant signal)
  const codeBlocks = cleanText.match(CODE_BLOCK_PATTERN);
  if (codeBlocks && codeBlocks.length > 0) {
    score += WEIGHTS.codeBlock * Math.min(codeBlocks.length, 3); // Cap at 3
    signals.push(`codeBlock:${codeBlocks.length}`);
  }
  
  // Check for explanation patterns
  if (EXPLANATION_PATTERNS.some(p => p.test(cleanText))) {
    score += WEIGHTS.explanation;
    signals.push('explanation');
  }
  
  // Check for structured lists
  if (STRUCTURED_LIST_PATTERNS.some(p => p.test(cleanText))) {
    score += WEIGHTS.structuredList;
    signals.push('structuredList');
  }
  
  // Length heuristics
  const length = cleanText.length;
  if (length < 100) {
    score += WEIGHTS.shortLength;
    signals.push('shortLength');
  } else if (length > 500) {
    score += WEIGHTS.longLength;
    signals.push('longLength');
  }
  
  // Determine role
  let speaker: Speaker;
  if (score > NEUTRAL_THRESHOLD) {
    speaker = 'user';
  } else if (score < NEUTRAL_THRESHOLD) {
    speaker = 'assistant';
  } else {
    // Neutral - will need structural fallback
    speaker = 'user'; // Default to user for user-initiated conversations
  }
  
  // Calculate confidence (0-1 scale)
  // Higher absolute score = higher confidence
  const absScore = Math.abs(score);
  const confidence = Math.min(absScore / 10, 1);
  
  return {
    score,
    speaker,
    confidence,
    signals,
    version: HEURISTICS_VERSION,
  };
}

/**
 * Apply structural fallback for neutral scores.
 * Uses position-based alternation when heuristics are inconclusive.
 * 
 * @param position - 0-based position in conversation
 * @param result - Heuristics result
 * @returns Updated result with structural fallback applied
 */
export function applyStructuralFallback(
  position: number,
  result: HeuristicsResult
): HeuristicsResult {
  if (result.score === 0) {
    // Even positions = user, odd positions = assistant
    const speaker: Speaker = position % 2 === 0 ? 'user' : 'assistant';
    return {
      ...result,
      speaker,
      signals: [...result.signals, 'structural_fallback'],
    };
  }
  return result;
}

/**
 * Determine artifact role from speaker.
 * Maps speaker to semantic artifact role in the pipeline.
 * 
 * @param speaker - Message speaker
 * @returns Artifact role for pipeline
 */
export function speakerToMessageRole(speaker: Speaker): MessageRole {
  switch (speaker) {
    case 'user':
      return 'intent';      // User messages typically express intent
    case 'assistant':
      return 'implementation'; // Assistant typically provides implementations
    case 'system':
      return 'meta';        // System messages are metadata
    case 'tool':
      return 'runlog';      // Tool outputs are run logs
    default:
      return 'unknown';
  }
}

// =============================================================================
// Inline Tag Stripping
// =============================================================================

/**
 * Strip inline tags from text.
 * Removes SpecStory-specific XML tags and IntentWeave role markers.
 * 
 * @param text - Raw text with potential inline tags
 * @returns Clean text without inline tags
 */
export function stripInlineTags(text: string): string {
  return text
    .replace(INLINE_TAG_PATTERN, '')
    .replace(IW_ROLE_PATTERN, '')
    .replace(IW_COMMENT_ROLE_PATTERN, '')
    .trim();
}

/**
 * Extract content from a specific inline tag.
 * 
 * @param text - Raw text with inline tags
 * @param tagName - Name of tag to extract
 * @returns Array of extracted contents
 */
export function extractInlineTag(text: string, tagName: string): string[] {
  const pattern = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
  const matches: string[] = [];
  
  let match;
  while ((match = pattern.exec(text)) !== null) {
    matches.push(match[1].trim());
  }
  
  return matches;
}

// =============================================================================
// Batch Processing
// =============================================================================

/**
 * Score multiple messages and apply structural fallback.
 * 
 * @param messages - Array of message texts
 * @returns Array of heuristics results
 */
export function scoreMessages(messages: string[]): HeuristicsResult[] {
  return messages.map((text, index) => {
    const result = scoreMessage(text);
    return applyStructuralFallback(index, result);
  });
}

// =============================================================================
// Result Types (re-export for convenience)
// =============================================================================

export type { HeuristicsResult } from './types.js';
