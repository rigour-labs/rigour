import React, { useState } from 'react';
import { Lock, X } from 'lucide-react';

const HIDDEN_KEY = 'rigour-readonly-note-hidden';

/**
 * Why this tab can't change anything, and the one way to fix it: the link `rigour studio` prints (and opens)
 * carries this run's edit key, so opening that link is all it takes. Hidden for the tab once dismissed.
 */
export function ReadOnlyNote() {
    const [hidden, setHidden] = useState(() => { try { return sessionStorage.getItem(HIDDEN_KEY) === '1'; } catch { return false; } });
    if (hidden) return null;
    const hide = () => { try { sessionStorage.setItem(HIDDEN_KEY, '1'); } catch { /* not remembered */ } setHidden(true); };
    return (
        <div className="overview-banner readonly-note" role="note">
            <Lock size={16} />
            <span>Read-only. Open the link <code>rigour studio</code> printed in your terminal: it gives this tab edit rights.</span>
            <button className="readonly-note-close" onClick={hide} type="button" aria-label="Hide this note"><X size={14} /></button>
        </div>
    );
}
