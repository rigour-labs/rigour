/**
 * Every rigour.yml setting, read from the schema itself (ConfigSchema in @rigour-labs/core): its
 * dotted path, its type and its default. The configuration reference is generated from this, so a
 * setting can never be documented with a default it does not have, or exist undocumented.
 */
import { ConfigSchema } from '@rigour-labs/core';

const inner = schema => {
    let s = schema;
    let fallback;
    for (;;) {
        const t = s._def.typeName;
        if (t === 'ZodDefault') {
            fallback ??= s._def.defaultValue();
            s = s._def.innerType;
        } else if (t === 'ZodOptional' || t === 'ZodNullable') s = s._def.innerType;
        else if (t === 'ZodEffects') s = s._def.schema;
        else return { schema: s, fallback };
    }
};

function typeOf(s) {
    const t = s._def.typeName;
    if (t === 'ZodString') return 'string';
    if (t === 'ZodNumber') return 'number';
    if (t === 'ZodBoolean') return 'boolean';
    if (t === 'ZodEnum') return s._def.values.map(v => JSON.stringify(v)).join(' | ');
    if (t === 'ZodLiteral') return JSON.stringify(s._def.value);
    if (t === 'ZodUnion') return s._def.options.map(o => typeOf(inner(o).schema)).join(' | ');
    if (t === 'ZodArray') return `list of ${typeOf(inner(s._def.type).schema)}`;
    if (t === 'ZodRecord') return `map of ${typeOf(inner(s._def.valueType).schema)}`;
    if (t === 'ZodObject') return 'object';
    return t.replace(/^Zod/, '').toLowerCase();
}

/** [{ path, type, default }] for every leaf; an object with keys is walked, a map or a list of objects is one entry. */
export function configKeys(schema = ConfigSchema, prefix = '') {
    const { schema: s } = inner(schema);
    const out = [];
    for (const [key, child] of Object.entries(s._def.shape())) {
        const path = prefix ? `${prefix}.${key}` : key;
        const { schema: c, fallback } = inner(child);
        if (c._def.typeName === 'ZodObject' && Object.keys(c._def.shape()).length) out.push(...configKeys(child, path));
        else out.push({ path, type: typeOf(c), default: fallback });
    }
    return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    for (const k of configKeys()) console.log(`${k.path}\t${k.type}\t${k.default === undefined ? '' : JSON.stringify(k.default)}`);
}
