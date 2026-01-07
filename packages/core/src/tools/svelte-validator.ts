/**
 * Svelte File Validator
 *
 * Uses svelte/compiler for AST parsing and syntax validation.
 * Validates Svelte component structure including script, style, and template blocks.
 */

// Declare svelte/compiler module for TypeScript
declare module 'svelte/compiler' {
  export function parse(content: string, options?: { filename?: string }): {
    instance: { attributes?: Array<{ name: string; value: unknown }> } | null;
    module: { attributes?: Array<{ name: string; value: unknown }> } | null;
    css: { attributes?: Array<{ name: string; value: unknown }> } | null;
  };
  export function compile(content: string, options?: {
    filename?: string;
    dev?: boolean;
    generate?: string;
    css?: string;
  }): {
    warnings: Array<{ start?: { line: number; column: number }; message: string; code?: string }>;
  };
}

// Svelte 4.x compiler types
interface SvelteCompileResult {
  warnings: Array<{ start?: { line: number; column: number }; message: string; code?: string }>;
}

interface SvelteAst {
  instance: { attributes?: Array<{ name: string; value: unknown }> } | null;
  module: { attributes?: Array<{ name: string; value: unknown }> } | null;
  css: { attributes?: Array<{ name: string; value: unknown }> } | null;
}

interface SvelteCompiler {
  parse: (content: string, options?: { filename?: string }) => SvelteAst;
  compile: (content: string, options?: { filename?: string; dev?: boolean; generate?: string; css?: string }) => SvelteCompileResult;
}

// Cached compiler instance
let svelteCompiler: SvelteCompiler | null = null;
let compilerLoadPromise: Promise<SvelteCompiler> | null = null;

async function loadSvelteCompiler(): Promise<SvelteCompiler> {
  if (svelteCompiler) return svelteCompiler;

  if (!compilerLoadPromise) {
    compilerLoadPromise = import('svelte/compiler').then((mod) => {
      svelteCompiler = mod as unknown as SvelteCompiler;
      return svelteCompiler;
    });
  }

  return compilerLoadPromise;
}

export interface SvelteValidationError {
  line: number;
  column: number;
  message: string;
  code?: string;
}

export interface SvelteValidationWarning {
  line: number;
  column: number;
  message: string;
  code?: string;
}

export interface SvelteMetadata {
  hasScript: boolean;
  hasModuleScript: boolean;
  hasStyle: boolean;
  scriptLang?: 'ts' | 'js';
  styleLang?: 'scss' | 'less' | 'css';
}

export interface SvelteValidationResult {
  valid: boolean;
  errors: SvelteValidationError[];
  warnings: SvelteValidationWarning[];
  metadata: SvelteMetadata;
}

/**
 * Detect script language from AST
 */
function detectScriptLang(ast: SvelteAst): 'ts' | 'js' | undefined {
  const instance = ast.instance;
  const module = ast.module;

  // Check lang attribute on script tags
  if (instance?.attributes) {
    const langAttr = instance.attributes.find(attr => attr.name === 'lang');
    if (langAttr) {
      const value = langAttr.value;
      if (Array.isArray(value) && (value[0] as { data?: string })?.data === 'ts') return 'ts';
      if (typeof value === 'string' && value === 'ts') return 'ts';
    }
  }

  if (module?.attributes) {
    const langAttr = module.attributes.find(attr => attr.name === 'lang');
    if (langAttr) {
      const value = langAttr.value;
      if (Array.isArray(value) && (value[0] as { data?: string })?.data === 'ts') return 'ts';
      if (typeof value === 'string' && value === 'ts') return 'ts';
    }
  }

  return instance || module ? 'js' : undefined;
}

/**
 * Detect style language from AST
 */
function detectStyleLang(ast: SvelteAst): 'scss' | 'less' | 'css' | undefined {
  const css = ast.css;
  if (!css) return undefined;

  if (css.attributes) {
    const langAttr = css.attributes.find(attr => attr.name === 'lang');
    if (langAttr) {
      const value = langAttr.value;
      if (Array.isArray(value)) {
        const data = (value[0] as { data?: string })?.data;
        if (data === 'scss') return 'scss';
        if (data === 'less') return 'less';
      }
    }
  }

  return 'css';
}

/**
 * Validate a Svelte file content (async version).
 *
 * @param content - The Svelte file content to validate
 * @param filename - The filename for error reporting
 * @returns Validation result with errors, warnings, and metadata
 */
export async function validateSvelteFileAsync(
  content: string,
  filename: string = 'Component.svelte'
): Promise<SvelteValidationResult> {
  const errors: SvelteValidationError[] = [];
  const warnings: SvelteValidationWarning[] = [];
  let metadata: SvelteMetadata = {
    hasScript: false,
    hasModuleScript: false,
    hasStyle: false,
  };

  try {
    const compiler = await loadSvelteCompiler();

    // Step 1: Parse the AST (catches syntax errors in template)
    const ast = compiler.parse(content, { filename });

    // Extract metadata from AST
    metadata = {
      hasScript: ast.instance !== null,
      hasModuleScript: ast.module !== null,
      hasStyle: ast.css !== null,
      scriptLang: detectScriptLang(ast),
      styleLang: detectStyleLang(ast),
    };

    // Step 2: Try to compile (catches additional errors)
    try {
      const compiled = compiler.compile(content, {
        filename,
        dev: true,
        generate: 'dom',
        css: 'injected',
      });

      // Collect warnings from compilation
      for (const warning of compiled.warnings) {
        warnings.push({
          line: warning.start?.line ?? 1,
          column: warning.start?.column ?? 0,
          message: warning.message,
          code: warning.code,
        });
      }
    } catch (compileError: unknown) {
      // Compilation error - still partially valid (parsed OK)
      const err = compileError as { start?: { line: number; column: number }; message: string; code?: string };
      errors.push({
        line: err.start?.line ?? 1,
        column: err.start?.column ?? 0,
        message: err.message,
        code: err.code,
      });
    }
  } catch (parseError: unknown) {
    // Parse error - completely invalid syntax
    const err = parseError as { start?: { line: number; column: number }; message: string; code?: string };
    errors.push({
      line: err.start?.line ?? 1,
      column: err.start?.column ?? 0,
      message: err.message,
      code: err.code,
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    metadata,
  };
}

/**
 * Validate a Svelte file content (sync version - uses cached compiler).
 * Falls back to basic validation if compiler not loaded.
 *
 * @param content - The Svelte file content to validate
 * @param filename - The filename for error reporting
 * @returns Validation result with errors, warnings, and metadata
 */
export function validateSvelteFile(
  content: string,
  filename: string = 'Component.svelte'
): SvelteValidationResult {
  const errors: SvelteValidationError[] = [];
  const warnings: SvelteValidationWarning[] = [];
  let metadata: SvelteMetadata = {
    hasScript: false,
    hasModuleScript: false,
    hasStyle: false,
  };

  // Try to use cached compiler (sync)
  if (!svelteCompiler) {
    // Compiler not loaded yet - do basic validation
    return basicSvelteValidation(content, filename);
  }

  try {
    // Step 1: Parse the AST
    const ast = svelteCompiler.parse(content, { filename });

    // Extract metadata from AST
    metadata = {
      hasScript: ast.instance !== null,
      hasModuleScript: ast.module !== null,
      hasStyle: ast.css !== null,
      scriptLang: detectScriptLang(ast),
      styleLang: detectStyleLang(ast),
    };

    // Step 2: Try to compile
    try {
      const compiled = svelteCompiler.compile(content, {
        filename,
        dev: true,
        generate: 'dom',
        css: 'injected',
      });

      for (const warning of compiled.warnings) {
        warnings.push({
          line: warning.start?.line ?? 1,
          column: warning.start?.column ?? 0,
          message: warning.message,
          code: warning.code,
        });
      }
    } catch (compileError: unknown) {
      const err = compileError as { start?: { line: number; column: number }; message: string; code?: string };
      errors.push({
        line: err.start?.line ?? 1,
        column: err.start?.column ?? 0,
        message: err.message,
        code: err.code,
      });
    }
  } catch (parseError: unknown) {
    const err = parseError as { start?: { line: number; column: number }; message: string; code?: string };
    errors.push({
      line: err.start?.line ?? 1,
      column: err.start?.column ?? 0,
      message: err.message,
      code: err.code,
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    metadata,
  };
}

/**
 * Basic Svelte validation without compiler (bracket matching, etc.)
 */
function basicSvelteValidation(content: string, filename: string): SvelteValidationResult {
  const errors: SvelteValidationError[] = [];
  const lines = content.split('\n');

  // Check for unclosed tags
  const tagStack: Array<{ tag: string; line: number }> = [];
  const selfClosingTags = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'area', 'base', 'col', 'embed', 'param', 'source', 'track', 'wbr']);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match opening tags
    const openMatches = line.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)[^>]*(?<!\/)>/g);
    for (const match of openMatches) {
      const tag = match[1].toLowerCase();
      if (!selfClosingTags.has(tag)) {
        tagStack.push({ tag, line: i + 1 });
      }
    }

    // Match closing tags
    const closeMatches = line.matchAll(/<\/([a-zA-Z][a-zA-Z0-9]*)>/g);
    for (const match of closeMatches) {
      const tag = match[1].toLowerCase();
      const last = tagStack.pop();
      if (!last) {
        errors.push({
          line: i + 1,
          column: 0,
          message: `Unexpected closing tag </${tag}>`,
        });
      } else if (last.tag !== tag) {
        errors.push({
          line: i + 1,
          column: 0,
          message: `Mismatched tags: expected </${last.tag}> but found </${tag}>`,
        });
      }
    }
  }

  // Report unclosed tags
  for (const unclosed of tagStack) {
    errors.push({
      line: unclosed.line,
      column: 0,
      message: `Unclosed tag <${unclosed.tag}>`,
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings: [],
    metadata: {
      hasScript: content.includes('<script'),
      hasModuleScript: content.includes('context="module"'),
      hasStyle: content.includes('<style'),
    },
  };
}

/**
 * Format validation errors as a human-readable string.
 *
 * @param result - The validation result
 * @param filename - The filename for display
 * @returns Formatted error string
 */
export function formatValidationErrors(
  result: SvelteValidationResult,
  filename: string
): string {
  if (result.valid && result.warnings.length === 0) {
    return `✓ ${filename}: No errors`;
  }

  const lines: string[] = [];

  if (!result.valid) {
    lines.push(`✗ ${filename}: ${result.errors.length} error(s)`);
    for (const error of result.errors) {
      lines.push(`  Line ${error.line}:${error.column}: ${error.message}`);
    }
  }

  if (result.warnings.length > 0) {
    lines.push(`⚠ ${filename}: ${result.warnings.length} warning(s)`);
    for (const warning of result.warnings) {
      lines.push(`  Line ${warning.line}:${warning.column}: ${warning.message}`);
    }
  }

  return lines.join('\n');
}

/**
 * Quick syntax check - returns array of error messages.
 * Used by tool-executor for validateSyntax integration.
 *
 * This is a sync function that tries to use the cached compiler.
 * If the compiler is not loaded, it will trigger an async load for next time.
 *
 * @param content - The Svelte file content
 * @param filename - The filename
 * @returns Array of error messages (empty if valid)
 */
export function quickSvelteCheck(content: string, filename: string): string[] {
  // Try sync validation first (if compiler is cached)
  const result = validateSvelteFile(content, filename);

  // If compiler wasn't loaded, trigger async load for next time
  if (!svelteCompiler) {
    loadSvelteCompiler().catch(() => {
      // Ignore load errors - will use basic validation
    });
  }

  if (result.valid) {
    return [];
  }

  return result.errors.map(
    (e) => `Line ${e.line}: ${e.message}`
  );
}
