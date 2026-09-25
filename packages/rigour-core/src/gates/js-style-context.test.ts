import { describe, expect, it } from 'vitest';
import { extractComparableJsNames } from './js-style-context.js';

describe('context-aware JS naming', () => {
    it('excludes exported Next route methods only inside app route files', () => {
        const code = `
            export async function GET() { return Response.json({}); }
            export const POST = async () => Response.json({});
            function GET_HELPER() { return 1; }
        `;
        expect(extractComparableJsNames(code, 'src/app/api/items/route.ts').map(item => item.name))
            .toEqual(['GET_HELPER']);
        expect(extractComparableJsNames(code, 'src/lib/route.ts').map(item => item.name))
            .toEqual(['GET', 'POST', 'GET_HELPER']);
    });

    it('excludes JSX-returning components but keeps ordinary PascalCase functions', () => {
        const code = `
            export function StepReview() { return <section />; }
            const WizardField = () => <input />;
            function ParseValue() { return 1; }
        `;
        expect(extractComparableJsNames(code, 'src/components/WizardField.tsx').map(item => item.name))
            .toEqual(['ParseValue']);
    });

    it('excludes module constants but keeps unconventional local variables', () => {
        const code = `
            const EMAIL_TEMPLATE = 'hello';
            function sendMessage() {
                const LOCAL_VALUE = 1;
                return LOCAL_VALUE;
            }
        `;
        expect(extractComparableJsNames(code, 'src/lib/template.ts').map(item => item.name))
            .toEqual(['sendMessage', 'LOCAL_VALUE']);
    });
});
