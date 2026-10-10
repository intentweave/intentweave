import type { KeywordMatch, MentionRecord, SemanticChunk, SignalQualifier } from "@intentweave/core";
import type { HeuristicKeywordExtractorOptions } from "./heuristicExtractor.js";
import type { RegexQualifierDetector } from "./regexQualifier.js";

export interface KwxChunkProcessorOptions {
  minLength?: number;
  depth?: "structured" | "full";
  dictionary?: Set<string>;
}

const sourceExtension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
const [extractorModule, qualifierModule] = await Promise.all([
  import(new URL(`./heuristicExtractor${sourceExtension}`, import.meta.url).href),
  import(new URL(`./regexQualifier${sourceExtension}`, import.meta.url).href),
]) as [typeof import("./heuristicExtractor.js"), typeof import("./regexQualifier.js")];

export class KwxChunkProcessor {
  private readonly extractor: InstanceType<typeof extractorModule.HeuristicKeywordExtractor>;
  private readonly qualifierDetector: InstanceType<typeof qualifierModule.RegexQualifierDetector>;

  constructor(options?: KwxChunkProcessorOptions) {
    this.extractor = new extractorModule.HeuristicKeywordExtractor(options as HeuristicKeywordExtractorOptions | undefined);
    this.qualifierDetector = new qualifierModule.RegexQualifierDetector();
  }

  process(filePath: string, chunk: SemanticChunk): MentionRecord[] {
    const heading = getHeadingContext(chunk);
    const keywordMatches = this.extractor.extract(chunk.content, heading);
    return keywordMatches.map((keyword) => toMention(filePath, chunk, heading, keyword, this.qualifierDetector));
  }
}

function toMention(
  filePath: string,
  chunk: SemanticChunk,
  heading: string | undefined,
  keyword: KeywordMatch,
  qualifierDetector: RegexQualifierDetector,
): MentionRecord {
  const sentence = extractSentence(chunk.content, keyword.offset);
  const qualifiers: SignalQualifier[] = qualifierDetector.detect(keyword, sentence);
  return {
    entityName: keyword.name,
    text: sentence,
    heading,
    filePath,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    startChar: keyword.offset,
    endChar: keyword.offset + keyword.length,
    qualifiers,
    source: keyword.source,
    chunkId: chunk.id,
    chunkType: chunk.type,
  };
}

function getHeadingContext(chunk: SemanticChunk): string | undefined {
  if (chunk.type === "heading" || chunk.type === "section") return chunk.title;
  return chunk.metadata?.heading as string | undefined;
}

function extractSentence(text: string, offset: number): string {
  const sentenceBreakRe = /[.!?]\s+|\n\n/g;
  let sentenceStart = 0;
  let sentenceEnd = text.length;
  let match: RegExpExecArray | null;

  while ((match = sentenceBreakRe.exec(text)) !== null) {
    const breakEnd = match.index + match[0].length;
    if (breakEnd <= offset) sentenceStart = breakEnd;
    if (match.index >= offset && sentenceEnd === text.length) {
      sentenceEnd = match.index + 1;
      break;
    }
  }

  if (sentenceEnd - sentenceStart > 300) {
    sentenceStart = Math.max(0, offset - 120);
    sentenceEnd = Math.min(text.length, offset + 120);
  }
  return text.slice(sentenceStart, sentenceEnd).trim();
}