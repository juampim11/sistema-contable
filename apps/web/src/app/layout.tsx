import type { ReactNode } from 'react';

export const metadata = {
  title: 'Sistema Contable',
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
