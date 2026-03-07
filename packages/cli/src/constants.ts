/**
 * CLI Constants
 * 
 * Canonical path and naming conventions for IntentWeave CLI.
 * 
 * Path Convention:
 * - `.iw/` is the canonical workspace directory name
 * - NOT `.cg/` or `.intentweave/`
 */

/**
 * Root directory name for IntentWeave workspace files.
 * This is the single source of truth for the workspace directory name.
 */
export const IW_DIR = '.iw';

/**
 * Standard paths within the .iw directory
 */
export const IW_PATHS = {
  /** Root workspace directory */
  root: IW_DIR,
  
  /** Workspace configuration file */
  config: `${IW_DIR}/config.json`,
  
  /** Workspace manifest (new format) */
  workspace: `${IW_DIR}/workspace.json`,
  
  /** Curated entities and statements */
  curated: `${IW_DIR}/curated`,
  curatedEntities: `${IW_DIR}/curated/entities.json`,
  curatedStatements: `${IW_DIR}/curated/statements.json`,
  
  /** Staging area for pending changes */
  staging: `${IW_DIR}/staging`,
  
  /** Run history */
  runs: `${IW_DIR}/runs`,
  
  /** Known aliases */
  aliases: `${IW_DIR}/aliases.json`,
} as const;

/**
 * Get the absolute path for a workspace path
 */
export function getIwPath(
  basePath: string,
  relativePath: keyof typeof IW_PATHS | string
): string {
  const rel = typeof relativePath === 'string' && relativePath in IW_PATHS
    ? IW_PATHS[relativePath as keyof typeof IW_PATHS]
    : relativePath;
  return `${basePath}/${rel}`;
}

/**
 * CLI command name - the canonical executable name
 */
export const CLI_NAME = 'iw';

/**
 * Product display name
 */
export const PRODUCT_NAME = 'IntentWeave';
