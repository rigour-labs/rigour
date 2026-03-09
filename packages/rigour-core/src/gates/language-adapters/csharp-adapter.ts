import type {
  LanguageAdapter,
  FunctionFact,
  ImportFact,
  ErrorHandlerFact,
  NamingPattern,
} from './types.js';
import { classifyCasing } from './types.js';

class CSharpAdapter implements LanguageAdapter {
  readonly id = 'csharp';
  readonly name = 'C#';
  readonly extensions = ['.cs'];

  extractFunctions(source: string): FunctionFact[] {
    const lines = source.split('\n');
    const functions: FunctionFact[] = [];

    // Match: public/private/protected/internal static? async? ReturnType MethodName(
    const methodRegex =
      /^\s*(public|private|protected|internal)?\s*(static)?\s*(async)?\s*(\w+)\s+(\w+)\s*\(/;

    let i = 0;
    while (i < lines.length) {
      const match = lines[i].match(methodRegex);
      if (match) {
        const isAsync = !!match[3];
        const returnType = match[4];
        const methodName = match[5];
        const startLine = i + 1;

        // Find closing brace
        let braceCount = 0;
        let foundOpening = false;
        let j = i;
        let body = '';

        while (j < lines.length) {
          const line = lines[j];
          for (let k = 0; k < line.length; k++) {
            if (line[k] === '{') {
              braceCount++;
              foundOpening = true;
            } else if (line[k] === '}') {
              braceCount--;
            }
          }
          body += line + '\n';
          if (foundOpening && braceCount === 0) break;
          j++;
        }

        functions.push({
          name: methodName,
          startLine,
          endLine: j + 1,
          body: body.trim(),
          isAsync,
          isExported: lines[i].includes('public'),
        });

        i = j + 1;
      } else {
        i++;
      }
    }

    return functions;
  }

  extractImports(source: string): ImportFact[] {
    const imports: ImportFact[] = [];
    const lines = source.split('\n');

    // Match: using Namespace; or using static Namespace;
    const usingRegex = /^\s*using\s+(static\s+)?([^;]+);/;

    lines.forEach((line, idx) => {
      const match = line.match(usingRegex);
      if (match) {
        const module = match[2].trim();
        imports.push({
          module,
          names: [],
          line: idx + 1,
          isDynamic: false,
        });
      }
    });

    return imports;
  }

  extractErrorHandlers(source: string): ErrorHandlerFact[] {
    const handlers: ErrorHandlerFact[] = [];
    const lines = source.split('\n');

    // Match: catch (ExceptionType e) {
    const catchRegex = /catch\s*\(\s*(\w+)\s+\w+\s*\)\s*{/;

    let i = 0;
    while (i < lines.length) {
      const match = lines[i].match(catchRegex);
      if (match) {
        const exceptionType = match[1];
        const startLine = i + 1;

        // Extract catch block
        let braceCount = 0;
        let foundOpening = false;
        let j = i;
        let body = '';

        while (j < lines.length) {
          const line = lines[j];
          for (let k = 0; k < line.length; k++) {
            if (line[k] === '{') {
              braceCount++;
              foundOpening = true;
            } else if (line[k] === '}') {
              braceCount--;
            }
          }
          body += line + '\n';
          if (foundOpening && braceCount === 0) break;
          j++;
        }

        // Classify strategy
        let strategy = 'swallow';
        if (/\bthrow\s*;/.test(body)) {
          strategy = 'rethrow';
        } else if (/\bthrow\s+new\s+/.test(body)) {
          strategy = 'wrap';
        } else if (/Console\.(Write|WriteLine)/.test(body)) {
          strategy = 'log';
        }

        handlers.push({
          type: 'try-catch',
          strategy,
          startLine,
          body: body.trim(),
        });

        i = j + 1;
      } else {
        i++;
      }
    }

    return handlers;
  }

  extractNamingPatterns(source: string): NamingPattern[] {
    const patterns: NamingPattern[] = [];

    // Extract PascalCase methods
    const methodRegex =
      /\b(public|private|protected|internal)?\s*(static)?\s*\w+\s+([A-Z]\w+)\s*\(/g;
    let match;
    while ((match = methodRegex.exec(source)) !== null) {
      patterns.push({
        name: match[3],
        kind: 'method',
        convention: classifyCasing(match[3]),
      });
    }

    // Extract PascalCase class declarations
    const classRegex = /\bclass\s+([A-Z]\w+)/g;
    while ((match = classRegex.exec(source)) !== null) {
      patterns.push({
        name: match[1],
        kind: 'class',
        convention: classifyCasing(match[1]),
      });
    }

    // Extract _camelCase private fields
    const fieldRegex = /\b(_[a-z]\w+)\s*[=;]/g;
    while ((match = fieldRegex.exec(source)) !== null) {
      patterns.push({
        name: match[1],
        kind: 'variable',
        convention: classifyCasing(match[1]),
      });
    }

    // Extract SCREAMING_SNAKE constants
    const constRegex = /\b(const\s+)?([A-Z][A-Z0-9_]*)\s*=/g;
    while ((match = constRegex.exec(source)) !== null) {
      const name = match[2];
      if (/^[A-Z][A-Z0-9_]+$/.test(name)) {
        patterns.push({
          name,
          kind: 'constant',
          convention: classifyCasing(name),
        });
      }
    }

    return patterns;
  }

  stripComments(source: string): string {
    // Remove // comments
    let result = source.replace(/\/\/.*$/gm, '');

    // Remove /* */ comments (handles multiline)
    result = result.replace(/\/\*[\s\S]*?\*\//g, '');

    return result;
  }

  extractComparisonOps(source: string): string[] {
    const ops = new Set<string>();
    const opsRegex = /(>=|<=|==|!=|>|<)/g;

    let match;
    while ((match = opsRegex.exec(source)) !== null) {
      ops.add(match[1]);
    }

    return Array.from(ops);
  }

  countBranches(source: string): number {
    const stripped = this.stripComments(source);
    const ifMatches = stripped.match(/\bif\s*\(/g) || [];
    const elseIfMatches = stripped.match(/\belse\s+if\s*\(/g) || [];
    const elseMatches = stripped.match(/\belse\s*{/g) || [];
    const switchMatches = stripped.match(/\bswitch\s*\(/g) || [];
    const caseMatches = stripped.match(/\bcase\s+/g) || [];

    return (
      ifMatches.length +
      elseIfMatches.length +
      elseMatches.length +
      switchMatches.length +
      caseMatches.length
    );
  }

  countReturns(source: string): number {
    const stripped = this.stripComments(source);
    const returnMatches = stripped.match(/\breturn\b/g) || [];
    return returnMatches.length;
  }
}

export const csharpAdapter = new CSharpAdapter();
