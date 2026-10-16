import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TabPanel, Tabs } from './ui';

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
