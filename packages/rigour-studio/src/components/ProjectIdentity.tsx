import React from 'react';
import { Folder } from 'lucide-react';

/** The header's repository name and branch: nothing else, so a screenshot never carries a path or a package version. */
export function ProjectIdentity({ name, branch }: { name?: string; branch?: string | null }) {
    return (
        <div className="project-identity">
            <Folder size={14} className="folder-icon" />
            <span className="project-name">{name}</span>
            {branch && <span className="project-version-pill" title="Current branch">{branch}</span>}
        </div>
    );
}
