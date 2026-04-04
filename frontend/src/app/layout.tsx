import type { Metadata } from 'next';
import { JetBrains_Mono } from 'next/font/google';
import './globals.css';

const mono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
});

export const metadata: Metadata = {
  title: 'Dawn Vault Dashboard',
  description: 'Internal dashboard for base-first vault operations and conditional DN activation',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className={`${mono.variable} font-mono bg-vault-bg text-vault-text antialiased`}>
        {children}
      </body>
    </html>
  );
}
