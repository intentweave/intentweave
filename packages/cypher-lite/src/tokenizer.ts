// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CypherLite tokenizer.
 *
 * Converts a Cypher query string into a stream of tokens.
 * Handles keywords, identifiers, strings, numbers, parameters, operators,
 * and punctuation for the supported Cypher subset.
 */

import { Token, TokenType } from "./types.js";

const KEYWORDS: Record<string, TokenType> = {
  MATCH: TokenType.MATCH,
  OPTIONAL: TokenType.OPTIONAL,
  WHERE: TokenType.WHERE,
  RETURN: TokenType.RETURN,
  ORDER: TokenType.ORDER,
  BY: TokenType.BY,
  LIMIT: TokenType.LIMIT,
  SKIP: TokenType.SKIP,
  CREATE: TokenType.CREATE,
  MERGE: TokenType.MERGE,
  DELETE: TokenType.DELETE,
  DETACH: TokenType.DETACH,
  SET: TokenType.SET,
  ON: TokenType.ON,
  UNWIND: TokenType.UNWIND,
  WITH: TokenType.WITH,
  AS: TokenType.AS,
  AND: TokenType.AND,
  OR: TokenType.OR,
  NOT: TokenType.NOT,
  IN: TokenType.IN,
  IS: TokenType.IS,
  NULL: TokenType.NULL,
  TRUE: TokenType.TRUE,
  FALSE: TokenType.FALSE,
  CONTAINS: TokenType.CONTAINS,
  STARTS: TokenType.STARTS,
  ENDS: TokenType.ENDS,
  ANY: TokenType.ANY,
  DISTINCT: TokenType.DISTINCT,
  CASE: TokenType.CASE,
  WHEN: TokenType.WHEN,
  THEN: TokenType.THEN,
  ELSE: TokenType.ELSE,
  END: TokenType.END,
  ASC: TokenType.ASC,
  DESC: TokenType.DESC,
  EXISTS: TokenType.EXISTS,
  COUNT: TokenType.COUNT,
  COLLECT: TokenType.COLLECT,
  COALESCE: TokenType.COALESCE,
  TOLOWER: TokenType.TOLOWER,
};

export class CypherLiteTokenizer {
  private input: string;
  private pos = 0;
  private tokens: Token[] = [];

  constructor(input: string) {
    this.input = input;
  }

  tokenize(): Token[] {
    this.tokens = [];
    this.pos = 0;

    while (this.pos < this.input.length) {
      this.skipWhitespace();
      if (this.pos >= this.input.length) break;

      const ch = this.input[this.pos];

      // Single-line comments
      if (ch === "/" && this.input[this.pos + 1] === "/") {
        this.skipLineComment();
        continue;
      }

      // Strings (single or double quoted)
      if (ch === "'" || ch === '"') {
        this.readString(ch);
        continue;
      }

      // Backtick-quoted identifier
      if (ch === "`") {
        this.readBacktickIdentifier();
        continue;
      }

      // Numbers
      if (ch >= "0" && ch <= "9") {
        this.readNumber();
        continue;
      }

      // Parameters ($name)
      if (ch === "$") {
        this.readParameter();
        continue;
      }

      // Multi-character operators / punctuation
      if (this.tryMultiChar()) continue;

      // Single-character punctuation
      if (this.trySingleChar(ch)) continue;

      // Identifiers / keywords
      if (this.isIdentStart(ch)) {
        this.readIdentifier();
        continue;
      }

      throw new Error(
        `CypherLite: Unexpected character '${ch}' at position ${this.pos}`,
      );
    }

    this.tokens.push({ type: TokenType.EOF, value: "", position: this.pos });
    return this.tokens;
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private skipWhitespace(): void {
    while (this.pos < this.input.length && /\s/.test(this.input[this.pos])) {
      this.pos++;
    }
  }

  private skipLineComment(): void {
    while (this.pos < this.input.length && this.input[this.pos] !== "\n") {
      this.pos++;
    }
  }

  private readString(quote: string): void {
    const start = this.pos;
    this.pos++; // skip opening quote
    let value = "";
    while (this.pos < this.input.length) {
      const ch = this.input[this.pos];
      if (ch === "\\") {
        this.pos++;
        if (this.pos < this.input.length) {
          const escaped = this.input[this.pos];
          switch (escaped) {
            case "n":
              value += "\n";
              break;
            case "t":
              value += "\t";
              break;
            case "\\":
              value += "\\";
              break;
            default:
              value += escaped;
              break;
          }
          this.pos++;
        }
        continue;
      }
      if (ch === quote) {
        this.pos++;
        this.tokens.push({
          type: TokenType.STRING,
          value,
          position: start,
        });
        return;
      }
      value += ch;
      this.pos++;
    }
    throw new Error(
      `CypherLite: Unterminated string starting at position ${start}`,
    );
  }

  private readBacktickIdentifier(): void {
    const start = this.pos;
    this.pos++; // skip `
    let value = "";
    while (this.pos < this.input.length && this.input[this.pos] !== "`") {
      value += this.input[this.pos];
      this.pos++;
    }
    if (this.pos >= this.input.length) {
      throw new Error(
        `CypherLite: Unterminated backtick identifier at position ${start}`,
      );
    }
    this.pos++; // skip closing `
    this.tokens.push({ type: TokenType.IDENTIFIER, value, position: start });
  }

  private readNumber(): void {
    const start = this.pos;
    let value = "";
    let hasDot = false;
    while (this.pos < this.input.length) {
      const ch = this.input[this.pos];
      if (ch >= "0" && ch <= "9") {
        value += ch;
        this.pos++;
      } else if (ch === "." && !hasDot) {
        // Don't treat '..' as decimal — it's range syntax (e.g., *1..3)
        if (
          this.pos + 1 < this.input.length &&
          this.input[this.pos + 1] === "."
        ) {
          break;
        }
        hasDot = true;
        value += ch;
        this.pos++;
      } else {
        break;
      }
    }
    this.tokens.push({ type: TokenType.NUMBER, value, position: start });
  }

  private readParameter(): void {
    const start = this.pos;
    this.pos++; // skip $
    let name = "";
    while (
      this.pos < this.input.length &&
      this.isIdentChar(this.input[this.pos])
    ) {
      name += this.input[this.pos];
      this.pos++;
    }
    if (name.length === 0) {
      throw new Error(`CypherLite: Empty parameter name at position ${start}`);
    }
    this.tokens.push({
      type: TokenType.PARAMETER,
      value: name,
      position: start,
    });
  }

  private tryMultiChar(): boolean {
    const remaining = this.input.slice(this.pos);

    // ->
    if (remaining.startsWith("->")) {
      this.tokens.push({
        type: TokenType.ARROW_RIGHT,
        value: "->",
        position: this.pos,
      });
      this.pos += 2;
      return true;
    }

    // <-
    if (remaining.startsWith("<-")) {
      this.tokens.push({
        type: TokenType.ARROW_LEFT,
        value: "<-",
        position: this.pos,
      });
      this.pos += 2;
      return true;
    }

    // <> (not equal)
    if (remaining.startsWith("<>")) {
      this.tokens.push({
        type: TokenType.NEQ,
        value: "<>",
        position: this.pos,
      });
      this.pos += 2;
      return true;
    }

    // <=
    if (remaining.startsWith("<=")) {
      this.tokens.push({
        type: TokenType.LTE,
        value: "<=",
        position: this.pos,
      });
      this.pos += 2;
      return true;
    }

    // >=
    if (remaining.startsWith(">=")) {
      this.tokens.push({
        type: TokenType.GTE,
        value: ">=",
        position: this.pos,
      });
      this.pos += 2;
      return true;
    }

    // -- (undirected relationship dash; only when followed by ( or [)
    if (
      remaining.startsWith("--") &&
      this.pos + 2 < this.input.length &&
      (this.input[this.pos + 2] === "(" || this.input[this.pos + 2] === "[")
    ) {
      this.tokens.push({
        type: TokenType.DASH,
        value: "--",
        position: this.pos,
      });
      this.pos += 2;
      return true;
    }

    return false;
  }

  private trySingleChar(ch: string): boolean {
    const map: Record<string, TokenType> = {
      "(": TokenType.LPAREN,
      ")": TokenType.RPAREN,
      "[": TokenType.LBRACKET,
      "]": TokenType.RBRACKET,
      "{": TokenType.LBRACE,
      "}": TokenType.RBRACE,
      ":": TokenType.COLON,
      ".": TokenType.DOT,
      ",": TokenType.COMMA,
      "*": TokenType.STAR,
      "|": TokenType.PIPE,
      "=": TokenType.EQ,
      "<": TokenType.LT,
      ">": TokenType.GT,
      "+": TokenType.PLUS,
      "-": TokenType.MINUS,
    };

    const tt = map[ch];
    if (tt !== undefined) {
      this.tokens.push({ type: tt, value: ch, position: this.pos });
      this.pos++;
      return true;
    }
    return false;
  }

  private readIdentifier(): void {
    const start = this.pos;
    let value = "";
    while (
      this.pos < this.input.length &&
      this.isIdentChar(this.input[this.pos])
    ) {
      value += this.input[this.pos];
      this.pos++;
    }
    const upper = value.toUpperCase();
    const kwType = KEYWORDS[upper];
    if (kwType !== undefined) {
      this.tokens.push({ type: kwType, value: upper, position: start });
    } else {
      this.tokens.push({
        type: TokenType.IDENTIFIER,
        value,
        position: start,
      });
    }
  }

  private isIdentStart(ch: string): boolean {
    return /[a-zA-Z_]/.test(ch);
  }

  private isIdentChar(ch: string): boolean {
    return /[a-zA-Z0-9_]/.test(ch);
  }
}

/** Convenience function to tokenize a Cypher string. */
export function tokenize(cypher: string): Token[] {
  return new CypherLiteTokenizer(cypher).tokenize();
}
