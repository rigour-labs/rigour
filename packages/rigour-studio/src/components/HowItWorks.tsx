import React from 'react';
import './story.css';

/**
 * The home page's three steps, as Rigour actually works: per-edit checks only in the agents it has hooks for
 * (hooks.ts: Claude Code, Cursor, Cline, Windsurf), every agent at push, and lessons only with learning on.
 */
export const HowItWorks: React.FC<{ onHide: () => void }> = ({ onHide }) => (
    <section className="st-card" style={{ marginBottom: 28 }}>
        <div className="st-row" style={{ justifyContent: 'space-between', marginBottom: 16 }}>
            <strong>How Rigour works</strong>
            <button className="st-btn" onClick={onHide} type="button">Got it</button>
        </div>
        <div className="st-steps">
            <div className="st-step"><span className="st-num">1</span><div>Your agent writes code<div className="st-sub">Claude Code, Cursor, Cline or Windsurf are checked as they edit; any agent at push.</div></div></div>
            <div className="st-step"><span className="st-num">2</span><div>Rigour checks the change<div className="st-sub">It stops the agent only on problems it can prove.</div></div></div>
            <div className="st-step"><span className="st-num">3</span><div>Your PR arrives clean<div className="st-sub">A short review catches the rest; with learning on, fixes become lessons.</div></div></div>
        </div>
    </section>
);
