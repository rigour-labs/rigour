import { describe, expect, it } from 'vitest';
import { repositoryAllowed, withheldReason } from './team-scope.js';

const scope = { organizationId: 'acme', repositories: ['github.com/acme/*', 'https://GitLab.com/Acme/api'] };

describe('team scope', () => {
    it('sends lessons only from the repositories the team lists', () => {
        expect(repositoryAllowed('https://github.com/acme/web', scope)).toBe(true);
        expect(repositoryAllowed('https://gitlab.com/acme/api', scope)).toBe(true);
        expect(repositoryAllowed('https://gitlab.com/acme/api-internal', scope)).toBe(false);
        expect(repositoryAllowed('https://github.com/other-org/web', scope)).toBe(false);
        expect(repositoryAllowed('https://github.com/acme-evil/web', scope)).toBe(false);
    });

    it('sends nothing when the team lists no repositories', () => {
        expect(repositoryAllowed('https://github.com/acme/web', { organizationId: 'acme' })).toBe(false);
    });

    it('keeps personal lessons and unknown repositories on the machine, and says why', () => {
        expect(withheldReason('personal', 'https://github.com/acme/web', scope)).toBe('personal lesson');
        expect(withheldReason('personal', 'https://github.com/acme/web', { ...scope, syncPersonal: true })).toBeNull();
        expect(withheldReason('team', undefined, scope)).toBe('repository unknown on this machine');
        expect(withheldReason('team', 'https://github.com/other-org/web', scope)).toContain('github.com/other-org/web');
        expect(withheldReason('team', 'https://github.com/acme/web', scope)).toBeNull();
    });
});
