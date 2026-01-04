import { Footer, Layout, Navbar } from 'nextra-theme-docs'
import { Head } from 'nextra/components'
import { getPageMap } from 'nextra/page-map'
import React from 'react'
import 'nextra-theme-docs/style.css'

export default async function RootLayout({ children }: { children: React.ReactNode }) {
    const pageMap = await getPageMap()

    const logo = (
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <img src="/logo.jpg" alt="Rigour Logo" style={{ width: '24px', height: '24px', borderRadius: '4px' }} />
            <span style={{ fontWeight: 800, fontSize: '1.2rem', letterSpacing: '-0.5px' }}>
                RIGOUR
            </span>
        </div>
    )

    return (
        <html lang="en" dir="ltr" suppressHydrationWarning>
            <Head />
            <body className="antialiased">
                <Layout
                    navbar={<Navbar logo={logo} projectLink="https://github.com/rigour-labs/rigour" />}
                    footer={
                        <Footer>
                            <div style={{ textAlign: 'center', width: '100%' }}>
                                {new Date().getFullYear()} ©{' '}
                                <a href="https://rigour.run" target="_blank" rel="noopener" style={{ fontWeight: 600 }}>
                                    Rigour Labs
                                </a>
                                . A Rigour Labs Project.
                            </div>
                        </Footer>
                    }
                    pageMap={pageMap}
                >
                    {children}
                </Layout>
            </body>
        </html>
    )
}
