import { useMDXComponents as getNextraMDXComponents } from 'nextra-theme-docs'
import type { MDXComponents } from 'nextra/mdx-components'

export function useMDXComponents(components: MDXComponents): MDXComponents {
    return {
        ...getNextraMDXComponents(components)
    }
}
