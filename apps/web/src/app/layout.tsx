import type { ReactNode } from 'react';
import { Fraunces, Inter } from 'next/font/google';
import './globals.css';

// `next/font/google` en vez de un <link> directo a Google Fonts (dictamen de ux-designer, PR4): evita
// una request bloqueante en código de producción -- el Artifact aprobado usaba el <link> porque es una
// demo estática, acá no aplica.
const fraunces = Fraunces({ subsets: ['latin'], variable: '--font-fraunces' });
const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });

export const metadata = {
  title: 'Sistema Contable',
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="es" className={`${fraunces.variable} ${inter.variable}`}>
      <body>{children}</body>
    </html>
  );
}
