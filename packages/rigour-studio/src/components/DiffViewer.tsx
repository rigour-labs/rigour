import React, { useMemo } from 'react';
import { DiffEditor, Editor } from '@monaco-editor/react';
import { FileCode, X } from 'lucide-react';

interface DiffViewerProps {
    filename: string;
    originalCode: string;
    modifiedCode: string;
    onClose: () => void;
    theme?: 'dark' | 'light';
    violations?: Array<{
        line?: number;
        endLine?: number;
        title: string;
        details: string;
        id: string;
    }>;
}

const getLanguage = (filename: string): string => {
    const ext = filename.split('.').pop()?.toLowerCase();
    const map: Record<string, string> = {
        ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
        py: 'python', rb: 'ruby', rs: 'rust', go: 'go',
        json: 'json', yaml: 'yaml', yml: 'yaml', md: 'markdown',
        css: 'css', scss: 'scss', html: 'html', xml: 'xml',
        sql: 'sql', sh: 'shell', bash: 'shell', zsh: 'shell',
    };
    return map[ext || ''] || 'plaintext';
};

const MARKDOWN_EXTENSIONS = new Set(['md', 'mdx', 'markdown']);
const PLAINTEXT_EXTENSIONS = new Set(['txt', 'log', 'env']);

function isMarkdownFile(filename: string): boolean {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    return MARKDOWN_EXTENSIONS.has(ext);
}

function isPlaintextFile(filename: string): boolean {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    return PLAINTEXT_EXTENSIONS.has(ext);
}

/** Lightweight markdown → HTML (no external deps) */
function renderMarkdown(src: string): string {
    let html = src
        // Escape HTML entities
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        // Headings
        .replace(/^### (.+)$/gm, '<h3>$1</h3>')
        .replace(/^## (.+)$/gm, '<h2>$1</h2>')
        .replace(/^# (.+)$/gm, '<h1>$1</h1>')
        // Bold + italic
        .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        // Inline code
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        // Links
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
        // Horizontal rules
        .replace(/^---+$/gm, '<hr />')
        // Blockquotes
        .replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>')
        // Unordered lists
        .replace(/^[*-] (.+)$/gm, '<li>$1</li>')
        // Paragraphs (double newline)
        .replace(/\n\n/g, '</p><p>');

    // Wrap consecutive <li> in <ul>
    html = html.replace(/(<li>.*<\/li>(\n)?)+/g, (match) => `<ul>${match}</ul>`);

    // Code blocks (``` ... ```)
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) => {
        return `<pre><code>${code.trim()}</code></pre>`;
    });

    return `<p>${html}</p>`;
}

export const DiffViewer: React.FC<DiffViewerProps> = ({
    filename,
    originalCode,
    modifiedCode,
    onClose,
    theme = 'dark',
    violations = [],
}) => {
    const isDiff = originalCode !== modifiedCode;
    const language = getLanguage(filename);
    const monacoTheme = theme === 'dark' ? 'vs-dark' : 'light';
    const useMarkdownRenderer = isMarkdownFile(filename) && !isDiff;

    const markdownHtml = useMemo(() => {
        if (!useMarkdownRenderer) return '';
        return renderMarkdown(modifiedCode);
    }, [useMarkdownRenderer, modifiedCode]);

    // Configure Monaco decorations for violation highlighting
    const handleEditorDidMount = (editor: any) => {
        if (!violations.length || !editor) return;

        const monaco = (window as any).monaco;
        if (!monaco) return;

        const decorations = violations
            .filter(v => v.line)
            .map(v => ({
                range: new monaco.Range(v.line!, 1, v.endLine || v.line!, 1),
                options: {
                    isWholeLine: true,
                    className: 'violation-line-highlight',
                    glyphMarginClassName: 'violation-glyph',
                    glyphMarginHoverMessage: { value: `**[${v.id}] ${v.title}**\n\n${v.details}` },
                    overviewRuler: {
                        color: '#f87171',
                        position: monaco.editor.OverviewRulerLane.Full,
                    },
                },
            }));

        editor.deltaDecorations([], decorations);
    };

    return (
        <div className="diff-viewer-overlay">
            <div className="diff-viewer-window">
                <div className="diff-viewer-header">
                    <div className="title">
                        <FileCode size={18} />
                        <span>{filename}</span>
                        {isDiff && <span className="diff-badge">Modified</span>}
                        {violations.length > 0 && (
                            <span className="diff-badge" style={{
                                background: 'rgba(248, 113, 113, 0.12)',
                                color: '#f87171',
                                borderColor: 'rgba(248, 113, 113, 0.3)',
                            }}>
                                {violations.length} violation{violations.length !== 1 ? 's' : ''}
                            </span>
                        )}
                    </div>
                    <button onClick={onClose} className="close-btn">
                        <X size={20} />
                    </button>
                </div>

                {useMarkdownRenderer ? (
                    <div
                        className="markdown-viewer"
                        dangerouslySetInnerHTML={{ __html: markdownHtml }}
                    />
                ) : (
                    <div className="diff-editor-container">
                        {isDiff ? (
                            <DiffEditor
                                height="100%"
                                language={language}
                                original={originalCode}
                                modified={modifiedCode}
                                theme={monacoTheme}
                                options={{
                                    renderSideBySide: true,
                                    readOnly: true,
                                    minimap: { enabled: false },
                                    scrollBeyondLastLine: false,
                                    fontSize: 13,
                                }}
                            />
                        ) : (
                            <Editor
                                height="100%"
                                language={language}
                                value={modifiedCode}
                                theme={monacoTheme}
                                onMount={handleEditorDidMount}
                                options={{
                                    readOnly: true,
                                    minimap: { enabled: false },
                                    scrollBeyondLastLine: false,
                                    fontSize: 13,
                                    lineNumbers: 'on',
                                    glyphMargin: violations.length > 0,
                                }}
                            />
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};
