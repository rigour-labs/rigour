import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FixCommand, TabPanel, Tabs } from './ui';

const html = (node: React.ReactElement) => renderToStaticMarkup(node);

describe('Tabs', () => {
    it('ties each tab to its panel, and keeps only the open tab in the Tab order', () => {
        const tabs = [{ id: 'a', label: 'First' }, { id: 'b', label: 'Second' }];
        const out = html(<><Tabs id="t" tabs={tabs} active="b" onChange={() => undefined} /><TabPanel id="t" active="b">body</TabPanel></>);
        expect(out).toContain('id="t-tab-a" aria-controls="t-panel" aria-selected="false" tabindex="-1"');
        expect(out).toContain('id="t-tab-b" aria-controls="t-panel" aria-selected="true" tabindex="0"');
        expect(out).toContain('role="tabpanel" id="t-panel" aria-labelledby="t-tab-b"');
    });
});

describe('a fix command', () => {
    const decode = (text: string) => text.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
    const title = (command: string) => decode(/<code class="ui-fix-code" title="([^"]*)"/.exec(html(<FixCommand command={command} />))?.[1] ?? '');

    it('shows the home folder as ~ wherever a path starts', () => {
        expect(title('node /Users/dev-a/work/mcp.js')).toBe('node ~/work/mcp.js');
        expect(title('cd /home/dev-b && make')).toBe('cd ~ && make');
        expect(title('node "/Users/dev-a/my tools/x.js"')).toBe('node "~/my tools/x.js"');
        expect(title('PATH=/Users/dev-a/bin:/home/dev-b/.local/bin:/usr/bin')).toBe('PATH=~/bin:~/.local/bin:/usr/bin');
        expect(title('node C:\\Users\\Bob Smith\\x.js')).toBe('node ~\\x.js');
        expect(title('node "C:/Users/Bob Smith/x.js"')).toBe('node "~/x.js"');
        expect(title('set PATH=C:\\Users\\dev-a\\bin;C:\\Users\\dev-b\\tools')).toBe('set PATH=~\\bin;~\\tools');
    });

    it('leaves shared folders and other paths as they are', () => {
        expect(title('ls /Users/Shared/acme')).toBe('ls /Users/Shared/acme');
        expect(title('dir C:\\Users\\Public\\acme')).toBe('dir C:\\Users\\Public\\acme');
        expect(title('rigour setup')).toBe('rigour setup');
        expect(title('cat /opt/home/dev-a/x')).toBe('cat /opt/home/dev-a/x');
    });
});
