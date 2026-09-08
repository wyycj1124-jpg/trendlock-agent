import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const siteUrl = 'https://trendlock-agent.jacksonning.chatgpt.site';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: 'TrendLock Agent · 趋势锁盈智能体',
  description: '基于 Binance Agent OS 的U本位合约机会扫描、硬风控与阶梯止损演示。',
  openGraph: {
    title: 'TrendLock Agent · 趋势锁盈智能体',
    description: '趋势识别 · 硬风控 · 阶梯止损。Binance Agent OS 黑客松原型。',
    type: 'website',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'TrendLock 趋势锁盈智能体' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'TrendLock Agent · 趋势锁盈智能体',
    description: '趋势识别 · 硬风控 · 阶梯止损。',
    images: ['/og.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className="dark">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
