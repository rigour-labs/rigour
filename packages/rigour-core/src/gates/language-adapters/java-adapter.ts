import type {
  LanguageAdapter,
  FunctionFact,
  ImportFact,
  ErrorHandlerFact,
  NamingPattern,
} from './types.js';
import { classifyCasing } from './types.js';

class JavaAdapter implements LanguageAdapter {
  readonly id = 'java';
  readonly name = 'Java/Kotlin';
  readonly extensions = ['.java', '.kt'];

  extractFunctions(source: string): FunctionFact[] {
    const lines = source.split('\n');
    const functions: FunctionFact[] = [];

    // Java: public/private/protected static? ReturnType methodName(
    const javaMethodRegex =
      /^\s*(public|private|protected)?\s*(static)?\s*(\w+)\s+(\w+)\s*\(/;

    // Kotlin: fun methodName( or suspend fun methodName(
    const kotlinFunRegex = /^\s*(suspend\s+)?fun\s+(\w+)\s*\(/;

    let i = 0;
    while (i < lines.length) {
      let match = lines[i].match(javaMethodRegex);
      let isKotlin = false;
      let isAsync = false;
      let methodName = '';

      if (!match) {
        match = lines[i].match(kotlinFunRegex);
        if (match) {
          isKotlin = true;
          isAsync = !!match[1];
          methodName = match[2];
        }
      } else {
        isAsync = false;
        methodName = match[4];
      }

      if (match && methodName) {
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

    // Java/Kotlin: import package.Class; or import package.*
    const importRegex = /^\s*import\s+([^;]+);/;

    lines.forEach((line, idx) => {
      const match = line.match(importRegex);
      if (match) {
        const fullModule = match[1].trim();

        // Check if wildcard import
        const isWildcard = fullModule.endsWith('.*');
        const module = isWildcard
          ? fullModule.slice(0, -2)
          : fullModule.split('.').slice(0, -1).join('.');

        const className = isWildcard
          ? '*'
          : fullModule.split('.').pop() || '';

        imports.push({
          module,
          names: className ? [className] : [],
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
        } else if (
          /System\.out\.(print|println)|Log\.(d|e|i|w)/.test(body)
        ) {
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

    // Extract camelCase methods
    const methodRegex =
      /\b(public|private|protected)?\s*(static)?\s*\w+\s+([a-z]\w*)\s*\(/g;
    let match;
    while ((match = methodRegex.exec(source)) !== null) {
      patterns.push({
        name: match[3],
        kind: 'method',
        convention: classifyCasing(match[3]),
      });
    }

    // Extract PascalCase class declarations
    const classRegex = /\b(class|interface)\s+([A-Z]\w+)/g;
    while ((match = classRegex.exec(source)) !== null) {
      patterns.push({
        name: match[2],
        kind: 'class',
        convention: classifyCasing(match[2]),
      });
    }

    // Extract camelCase variables
    const varRegex = /\b(private|protected)?\s*\w+\s+([a-z]\w+)\s*[=;]/g;
    while ((match = varRegex.exec(source)) !== null) {
      patterns.push({
        name: match[2],
        kind: 'variable',
        convention: classifyCasing(match[2]),
      });
    }

    // Extract SCREAMING_SNAKE constants
    const constRegex = /\bfinal\s+\w+\s+([A-Z][A-Z0-9_]*)\s*=/g;
    while ((match = constRegex.exec(source)) !== null) {
      patterns.push({
        name: match[1],
        kind: 'constant',
        convention: classifyCasing(match[1]),
      });
    }

    return patterns;
  }

  stripComments(source: string): string {
    // Remove // comments
    let result = source.replace(/\/\/.*$/gm, '');

    // Remove /* */ comments (handles multiline)
    result = result.replace(/\/\*[\s\S]*?\*\//g, '');

    // Kotlin: remove /** */ doc comments
    result = result.replace(/\/\*\*[\s\S]*?\*\//g, '');

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

    // Kotlin-specific
    const whenMatches = stripped.match(/\bwhen\s*\(/g) || [];
    const isMatches = stripped.match(/\bis\s+/g) || [];

    return (
      ifMatches.length +
      elseIfMatches.length +
      elseMatches.length +
      switchMatches.length +
      caseMatches.length +
      whenMatches.length +
      isMatches.length
    );
  }

  countReturns(source: string): number {
    const stripped = this.stripComments(source);
    const returnMatches = stripped.match(/\breturn\b/g) || [];
    return returnMatches.length;
  }
}

export const javaAdapter = new JavaAdapter();
